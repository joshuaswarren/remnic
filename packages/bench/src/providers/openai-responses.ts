/**
 * OpenAI Responses API provider dedicated to benchmark judging.
 *
 * This intentionally sits beside openai-compatible.ts. The latter targets
 * Chat Completions-compatible third-party servers and must remain unchanged.
 */

import type {
  BenchJudge,
  BenchJudgeResult,
  MemCorrectJudgeRequest,
  MemCorrectJudgeResult,
} from "../adapters/types.js";
import {
  GENERAL_ANSWER_JUDGE_RUBRIC,
  MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC,
  MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC_VERSION,
  MEMCORRECT_STALE_HARM_RUBRIC,
  MEMCORRECT_STALE_HARM_RUBRIC_VERSION,
  OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION,
} from "../judges/memcorrect-rubrics.js";
import type {
  CompletionOpts,
  CompletionResult,
  LlmProvider,
  OpenAiCompatibleProviderConfig,
  TokenUsage,
} from "./types.js";
import { RetryFetchHttpError, retryFetch } from "./retry-fetch.js";

export const DEFAULT_OPENAI_RESPONSES_JUDGE_MODEL = "gpt-5.6";

export type OpenAiResponsesJudgeErrorCode =
  | "api_error"
  | "rate_limited"
  | "refusal"
  | "malformed_response"
  | "malformed_verdict"
  | "incomplete_response"
  | "transport_error"
  | "aborted";

export interface OpenAiResponsesJudgeTelemetry {
  model: string;
  rubricVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  errorCode?: OpenAiResponsesJudgeErrorCode;
  httpStatus?: number;
}

export interface OpenAiResponsesVerdict {
  score: number;
  decision: "pass" | "partial" | "fail";
  reason: string;
}

export type OpenAiResponsesVerdictResult =
  | {
      ok: true;
      verdict: OpenAiResponsesVerdict;
      telemetry: OpenAiResponsesJudgeTelemetry;
    }
  | {
      ok: false;
      error: {
        code: OpenAiResponsesJudgeErrorCode;
        message: string;
        retryable: boolean;
        httpStatus?: number;
      };
      telemetry: OpenAiResponsesJudgeTelemetry;
    };

export interface OpenAiResponsesProviderConfig
  extends Omit<OpenAiCompatibleProviderConfig, "provider" | "model"> {
  provider?: "openai";
  model?: string;
  rubricVersion?: string;
}

interface ResponsesPayload {
  model?: string;
  status?: "completed" | "failed" | "incomplete" | "cancelled" | "queued" | "in_progress";
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  output?: Array<{
    type?: string;
    content?: Array<
      | { type?: "output_text"; text?: string }
      | { type?: "refusal"; refusal?: string }
    >;
  }>;
}

interface VerdictRequest {
  rubric: string;
  rubricVersion: string;
  input: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

const VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "decision", "reason"],
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
    decision: { type: "string", enum: ["pass", "partial", "fail"] },
    reason: { type: "string" },
  },
} as const;

const ASSISTANT_RUBRIC_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["identity_accuracy", "stance_coherence", "novelty", "calibration", "notes"],
  properties: {
    identity_accuracy: { type: "number", minimum: 0, maximum: 5 },
    stance_coherence: { type: "number", minimum: 0, maximum: 5 },
    novelty: { type: "number", minimum: 0, maximum: 5 },
    calibration: { type: "number", minimum: 0, maximum: 5 },
    notes: { type: "string" },
  },
} as const;

export class OpenAiResponsesJudgeError extends Error {
  readonly code: OpenAiResponsesJudgeErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly telemetry: OpenAiResponsesJudgeTelemetry;

  constructor(failure: Extract<OpenAiResponsesVerdictResult, { ok: false }>) {
    super(failure.error.message);
    this.name = "OpenAiResponsesJudgeError";
    this.code = failure.error.code;
    this.retryable = failure.error.retryable;
    this.httpStatus = failure.error.httpStatus;
    this.telemetry = failure.telemetry;
  }
}

export class OpenAiResponsesProvider implements LlmProvider {
  readonly provider = "openai" as const;
  readonly id: string;
  readonly name: string;
  readonly rubricVersion: string;

  private readonly config: OpenAiResponsesProviderConfig & { model: string };
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private readonly telemetryEvents: OpenAiResponsesJudgeTelemetry[] = [];

