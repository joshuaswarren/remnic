import { createHash } from "node:crypto";
import { z } from "zod";
import {
  RetryFetchHttpError,
  retryFetch,
  type RetryFetchOptions,
} from "../providers/retry-fetch.js";
import {
  evaluateControlledGateWithDeadline,
  normalizeControlledGateDecision,
  type ControlledResponsesCaps,
  type ControlledResponsesDisposition,
  type ControlledResponsesEpisodeResult,
  type ControlledResponsesFault,
  type ControlledResponsesResponseEvent,
  type ControlledResponsesToolDefinition,
  type ControlledResponsesToolEvent,
  type ControlledResponsesTransport,
  type RepeatedFailureActionEvaluator,
  type RepeatedFailureFinalRepoEvidence,
  type RepeatedFailureLocalToolHost,
  type RepeatedFailureToolExecutionResult,
} from "./repeated-failure-responses-driver.js";
import type {
  RepeatedFailureEpisodeDriver,
  RepeatedFailureEpisodeInput,
  RepeatedFailureGateEvent,
  RepeatedFailureProposedAction,
  RepeatedFailureTokenUsage,
  RepeatedFailureTokenizer,
} from "./repeated-failure-types.js";
import {
  failedToolExecutionResult,
  normalizeFinalEvidence,
  serializeBoundedToolOutput,
  trimTrailingSlashes,
} from "./repeated-failure-driver-utils.js";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const MAX_FAULTS = 32;
const DEFAULT_GATE_WAIT_TIMEOUT_MS = 5_000;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function validateOllamaChatEndpoint(endpoint: string | undefined): string {
  const rawUrl = (endpoint ?? DEFAULT_OLLAMA_BASE_URL).trim();
  const trimmed = trimTrailingSlashes(rawUrl);
  const lower = trimmed.toLowerCase();

  if (
    lower.endsWith("/v1") ||
    lower.endsWith("/v1/responses") ||
    lower.endsWith("/v1/chat/completions") ||
    lower.includes("/v1/")
  ) {
    throw new Error(
      `Provider 'ollama-chat' requires a native Ollama endpoint (e.g. http://127.0.0.1:11434) and rejects OpenAI compatibility paths (${rawUrl})`,
    );
  }

  if (lower.endsWith("/api/chat")) {
    return trimTrailingSlashes(trimmed.slice(0, -9));
  }

  return trimmed;
}

const OllamaFunctionCallSchema = z.object({
  name: z.string(),
  arguments: z.union([z.record(z.unknown()), z.string()]),
});

const OllamaToolCallSchema = z.object({
  function: OllamaFunctionCallSchema,
});

const OllamaChatMessageSchema = z.object({
  role: z.string().optional(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  tool_calls: z.array(OllamaToolCallSchema).optional(),
});

const OllamaChatResponseSchema = z.object({
  model: z.string().optional(),
  created_at: z.string().optional(),
  message: OllamaChatMessageSchema.optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  eval_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  error: z.string().optional(),
}).passthrough();
const OllamaTagsResponseSchema = z.object({
  models: z.array(z.object({
    name: z.string().min(1),
    model: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).passthrough()),
}).passthrough();


export type ParsedOllamaChatResponse = z.infer<typeof OllamaChatResponseSchema>;

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_name?: string;
  thinking?: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown> | string;
    };
  }>;
}

export interface RepeatedFailureOllamaChatDriverConfig {
  model: string;
  modelProfileId: string;
  modelProfileHash: string;
  modelDigest: string;
  developerInstructions?: string;
  instructions?: string;
  baseUrl?: string;
  endpoint?: string;
  seedCapability?: { kind: "options_parameter"; requestField: "seed" };
  gateWaitTimeoutMs?: number;
  maxOutputTokens?: number;
  contextWindowTokens?: number;
  temperature?: 0;
  think?: boolean;
  headers?: Readonly<Record<string, string>>;
  requestTimeoutMs?: number;
  transport?: ControlledResponsesTransport;
  tokenizer?: RepeatedFailureTokenizer;
}

