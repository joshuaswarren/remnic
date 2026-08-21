import type { BenchJudge, BenchJudgeResult, MemCorrectJudgeRequest, MemCorrectJudgeResult } from "../adapters/types.js";
import {
  GENERAL_ANSWER_JUDGE_RUBRIC,
  MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC,
  MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC_VERSION,
  MEMCORRECT_STALE_HARM_RUBRIC,
  MEMCORRECT_STALE_HARM_RUBRIC_VERSION,
  OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION,
} from "../judges/memcorrect-rubrics.js";
import type { LlmProvider } from "./types.js";

export type StructuredJudgeErrorCode =
  | "api_error"
  | "rate_limited"
  | "refusal"
  | "malformed_response"
  | "malformed_verdict"
  | "incomplete_response"
  | "transport_error"
  | "aborted";

export interface StructuredJudgeTelemetry {
  model: string;
  rubricVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  errorCode?: StructuredJudgeErrorCode;
  httpStatus?: number;
}

export interface StructuredJudgeVerdict {
  score: number;
  decision: "pass" | "partial" | "fail";
  reason: string;
}

export type StructuredJudgeVerdictResult =
  | {
      ok: true;
      verdict: StructuredJudgeVerdict;
      telemetry: StructuredJudgeTelemetry;
    }
  | {
      ok: false;
      error: {
        code: StructuredJudgeErrorCode;
        message: string;
        retryable: boolean;
        httpStatus?: number;
      };
      telemetry: StructuredJudgeTelemetry;
    };

export interface StructuredVerdictRequest {
  rubric: string;
  rubricVersion: string;
  input: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface AssistantRubricRequest {
  system: string;
  user: string;
  rubricId: string;
}

export interface StructuredJudgeProvider extends LlmProvider {
  judge(request: StructuredVerdictRequest): Promise<StructuredJudgeVerdictResult>;
  evaluateAssistantRubric(request: AssistantRubricRequest): Promise<string>;
  createJudgeError?(failure: Extract<StructuredJudgeVerdictResult, { ok: false }>): Error;
}

export const VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "decision", "reason"],
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
    decision: { type: "string", enum: ["pass", "partial", "fail"] },
    reason: { type: "string" },
  },
} as const;

export const ASSISTANT_RUBRIC_JSON_SCHEMA = {
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

export class StructuredJudgeError extends Error {
  readonly code: StructuredJudgeErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly telemetry: StructuredJudgeTelemetry;

  constructor(failure: Extract<StructuredJudgeVerdictResult, { ok: false }>) {
    super(failure.error.message);
    this.name = "StructuredJudgeError";
    this.code = failure.error.code;
    this.retryable = failure.error.retryable;
    this.httpStatus = failure.error.httpStatus;
    this.telemetry = failure.telemetry;
  }
}

export function isStructuredJudgeProvider(provider: LlmProvider): provider is StructuredJudgeProvider {
  const candidate = provider as Partial<StructuredJudgeProvider>;
  return typeof candidate.judge === "function" && typeof candidate.evaluateAssistantRubric === "function";
}

export function createStructuredBenchJudge(
  provider: StructuredJudgeProvider,
  rubricVersion = OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION
): BenchJudge {
  const scoreWithMetrics = async (
    question: string,
    predicted: string,
    expected: string,
    control?: { signal?: AbortSignal }
  ): Promise<BenchJudgeResult> =>
    unwrapJudgeResult(
      provider,
      await provider.judge({
        rubric: GENERAL_ANSWER_JUDGE_RUBRIC,
        rubricVersion,
        input: [`QUESTION: ${question}`, `REFERENCE_ANSWER: ${expected}`, `PREDICTED_ANSWER: ${predicted}`].join(
          "\n\n"
        ),
        signal: control?.signal,
      })
    );

  const scoreBinaryPrompt = async (prompt: string, control?: { signal?: AbortSignal }): Promise<BenchJudgeResult> => {
    const result = await provider.judge({
      rubric: `${GENERAL_ANSWER_JUDGE_RUBRIC} This evaluator is binary: score must be exactly 0 or 1.`,
      rubricVersion,
      input: prompt,
      signal: control?.signal,
    });
    if (result.ok && result.verdict.score !== 0 && result.verdict.score !== 1) {
      throwJudgeFailure(provider, {
        ok: false,
        error: {
          code: "malformed_verdict",
          message: "Structured judge returned a non-binary verdict for a binary rubric.",
          retryable: false,
        },
        telemetry: { ...result.telemetry, errorCode: "malformed_verdict" },
      });
    }
    return unwrapJudgeResult(provider, result);
  };

  const judgeSpecialized = async (
    request: MemCorrectJudgeRequest,
    rubric: "correction" | "stale_harm",
    control?: { signal?: AbortSignal }
  ): Promise<MemCorrectJudgeResult> => {
    const result = await provider.judge({
      rubric: rubric === "correction" ? MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC : MEMCORRECT_STALE_HARM_RUBRIC,
      rubricVersion:
        rubric === "correction"
          ? MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC_VERSION
          : MEMCORRECT_STALE_HARM_RUBRIC_VERSION,
      input: serializeMemCorrectJudgeRequest(request),
      signal: control?.signal,
    });
    if (!result.ok) {
      throwJudgeFailure(provider, result);
    }
    const base = unwrapJudgeResult(provider, result);
    return {
      ...base,
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
    judgeMemCorrectCorrectionAcceptance: (request, control) => judgeSpecialized(request, "correction", control),
    judgeMemCorrectStaleMemoryHarm: (request, control) => judgeSpecialized(request, "stale_harm", control),
  };
}

export function parseStructuredJudgeVerdict(text: string): StructuredJudgeVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "decision,reason,score") return null;
  if (
    typeof candidate.score !== "number" ||
    !Number.isFinite(candidate.score) ||
    candidate.score < 0 ||
    candidate.score > 1 ||
    (candidate.decision !== "pass" && candidate.decision !== "partial" && candidate.decision !== "fail") ||
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

export function isValidAssistantRubric(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const candidate = parsed as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "calibration,identity_accuracy,notes,novelty,stance_coherence") {
    return false;
  }
  return (
    ["identity_accuracy", "stance_coherence", "novelty", "calibration"].every(
      (key) =>
        typeof candidate[key] === "number" &&
        Number.isFinite(candidate[key]) &&
        (candidate[key] as number) >= 0 &&
        (candidate[key] as number) <= 5
    ) && typeof candidate.notes === "string"
  );
}

export function serializeMemCorrectJudgeRequest(request: MemCorrectJudgeRequest): string {
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

function unwrapJudgeResult(provider: StructuredJudgeProvider, result: StructuredJudgeVerdictResult): BenchJudgeResult {
  if (!result.ok) {
    throwJudgeFailure(provider, result);
  }
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

function throwJudgeFailure(
  provider: StructuredJudgeProvider,
  failure: Extract<StructuredJudgeVerdictResult, { ok: false }>
): never {
  throw provider.createJudgeError?.(failure) ?? new StructuredJudgeError(failure);
}