  constructor(config: OpenAiResponsesProviderConfig = {}) {
    const model = normalizeModel(config.model);
    this.config = { ...config, model };
    this.id = `openai-responses:${model}`;
    this.name = model;
    this.rubricVersion = config.rubricVersion ?? OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION;
  }

  async complete(prompt: string, opts: CompletionOpts = {}): Promise<CompletionResult> {
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await retryFetch(
        this.responsesUrl(),
        {
          method: "POST",
          headers: this.headers(opts.headers),
          signal: opts.signal,
          body: JSON.stringify({
            model: this.config.model,
            ...(opts.systemPrompt ? { instructions: opts.systemPrompt } : {}),
            input: prompt,
            ...(opts.maxTokens !== undefined ? { max_output_tokens: opts.maxTokens } : {}),
            store: false,
          }),
        },
        this.config.retryOptions,
      );
    } catch (error) {
      throw this.asTransportError(error, startedAt, this.rubricVersion);
    }

    const parsed = await this.parseResponse(response, startedAt, this.rubricVersion);
    this.recordUsage(parsed.telemetry.inputTokens, parsed.telemetry.outputTokens);
    if (!parsed.ok) {
      this.recordTelemetry(parsed.telemetry);
      throw new OpenAiResponsesJudgeError(parsed);
    }
    const text = parsed.text;
    if (text === null) {
      const failure = this.failure(
        "malformed_response",
        "OpenAI Responses API returned no text output.",
        startedAt,
        {
          response,
          payload: parsed.payload,
          rubricVersion: this.rubricVersion,
        },
      );
      this.recordTelemetry(failure.telemetry);
      throw new OpenAiResponsesJudgeError(failure);
    }
    this.recordTelemetry(parsed.telemetry);
    return {
      text,
      tokens: {
        input: parsed.telemetry.inputTokens,
        output: parsed.telemetry.outputTokens,
      },
      latencyMs: parsed.telemetry.latencyMs,
      model: parsed.telemetry.model,
    };
  }

  async judge(request: VerdictRequest): Promise<OpenAiResponsesVerdictResult> {
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await retryFetch(
        this.responsesUrl(),
        {
          method: "POST",
          headers: this.headers(),
          signal: request.signal,
          body: JSON.stringify({
            model: this.config.model,
            instructions: request.rubric,
            input: request.input,
            text: {
              format: {
                type: "json_schema",
                name: "benchmark_verdict",
                description: "A normalized benchmark grading verdict.",
                strict: true,
                schema: VERDICT_JSON_SCHEMA,
              },
            },
            max_output_tokens: request.maxTokens ?? 256,
            store: false,
          }),
        },
        this.config.retryOptions,
      );
    } catch (error) {
      const failure = this.transportFailure(error, startedAt, request.rubricVersion);
      this.recordTelemetry(failure.telemetry);
      return failure;
    }

    const parsed = await this.parseResponse(response, startedAt, request.rubricVersion);
    this.recordUsage(parsed.telemetry.inputTokens, parsed.telemetry.outputTokens);
    if (!parsed.ok) {
      this.recordTelemetry(parsed.telemetry);
      return parsed;
    }
    if (parsed.text === null) {
      const failure = this.failure(
        "malformed_response",
        "OpenAI Responses API returned no structured verdict text.",
        startedAt,
        { response, payload: parsed.payload, rubricVersion: request.rubricVersion },
      );
      this.recordTelemetry(failure.telemetry);
      return failure;
    }

    const verdict = parseVerdict(parsed.text);
    if (!verdict) {
      const failure = this.failure(
        "malformed_verdict",
        "OpenAI Responses API returned a verdict that failed schema validation.",
        startedAt,
        { response, payload: parsed.payload, rubricVersion: request.rubricVersion },
      );
      this.recordTelemetry(failure.telemetry);
      return failure;
    }

    this.recordTelemetry(parsed.telemetry);
    return { ok: true, verdict, telemetry: parsed.telemetry };
  }

  async evaluateAssistantRubric(request: {
    system: string;
    user: string;
    rubricId: string;
  }): Promise<string> {
    const rubricVersion = `sealed:${request.rubricId}`;
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await retryFetch(
        this.responsesUrl(),
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: this.config.model,
            instructions: request.system,
            input: request.user,
            text: {
              format: {
                type: "json_schema",
                name: "sealed_assistant_rubric",
                description: "Scores for every sealed assistant-rubric dimension.",
                strict: true,
                schema: ASSISTANT_RUBRIC_JSON_SCHEMA,
              },
            },
            max_output_tokens: 512,
            store: false,
          }),
        },
        this.config.retryOptions,
      );
    } catch (error) {
      throw this.asTransportError(error, startedAt, rubricVersion);
    }

    const parsed = await this.parseResponse(response, startedAt, rubricVersion);
    this.recordUsage(parsed.telemetry.inputTokens, parsed.telemetry.outputTokens);
    if (!parsed.ok) {
      this.recordTelemetry(parsed.telemetry);
      throw new OpenAiResponsesJudgeError(parsed);
    }
    if (parsed.text === null || !parseAssistantRubric(parsed.text)) {
      const failure = this.failure(
        "malformed_verdict",
        "OpenAI Responses API returned an invalid sealed assistant-rubric verdict.",
        startedAt,
        { response, payload: parsed.payload, rubricVersion },
      );
      this.recordTelemetry(failure.telemetry);
      throw new OpenAiResponsesJudgeError(failure);
    }
    this.recordTelemetry(parsed.telemetry);
    return parsed.text;
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  resetUsage(): void {
    this.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  getTelemetryEvents(): OpenAiResponsesJudgeTelemetry[] {
    return this.telemetryEvents.map((event) => ({ ...event }));
  }

  private async parseResponse(
    response: Response,
    startedAt: number,
    rubricVersion: string,
  ): Promise<
    | { ok: true; payload: ResponsesPayload; text: string | null; telemetry: OpenAiResponsesJudgeTelemetry }
    | Extract<OpenAiResponsesVerdictResult, { ok: false }>
  > {
    let payload: ResponsesPayload;
    try {
      payload = (await response.json()) as ResponsesPayload;
    } catch {
      if (!response.ok) {
        return this.failure(
          response.status === 429 ? "rate_limited" : "api_error",
          `OpenAI Responses API request failed with HTTP ${response.status}.`,
          startedAt,
          { response, rubricVersion },
        );
      }
      return this.failure(
        "malformed_response",
        "OpenAI Responses API returned non-JSON data.",
        startedAt,
        { response, rubricVersion },
      );
    }

    if (!response.ok) {
      const code = response.status === 429 ? "rate_limited" : "api_error";
      return this.failure(
        code,
        `OpenAI Responses API request failed with HTTP ${response.status}.`,
        startedAt,
        { response, payload, rubricVersion },
      );
    }
    if (payload.error || payload.status === "failed" || payload.status === "cancelled") {
      return this.failure(
        "api_error",
        `OpenAI Responses API reported ${payload.error?.code ?? payload.status ?? "an error"}.`,
        startedAt,
        { response, payload, rubricVersion },
      );
    }
    if (payload.status === "incomplete") {
      return this.failure(
        "incomplete_response",
        `OpenAI Responses API response was incomplete (${payload.incomplete_details?.reason ?? "unknown reason"}).`,
        startedAt,
        { response, payload, rubricVersion },
      );
    }

    const refusal = readRefusal(payload);
    if (refusal !== null) {
      return this.failure(
        "refusal",
        "OpenAI Responses API refused the benchmark grading request.",
        startedAt,
        { response, payload, rubricVersion },
      );
    }

    return {
      ok: true,
      payload,
      text: readOutputText(payload),
      telemetry: this.telemetry(payload, startedAt, rubricVersion),
    };
  }

  private failure(
    code: OpenAiResponsesJudgeErrorCode,
    message: string,
    startedAt: number,
    context: {
      response?: Response;
      payload?: ResponsesPayload;
      rubricVersion: string;
    },
  ): Extract<OpenAiResponsesVerdictResult, { ok: false }> {
    const telemetry = this.telemetry(
      context.payload,
      startedAt,
      context.rubricVersion,
      code,
      context.response?.status,
    );
    return {
      ok: false,
      error: {
        code,
        message,
        retryable: code === "rate_limited" || code === "transport_error",
        ...(context.response ? { httpStatus: context.response.status } : {}),
      },
      telemetry,
    };
  }

  private transportFailure(
    error: unknown,
    startedAt: number,
    rubricVersion: string,
  ): Extract<OpenAiResponsesVerdictResult, { ok: false }> {
    if (isAbortError(error)) {
      return this.failure(
        "aborted",
        "OpenAI Responses API request was aborted by the caller.",
        startedAt,
        { rubricVersion },
      );
    }
    if (error instanceof RetryFetchHttpError) {
      return this.failure(
        error.status === 429 ? "rate_limited" : "api_error",
        `OpenAI Responses API request failed with HTTP ${error.status} after retries.`,
        startedAt,
        {
          response: new Response(null, { status: error.status }),
          rubricVersion,
        },
      );
    }
    return this.failure(
      "transport_error",
      `OpenAI Responses API transport failed (${safeErrorName(error)}).`,
      startedAt,
      { rubricVersion },
    );
  }

  private asTransportError(
    error: unknown,
    startedAt: number,
    rubricVersion: string,
  ): OpenAiResponsesJudgeError {
    const failure = this.transportFailure(error, startedAt, rubricVersion);
    this.recordTelemetry(failure.telemetry);
    return new OpenAiResponsesJudgeError(failure);
  }

  private telemetry(
    payload: ResponsesPayload | undefined,
    startedAt: number,
    rubricVersion: string,
    errorCode?: OpenAiResponsesJudgeErrorCode,
    httpStatus?: number,
  ): OpenAiResponsesJudgeTelemetry {
    const tokens = readTokens(payload);
    return {
      model: payload?.model ?? this.config.model,
      rubricVersion,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      latencyMs: Math.round(performance.now() - startedAt),
      ...(errorCode ? { errorCode } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
  }

  private recordTelemetry(event: OpenAiResponsesJudgeTelemetry): void {
    this.telemetryEvents.push({ ...event });
  }

  private recordUsage(input: number, output: number): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + input,
      outputTokens: this.usage.outputTokens + output,
      totalTokens: this.usage.totalTokens + input + output,
    };
  }

  private responsesUrl(): string {
    const baseUrl = trimTrailingSlashes(this.config.baseUrl ?? "https://api.openai.com/v1");
    return `${baseUrl}/responses`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...(this.config.headers ?? {}),
      ...extra,
    };
  }
}