export function createRepeatedFailureOllamaChatDriver(
  config: RepeatedFailureOllamaChatDriverConfig,
): RepeatedFailureOllamaChatDriver {
  return new RepeatedFailureOllamaChatDriver(config);
}

interface EpisodeState {
  history: OllamaChatMessage[];
  responses: ControlledResponsesResponseEvent[];
  tools: ControlledResponsesToolEvent[];
  faults: ControlledResponsesFault[];
  usage: RepeatedFailureTokenUsage;
  callIds: Set<string>;
  gateEvents: RepeatedFailureGateEvent[];
  warned: boolean;
  executedToolCalls: number;
  outputText: string;
  disposition: ControlledResponsesDisposition;
  originalCallId?: string;
  originalFingerprint?: string;
  replacementCallId?: string;
  replacementFingerprint?: string;
  gate?: RepeatedFailureGateEvent;
}

export class RepeatedFailureOllamaChatDriver implements RepeatedFailureEpisodeDriver {
  readonly driverKind = "ollama-chat" as const;
  readonly modelProfileId: string;
  readonly modelProfileHash: string;
  readonly modelDigest: string;
  readonly developerInstructions: string;
  readonly tokenizer: RepeatedFailureTokenizer;

  private readonly config: RepeatedFailureOllamaChatDriverConfig;
  private readonly baseUrl: string;
  private readonly transport: ControlledResponsesTransport;

  constructor(config: RepeatedFailureOllamaChatDriverConfig) {
    if (typeof config.model !== "string" || config.model.trim().length === 0) {
      throw new Error("RepeatedFailureOllamaChatDriver requires an explicit model");
    }
    validateProfileMetadata(config.modelProfileId, config.modelProfileHash);
    if (!/^[a-f0-9]{64}$/.test(config.modelDigest)) {
      throw new Error("modelDigest must be a lowercase SHA-256 digest");
    }
    if (
      config.requestTimeoutMs !== undefined
      && (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
    ) {
      throw new Error("requestTimeoutMs must be a positive safe integer");
    }
    if (
      config.contextWindowTokens !== undefined
      && (!Number.isSafeInteger(config.contextWindowTokens) || config.contextWindowTokens <= 0)
    ) {
      throw new Error("contextWindowTokens must be a positive safe integer");
    }


    this.baseUrl = validateOllamaChatEndpoint(config.endpoint ?? config.baseUrl);
    this.modelProfileId = config.modelProfileId;
    this.modelProfileHash = config.modelProfileHash;
    this.modelDigest = config.modelDigest;
    this.developerInstructions = config.developerInstructions ?? config.instructions ?? "";
    this.tokenizer = config.tokenizer ?? {
      identity: "ollama-utf8",
      implementation: "nfkc-whitespace-v1",
    };
    this.config = config;
    this.transport = config.transport ?? defaultTransport;
  }

  async preflight(): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await raceSignal(
        this.transport(`${this.baseUrl}/api/tags`, {
          method: "GET",
          headers: this.config.headers,
          signal: controller.signal,
        }, {
          maxAttempts: 1,
          timeoutMs,
        }),
        controller.signal,
      );
      if (!response.ok) {
        throw new Error(`Ollama model identity preflight failed with HTTP ${response.status}`);
      }
      const parsed = OllamaTagsResponseSchema.safeParse(
        await raceSignal(response.json(), controller.signal),
      );
      if (!parsed.success) {
        throw new Error("Ollama model identity preflight returned a malformed model list");
      }
      const matches = parsed.data.models.filter(
        (candidate) => candidate.name === this.config.model || candidate.model === this.config.model,
      );
      if (matches.length !== 1) {
        throw new Error(`Ollama model identity preflight found ${matches.length} exact model matches`);
      }
      if (matches[0]?.digest !== this.config.modelDigest) {
        throw new Error("Ollama model digest mismatch");
      }
      if (this.config.contextWindowTokens !== undefined) {
        const showResponse = await raceSignal(
          this.transport(`${this.baseUrl}/api/show`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...this.config.headers,
            },
            body: JSON.stringify({ model: this.config.model }),
            signal: controller.signal,
          }, {
            maxAttempts: 1,
            timeoutMs,
          }),
          controller.signal,
        );
        if (!showResponse.ok) {
          throw new Error(`Ollama model capability preflight failed with HTTP ${showResponse.status}`);
        }
        const show = await raceSignal(showResponse.json(), controller.signal);
        if (!show || typeof show !== "object") {
          throw new Error("Ollama model capability preflight returned a malformed response");
        }
        const modelInfo = (show as Record<string, unknown>).model_info;
        if (!modelInfo || typeof modelInfo !== "object") {
          throw new Error("Ollama model capability preflight omitted model_info");
        }
        const contextLengths = Object.entries(modelInfo)
          .filter(([key]) => key.endsWith(".context_length"))
          .map(([, value]) => value)
          .filter((value): value is number => Number.isSafeInteger(value) && (value as number) > 0);
        if (contextLengths.length !== 1) {
          throw new Error("Ollama model capability preflight found no unique context length");
        }
        const nativeContextLength = contextLengths[0];
        if (nativeContextLength === undefined || nativeContextLength < this.config.contextWindowTokens) {
          throw new Error(
            `Ollama model context window ${nativeContextLength ?? "unknown"} is below configured ${this.config.contextWindowTokens}`,
          );
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Ollama model identity preflight timed out", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async runEpisode(input: RepeatedFailureEpisodeInput): Promise<ControlledResponsesEpisodeResult> {
    const toolsByName = validateTools(input.toolHost.tools);
    const history: OllamaChatMessage[] = [];
    if (this.developerInstructions) {
      history.push({ role: "system", content: this.developerInstructions });
    }
    history.push({ role: "user", content: input.prompt });

    const state: EpisodeState = {
      history,
      responses: [],
      tools: [],
      faults: [],
      usage: emptyUsage(),
      callIds: new Set(),
      gateEvents: [],
      warned: false,
      executedToolCalls: 0,
      outputText: "",
      disposition: "NONE",
    };

    const controller = new AbortController();
    let durationExpired = false;
    const onCallerAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    const durationTimer = setTimeout(() => {
      durationExpired = true;
      controller.abort();
    }, input.caps.maxDurationMs);

    try {
      while (true) {
        if (controller.signal.aborted) {
          return this.invalidateAbort(state, durationExpired);
        }
        if (state.responses.length >= input.caps.maxTurns) {
          return this.invalidateCap(state, "TURN_CAP");
        }

        const effectiveSeed = input.identity.seed;
        const responseResult = await this.requestChatResponse(
          state.history,
          input.caps,
          controller.signal,
          toolsByName,
          effectiveSeed,
        );

        if (!responseResult.ok) {
          pushFault(state, responseResult.fault);
          if (controller.signal.aborted) return this.invalidateAbort(state, durationExpired);
          return finalizeResult(state, "INVALID", "FAULT");
        }

        const payload = responseResult.response;
        if (payload.error) {
          pushFault(state, fault("OLLAMA_RESPONSE_ERROR", "response", payload.error));
          return finalizeResult(state, "INVALID", "FAULT");
        }
        if (payload.model !== this.config.model) {
          pushFault(
            state,
            fault(
              "MODEL_IDENTITY_MISMATCH",
              "response",
              payload.model === undefined ? "missing" : payload.model,
            ),
          );
          return finalizeResult(state, "INVALID", "FAULT");
        }
        if (payload.done !== true) {
          pushFault(state, fault("RESPONSE_NOT_DONE", "response", `done was ${String(payload.done)}`));
          return finalizeResult(state, "INVALID", "FAULT");
        }
        if (!payload.message) {
          pushFault(state, fault("MISSING_MESSAGE", "response", "no message in response"));
          return finalizeResult(state, "INVALID", "FAULT");
        }
        if (payload.prompt_eval_count === undefined || payload.eval_count === undefined) {
          pushFault(state, fault("MISSING_TOKEN_USAGE", "response", "required token counts missing"));
          return finalizeResult(state, "INVALID", "FAULT");
        }

        const usage = normalizeOllamaUsage(payload.prompt_eval_count, payload.eval_count);
        state.usage = addUsage(state.usage, usage);
        if (state.usage.total > input.caps.maxTotalTokens) {
          return this.invalidateCap(state, "TOKEN_CAP");
        }

        const msg = payload.message;
        const outputItemTypes: string[] = [];
        if (msg.content) outputItemTypes.push("content");
        if (msg.thinking) outputItemTypes.push("thinking");
        if (msg.tool_calls && msg.tool_calls.length > 0) outputItemTypes.push("tool_calls");
        if (outputItemTypes.length === 0) outputItemTypes.push("message");

        const turnEvent: ControlledResponsesResponseEvent = {
          turn: state.responses.length + 1,
          responseId: `ollama_chat_turn_${state.responses.length + 1}`,
          status: "completed",
          model: payload.model,
          outputItemTypes,
          usage,
        };
        state.responses.push(turnEvent);

        state.history.push({
          role: "assistant",
          content: msg.content ?? "",
          ...(msg.thinking ? { thinking: msg.thinking } : {}),
          ...(msg.tool_calls && msg.tool_calls.length > 0
            ? {
                tool_calls: msg.tool_calls.map((tc) => ({
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                })),
              }
            : {}),
        });

        state.outputText += msg.content ?? "";

        const toolCalls = msg.tool_calls ?? [];
        if (toolCalls.length === 0) {
          const evidenceResult = await this.captureFinalEvidence(input.toolHost, controller.signal);
          if (!evidenceResult.ok) {
            pushFault(state, evidenceResult.fault);
            if (controller.signal.aborted) return this.invalidateAbort(state, durationExpired);
            return finalizeResult(state, "INVALID", "FAULT");
          }
          return finalizeResult(state, "COMPLETED", undefined, evidenceResult.evidence);
        }

        if (toolCalls.length > 1) {
          pushFault(state, fault("MULTIPLE_TOOL_CALLS", "tool_call", String(toolCalls.length)));
          return finalizeResult(state, "INVALID", "FAULT");
        }

        const rawCall = toolCalls[0];
        if (rawCall === undefined) {
          pushFault(state, fault("MISSING_TOOL_CALL", "tool_call", "tool call missing after length check"));
          return finalizeResult(state, "INVALID", "FAULT");
        }
        const actionResult = this.parseOllamaAction(rawCall, state.callIds, toolsByName);
        if (!actionResult.ok) {
          pushFault(state, actionResult.fault);
          return finalizeResult(state, "INVALID", "FAULT");
        }

        const { action, toolDefinition } = actionResult;
        state.callIds.add(action.callId);
        const actionFingerprint = fingerprintAction(action);

        if (!state.warned && toolDefinition.gateEligible) {
          const gate = await this.evaluateGate(action, controller.signal, input.evaluator);
          state.gate = gate.event;
          state.gateEvents.push(gate.event);
          if (controller.signal.aborted) {
            return this.invalidateAbort(state, durationExpired);
          }
          if (gate.advisoryText !== undefined) {
            state.originalCallId = action.callId;
            state.originalFingerprint = actionFingerprint;
            state.warned = true;
            state.disposition = "ABANDONED";
            state.history.push({
              role: "tool",
              tool_name: action.tool,
              content: JSON.stringify({
                status: "not_executed",
                disposition: "advisory",
                advisory: gate.advisoryText,
              }),
            });
            continue;
          }
        } else if (
          state.warned &&
          toolDefinition.gateEligible &&
          state.replacementCallId === undefined
        ) {
          state.replacementCallId = action.callId;
          state.replacementFingerprint = actionFingerprint;
          state.disposition = actionFingerprint === state.originalFingerprint ? "RESUBMITTED" : "CHANGED";
        }

        if (state.executedToolCalls >= input.caps.maxToolCalls) {
          return this.invalidateCap(state, "TOOL_CAP");
        }

        const toolResult = await this.executeTool(action, controller.signal, input.toolHost);
        if (!toolResult.ok) {
          if (controller.signal.aborted) {
            return this.invalidateAbort(state, durationExpired);
          }
          pushFault(state, toolResult.fault);
          return finalizeResult(state, "INVALID", "FAULT");
        }

        state.executedToolCalls += 1;
        if (!state.warned && toolDefinition.gateEligible && state.disposition === "NONE") {
          state.disposition = "EXECUTED";
        }

        state.tools.push({
          callId: action.callId,
          tool: action.tool,
          fingerprint: actionFingerprint,
          status: toolResult.result.status,
          outputHash: sha256(toolResult.serializedOutput),
        });

        state.history.push({
          role: "tool",
          tool_name: action.tool,
          content: toolResult.serializedOutput,
        });
      }
    } finally {
      clearTimeout(durationTimer);
      input.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async requestChatResponse(
    history: readonly OllamaChatMessage[],
    caps: ControlledResponsesCaps,
    signal: AbortSignal,
    toolsByName: ReadonlyMap<string, ControlledResponsesToolDefinition>,
    seed?: number,
  ): Promise<{ ok: true; response: ParsedOllamaChatResponse } | { ok: false; fault: ControlledResponsesFault }> {
    const formattedTools = Array.from(toolsByName.values()).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));

    const requestBody = {
      model: this.config.model,
      messages: history,
      ...(formattedTools.length > 0 ? { tools: formattedTools } : {}),
      ...(this.config.think === undefined ? {} : { think: this.config.think }),
      options: {
        ...(seed !== undefined ? { seed } : {}),
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : { temperature: 0 }),
        ...(this.config.maxOutputTokens !== undefined
          ? { num_predict: this.config.maxOutputTokens }
          : {}),
        ...(this.config.contextWindowTokens !== undefined
          ? { num_ctx: this.config.contextWindowTokens }
          : {}),
      },
      stream: false,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.headers ?? {}),
    };

    const requestController = new AbortController();
    let requestExpired = false;
    const abortFromEpisode = () => requestController.abort();
    signal.addEventListener("abort", abortFromEpisode, { once: true });
    if (signal.aborted) requestController.abort();
    const requestTimer = setTimeout(() => {
      requestExpired = true;
      requestController.abort();
    }, caps.requestTimeoutMs);
    const timeoutOptions: RetryFetchOptions = {
      timeoutMs: caps.requestTimeoutMs,
      maxAttempts: 1,
    };

    try {
      const response = await raceSignal(
        this.transport(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: requestController.signal,
        }, timeoutOptions),
        requestController.signal,
      );

      if (!response.ok) {
        return {
          ok: false,
          fault: fault(`HTTP_${response.status}`, "transport", String(response.status)),
        };
      }

      const rawJson = await raceSignal(response.json(), requestController.signal);
      const parsedZod = OllamaChatResponseSchema.safeParse(rawJson);
      if (!parsedZod.success) {
        return {
          ok: false,
          fault: fault("MALFORMED_RESPONSE_SCHEMA", "response", parsedZod.error.message),
        };
      }

      return { ok: true, response: parsedZod.data };
    } catch (error) {
      if (signal.aborted) {
        return { ok: false, fault: fault("REQUEST_ABORTED", "transport", "caller signal") };
      }
      if (requestExpired) {
        return { ok: false, fault: fault("REQUEST_TIMEOUT", "transport", "request deadline") };
      }
      if (error instanceof RetryFetchHttpError) {
        return {
          ok: false,
          fault: fault(`HTTP_${error.status}`, "transport", `${error.status}:${error.message}`),
        };
      }
      return { ok: false, fault: fault("TRANSPORT_FAILED", "transport", errorMessage(error)) };
    } finally {
      clearTimeout(requestTimer);
      signal.removeEventListener("abort", abortFromEpisode);
    }
  }

  private parseOllamaAction(
    toolCall: z.infer<typeof OllamaToolCallSchema>,
    seenCallIds: ReadonlySet<string>,
    toolsByName: ReadonlyMap<string, ControlledResponsesToolDefinition>,
  ):
    | { ok: true; action: RepeatedFailureProposedAction; toolDefinition: ControlledResponsesToolDefinition }
    | { ok: false; fault: ControlledResponsesFault } {
    const fn = toolCall.function;
    const toolName = fn.name;

    const toolDefinition = toolsByName.get(toolName);
    if (!toolDefinition) {
      return { ok: false, fault: fault("UNKNOWN_TOOL", "tool_call", toolName) };
    }

    let parsedArgs: Record<string, unknown>;
    if (typeof fn.arguments === "string") {
      try {
        const jsonParsed = JSON.parse(fn.arguments);
        if (typeof jsonParsed !== "object" || jsonParsed === null || Array.isArray(jsonParsed)) {
          return {
            ok: false,
            fault: fault("MALFORMED_TOOL_ARGUMENTS", "tool_call", `${toolName}:arguments not an object`),
          };
        }
        parsedArgs = jsonParsed as Record<string, unknown>;
      } catch (error) {
        return {
          ok: false,
          fault: fault("MALFORMED_TOOL_ARGUMENTS", "tool_call", `${toolName}:${errorMessage(error)}`),
        };
      }
    } else if (typeof fn.arguments === "object" && fn.arguments !== null && !Array.isArray(fn.arguments)) {
      parsedArgs = fn.arguments;
    } else {
      return {
        ok: false,
        fault: fault("MALFORMED_TOOL_ARGUMENTS", "tool_call", `${toolName}:arguments missing or invalid`),
      };
    }

    if (!matchesToolArguments(parsedArgs, toolDefinition.inputSchema)) {
      return {
        ok: false,
        fault: fault("TOOL_ARGUMENTS_MISMATCH", "tool_call", `${toolName}:schema mismatch`),
      };
    }

    let callId = `call_${sha256(`${toolName}:${stableStringify(parsedArgs)}`).slice(0, 16)}`;
    let suffix = 1;
    while (seenCallIds.has(callId)) {
      callId = `call_${sha256(`${toolName}:${stableStringify(parsedArgs)}:${suffix}`).slice(0, 16)}`;
      suffix += 1;
    }

    return {
      ok: true,
      action: {
        callId,
        tool: toolName,
        arguments: parsedArgs,
      },
      toolDefinition,
    };
  }

  private async evaluateGate(
    action: RepeatedFailureProposedAction,
    signal: AbortSignal,
    evaluator: RepeatedFailureActionEvaluator,
  ): Promise<{ event: RepeatedFailureGateEvent; advisoryText?: string }> {
    const fallbackFingerprintHash = fingerprintAction(action);
    try {
      const decision = await evaluateControlledGateWithDeadline(
        evaluator,
        action,
        signal,
        this.config.gateWaitTimeoutMs ?? DEFAULT_GATE_WAIT_TIMEOUT_MS,
      );
      return decision === "WAIT_EXPIRED"
        ? {
          event: {
            status: "ERROR_FAIL_OPEN",
            fingerprintHash: fallbackFingerprintHash,
            faultCode: "GATE_WAIT_EXPIRED",
          },
        }
        : normalizeControlledGateDecision(decision, fallbackFingerprintHash);
    } catch (error) {
      return {
        event: {
          status: "ERROR_FAIL_OPEN",
          fingerprintHash: fallbackFingerprintHash,
          faultCode: signal.aborted ? "EVALUATOR_ABORTED" : "EVALUATOR_ERROR",
        },
      };
    }
  }

  private async executeTool(
    action: RepeatedFailureProposedAction,
    signal: AbortSignal,
    toolHost: RepeatedFailureLocalToolHost,
  ): Promise<
    | { ok: true; result: RepeatedFailureToolExecutionResult; serializedOutput: string }
    | { ok: false; fault: ControlledResponsesFault }
  > {
    try {
      const result = await raceSignal(toolHost.execute(action, { signal }), signal);
      if (result.status !== "completed" && result.status !== "failed") {
        return { ok: false, fault: fault("INVALID_TOOL_RESULT", "tool", action.tool) };
      }
      const serializedOutput = serializeBoundedToolOutput(result);
      return { ok: true, result, serializedOutput };
    } catch {
      if (signal.aborted) {
        return { ok: false, fault: fault("ABORTED", "tool", action.tool) };
      }
      const result = failedToolExecutionResult();
      return { ok: true, result, serializedOutput: serializeBoundedToolOutput(result) };
    }
  }

  private async captureFinalEvidence(
    toolHost: RepeatedFailureLocalToolHost,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; evidence: RepeatedFailureFinalRepoEvidence }
    | { ok: false; fault: ControlledResponsesFault }
  > {
    try {
      const evidence = await raceSignal(toolHost.captureFinalEvidence({ signal }), signal);
      return { ok: true, evidence: normalizeFinalEvidence(evidence) };
    } catch (error) {
      return {
        ok: false,
        fault: fault("INVALID_FINAL_EVIDENCE", "evidence", errorMessage(error)),
      };
    }
  }

  private invalidateAbort(state: EpisodeState, durationExpired: boolean): ControlledResponsesEpisodeResult {
    if (durationExpired) return this.invalidateCap(state, "DURATION_CAP");
    pushFault(state, fault("ABORTED", "transport", "caller abort"));
    return finalizeResult(state, "INVALID", "ABORTED");
  }

  private invalidateCap(
    state: EpisodeState,
    capCode: "DURATION_CAP" | "TURN_CAP" | "TOOL_CAP" | "TOKEN_CAP",
  ): ControlledResponsesEpisodeResult {
    pushFault(state, fault(capCode, "caps", capCode));
    return finalizeResult(state, "INVALID", "CAP_EXCEEDED");
  }
}