export function createOpenAiResponsesProvider(
  config: OpenAiResponsesProviderConfig = {},
): OpenAiResponsesProvider {
  return new OpenAiResponsesProvider(config);
}

export function createOpenAiResponsesBenchJudge(
  config: OpenAiResponsesProviderConfig = {},
  provider = createOpenAiResponsesProvider(config),
): BenchJudge {
  const scoreWithMetrics = async (
    question: string,
    predicted: string,
    expected: string,
    control?: { signal?: AbortSignal },
  ): Promise<BenchJudgeResult> => {
    const result = await provider.judge({
      rubric: GENERAL_ANSWER_JUDGE_RUBRIC,
      rubricVersion: config.rubricVersion ?? OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION,
      input: [
        `QUESTION: ${question}`,
        `REFERENCE_ANSWER: ${expected}`,
        `PREDICTED_ANSWER: ${predicted}`,
      ].join("\n\n"),
      signal: control?.signal,
    });
    if (!result.ok) throw new OpenAiResponsesJudgeError(result);
    return toBenchJudgeResult(result);
  };

  const scoreBinaryPrompt = async (
    prompt: string,
    control?: { signal?: AbortSignal },
  ): Promise<BenchJudgeResult> => {
    const result = await provider.judge({
      rubric: `${GENERAL_ANSWER_JUDGE_RUBRIC} This evaluator is binary: score must be exactly 0 or 1.`,
      rubricVersion: config.rubricVersion ?? OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION,
      input: prompt,
      signal: control?.signal,
    });
    if (!result.ok) throw new OpenAiResponsesJudgeError(result);
    if (result.verdict.score !== 0 && result.verdict.score !== 1) {
      const failure: Extract<OpenAiResponsesVerdictResult, { ok: false }> = {
        ok: false,
        error: {
          code: "malformed_verdict",
          message: "OpenAI Responses API returned a non-binary verdict for a binary rubric.",
          retryable: false,
        },
        telemetry: { ...result.telemetry, errorCode: "malformed_verdict" },
      };
      throw new OpenAiResponsesJudgeError(failure);
    }
    return toBenchJudgeResult(result);
  };

  const judgeSpecialized = async (
    request: MemCorrectJudgeRequest,
    rubric: "correction" | "stale_harm",
    control?: { signal?: AbortSignal },
  ): Promise<MemCorrectJudgeResult> => {
    const result = rubric === "correction"
      ? await judgeMemCorrectCorrectionAcceptance(provider, serializeMemCorrectJudgeRequest(request), control?.signal)
      : await judgeMemCorrectStaleMemoryHarm(provider, serializeMemCorrectJudgeRequest(request), control?.signal);
    if (!result.ok) throw new OpenAiResponsesJudgeError(result);
    return {
      ...toBenchJudgeResult(result),
      decision: result.verdict.decision,
      reason: result.verdict.reason,
      rubricVersion: result.telemetry.rubricVersion,
    };
  };

  return {
    async score(question, predicted, expected, control) {
      return (await scoreWithMetrics(question, predicted, expected, control)).score;
    },
    scoreWithMetrics,
    scoreBinaryPrompt,
    judgeMemCorrectCorrectionAcceptance: (request, control) =>
      judgeSpecialized(request, "correction", control),
    judgeMemCorrectStaleMemoryHarm: (request, control) =>
      judgeSpecialized(request, "stale_harm", control),
  };
}