function validateProfileMetadata(profileId: string | undefined, profileHash: string | undefined): void {
  if ((profileId === undefined) !== (profileHash === undefined)) {
    throw new Error("modelProfileId and modelProfileHash must be provided together");
  }
  if (profileId !== undefined && !isBoundedString(profileId, 256)) {
    throw new Error("modelProfileId must be a bounded non-empty string");
  }
  if (profileHash !== undefined && !/^[a-f0-9]{64}$/.test(profileHash)) {
    throw new Error("modelProfileHash must be a lowercase SHA-256 digest");
  }
}

function validateTools(
  tools: readonly ControlledResponsesToolDefinition[],
): ReadonlyMap<string, ControlledResponsesToolDefinition> {
  const map = new Map<string, ControlledResponsesToolDefinition>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}"`);
    }
    if (map.has(tool.name)) {
      throw new Error(`Duplicate tool definition "${tool.name}"`);
    }
    validateStrictSchema(tool.inputSchema, `tool ${tool.name}`);
    map.set(tool.name, tool);
  }
  return map;
}

function validateStrictSchema(schema: Readonly<Record<string, unknown>>, label: string): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`${label} schema must be an object`);
  }
  if (schema.type !== "object") {
    throw new Error(`${label} top-level schema type must be "object"`);
  }
  if (schema.additionalProperties !== false) {
    throw new Error(`${label} schema must enforce additionalProperties: false`);
  }
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error(`${label} schema properties must be an object`);
  }
  const required = schema.required;
  if (!Array.isArray(required)) {
    throw new Error(`${label} schema required array must be provided`);
  }
  const propertyKeys = Object.keys(properties);
  if (propertyKeys.length !== required.length) {
    throw new Error(`${label} schema required keys must cover all declared properties`);
  }
  for (const key of propertyKeys) {
    if (!required.includes(key)) {
      throw new Error(`${label} schema property "${key}" must be marked required`);
    }
    const propSchema = (properties as Record<string, unknown>)[key];
    if (typeof propSchema !== "object" || propSchema === null || Array.isArray(propSchema)) {
      throw new Error(`${label} schema property "${key}" must be a valid schema object`);
    }
    validateStrictValueSchema(propSchema as Record<string, unknown>, `${label}.${key}`);
  }
}

function validateStrictValueSchema(schema: Readonly<Record<string, unknown>>, label: string): void {
  const type = schema.type;
  if (typeof type !== "string" || !(type in SUPPORTED_JSON_SCHEMA_TYPES)) {
    throw new Error(`${label} has unsupported schema type "${String(type)}"`);
  }
}

const SUPPORTED_JSON_SCHEMA_TYPES = {
  string: true,
  number: true,
  integer: true,
  boolean: true,
  object: true,
  array: true,
} as const satisfies Readonly<Record<string, true>>;

function matchesToolArguments(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return matchesSchema(value, schema);
}

function matchesSchema(value: unknown, schema: Readonly<Record<string, unknown>>): boolean {
  const type = schema.type;
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && !Number.isNaN(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
    const required = (schema.required as readonly string[] | undefined) ?? [];
    const valObj = value as Record<string, unknown>;
    for (const reqKey of required) {
      if (!(reqKey in valObj)) return false;
    }
    for (const [k, val] of Object.entries(valObj)) {
      const propSchema = properties[k];
      if (!propSchema || typeof propSchema !== "object") return false;
      if (!matchesSchema(val, propSchema as Record<string, unknown>)) return false;
    }
    return true;
  }
  return false;
}

function fingerprintAction(action: RepeatedFailureProposedAction): string {
  return sha256(stableStringify({ tool: action.tool, arguments: action.arguments }));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyUsage(): RepeatedFailureTokenUsage {
  return { input: 0, output: 0, total: 0, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: 0 };
}

function addUsage(base: RepeatedFailureTokenUsage, add: RepeatedFailureTokenUsage): RepeatedFailureTokenUsage {
  return {
    input: base.input + add.input,
    output: base.output + add.output,
    total: base.total + add.total,
    cachedInput: base.cachedInput + add.cachedInput,
    cacheWriteInput: base.cacheWriteInput + add.cacheWriteInput,
    reasoningOutput: base.reasoningOutput + add.reasoningOutput,
  };
}

function normalizeOllamaUsage(
  promptEvalCount: number,
  evalCount: number,
): RepeatedFailureTokenUsage {
  return {
    input: promptEvalCount,
    output: evalCount,
    total: promptEvalCount + evalCount,
    cachedInput: 0,
    cacheWriteInput: 0,
    reasoningOutput: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function defaultTransport(url: string, init: RequestInit, options: RetryFetchOptions): Promise<Response> {
  return retryFetch(url, init, options);
}

function pushFault(state: EpisodeState, faultItem: ControlledResponsesFault): void {
  if (state.faults.length < MAX_FAULTS) {
    state.faults.push(faultItem);
  }
}

function fault(code: string, stage: ControlledResponsesFault["stage"], message: string): ControlledResponsesFault {
  return { code, stage, messageHash: sha256(message) };
}


function finalizeResult(
  state: EpisodeState,
  status: "COMPLETED" | "INVALID",
  invalidReason?: "FAULT" | "ABORTED" | "CAP_EXCEEDED",
  evidence?: RepeatedFailureFinalRepoEvidence,
): ControlledResponsesEpisodeResult {
  return {
    status,
    ...(invalidReason ? { invalidReason } : {}),
    disposition: state.disposition,
    outputTextHash: sha256(state.outputText),
    outputTextBytes: Buffer.byteLength(state.outputText, "utf8"),
    ...(state.originalCallId ? { originalCallId: state.originalCallId } : {}),
    ...(state.originalFingerprint ? { originalFingerprint: state.originalFingerprint } : {}),
    ...(state.replacementCallId ? { replacementCallId: state.replacementCallId } : {}),
    ...(state.replacementFingerprint ? { replacementFingerprint: state.replacementFingerprint } : {}),
    ...(state.gate ? { gate: state.gate } : {}),
    gateEvents: state.gateEvents,
    responses: state.responses,
    tools: state.tools,
    usage: state.usage,
    faults: state.faults,
    ...(evidence ? { finalRepoEvidence: evidence } : {}),
  };
}

async function raceSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(new DOMException("aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T | { gateWaitExpired: true }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ gateWaitExpired: true }>((resolve) => {
    timer = setTimeout(() => resolve({ gateWaitExpired: true }), timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

  try {
    return await Promise.race([operation, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