export async function judgeMemCorrectCorrectionAcceptance(
  provider: OpenAiResponsesProvider,
  input: string,
  signal?: AbortSignal,
): Promise<OpenAiResponsesVerdictResult> {
  return provider.judge({
    rubric: MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC,
    rubricVersion: MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC_VERSION,
    input,
    signal,
  });
}

export async function judgeMemCorrectStaleMemoryHarm(
  provider: OpenAiResponsesProvider,
  input: string,
  signal?: AbortSignal,
): Promise<OpenAiResponsesVerdictResult> {
  return provider.judge({
    rubric: MEMCORRECT_STALE_HARM_RUBRIC,
    rubricVersion: MEMCORRECT_STALE_HARM_RUBRIC_VERSION,
    input,
    signal,
  });
}

function toBenchJudgeResult(
  result: Extract<OpenAiResponsesVerdictResult, { ok: true }>,
): BenchJudgeResult {
  return {
    score: result.verdict.score,
    tokens: {
      input: result.telemetry.inputTokens,
      output: result.telemetry.outputTokens,
    },
    latencyMs: result.telemetry.latencyMs,
    model: result.telemetry.model,
  };
}

function normalizeModel(model: string | undefined): string {
  if (model === undefined) return DEFAULT_OPENAI_RESPONSES_JUDGE_MODEL;
  const trimmed = model.trim();
  if (trimmed.length === 0) {
    throw new Error("OpenAI Responses judge model must be a non-empty string");
  }
  return trimmed;
}

function parseVerdict(text: string): OpenAiResponsesVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(",") !== "decision,reason,score") return null;
  if (
    typeof candidate.score !== "number" ||
    !Number.isFinite(candidate.score) ||
    candidate.score < 0 ||
    candidate.score > 1 ||
    (candidate.decision !== "pass" &&
      candidate.decision !== "partial" &&
      candidate.decision !== "fail") ||
    typeof candidate.reason !== "string" ||
    candidate.reason.trim().length === 0
  ) {
    return null;
  }
  return {
    score: candidate.score,
    decision: candidate.decision,
    reason: candidate.reason.trim(),
  };
}

function parseAssistantRubric(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(",") !== "calibration,identity_accuracy,notes,novelty,stance_coherence") return false;
  return ["identity_accuracy", "stance_coherence", "novelty", "calibration"].every((key) =>
    typeof candidate[key] === "number" &&
    Number.isFinite(candidate[key]) &&
    (candidate[key] as number) >= 0 &&
    (candidate[key] as number) <= 5
  ) && typeof candidate.notes === "string";
}

function serializeMemCorrectJudgeRequest(request: MemCorrectJudgeRequest): string {
  return JSON.stringify({
    taskId: request.taskId,
    query: request.query,
    retiredContent: request.retiredContent,
    correctedContent: request.correctedContent,
    evidence: {
      postCorrectionRecall: request.postCorrectionRecall,
      postMaintenanceRecall: request.postMaintenanceRecall,
      postReingestRecall: request.postReingestRecall,
    },
  });
}

function readOutputText(payload: ResponsesPayload): string | null {
  const text = (payload.output ?? [])
    .flatMap((item) => item.type === "message" ? item.content ?? [] : [])
    .filter((part): part is { type?: "output_text"; text?: string } => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

function readRefusal(payload: ResponsesPayload): string | null {
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal") return part.refusal ?? "refused";
    }
  }
  return null;
}

function readTokens(payload: ResponsesPayload | undefined): { input: number; output: number } {
  return {
    input: finiteNonNegative(payload?.usage?.input_tokens),
    output: finiteNonNegative(payload?.usage?.output_tokens),
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name.trim().length > 0 ? error.name : "Error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}
