import { createHash } from "node:crypto";
import type {
  RepeatedFailureEpisodeInput,
  RepeatedFailureGateEvent,
  RepeatedFailureProposedAction,
  RepeatedFailureTokenUsage,
} from "./repeated-failure-types.js";
import {
  RetryFetchHttpError,
  retryFetch,
} from "../providers/retry-fetch.js";
import {
  failedToolExecutionResult,
  normalizeFinalEvidence,
  serializeBoundedToolOutput,
  trimTrailingSlashes,
} from "./repeated-failure-driver-utils.js";
import {
  ResponsesApiResponseSchema,
  type ControlledGateDecision,
  type ControlledResponsesAgentDriver,
  type ControlledResponsesAgentDriverConfig,
  type ControlledResponsesCaps,
  type ControlledResponsesDisposition,
  type ControlledResponsesDriverConfig,
  type ControlledResponsesEpisodeInput,
  type ControlledResponsesEpisodeResult,
  type ControlledResponsesFault,
  type ControlledResponsesResponseEvent,
  type ControlledResponsesToolDefinition,
  type ControlledResponsesToolEvent,
  type ControlledResponsesTransport,
  type NormalizedGateEvaluation,
  type ParsedResponsesApiResponse,
  type RepeatedFailureActionEvaluator,
  type RepeatedFailureToolExecutionResult,
  type ResponsesApiOutputItem,
  type ResponsesApiRequest,
  type ResponsesApiUsage,
} from "./repeated-failure-responses-contracts.js";
export type {
  ResponsesApiOutputItem,
  ResponsesApiUsage,
  ResponsesApiResponse,
  ResponsesApiRequest,
  ControlledResponsesTransport,
  RepeatedFailureToolExecutionResult,
  RepeatedFailureFinalRepoEvidence,
  ControlledResponsesToolDefinition,
  RepeatedFailureLocalToolHost,
  ControlledGateDecision,
  RepeatedFailureActionEvaluator,
  NormalizedGateEvaluation,
  ControlledResponsesSeedCapability,
  ControlledResponsesDriverConfig,
  ControlledResponsesAgentDriverConfig,
  ControlledResponsesAgentDriver,
  ControlledResponsesCaps,
  ControlledResponsesEpisodeInput,
  ControlledResponsesResponseEvent,
  ControlledResponsesToolEvent,
  ControlledResponsesFault,
  ControlledResponsesDisposition,
  ControlledResponsesEpisodeResult,
} from "./repeated-failure-responses-contracts.js";
const MAX_TOOL_ARGUMENT_BYTES = 16_384;
const DEFAULT_RESPONSES_BASE_URL = "https://api.openai.com/v1";
const MAX_FAULTS = 32;
const DEFAULT_GATE_WAIT_TIMEOUT_MS = 5_000;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SUPPORTED_JSON_SCHEMA_TYPES = {
  object: true,
  array: true,
  string: true,
  number: true,
  integer: true,
  boolean: true,
  null: true,
} as const satisfies Readonly<Record<string, true>>;
export async function evaluateControlledGateWithDeadline(
  evaluator: RepeatedFailureActionEvaluator,
  action: RepeatedFailureProposedAction,
  episodeSignal: AbortSignal,
  timeoutMs: number,
): Promise<ControlledGateDecision | "WAIT_EXPIRED"> {
  const gateController = new AbortController();
  const abortFromEpisode = () => gateController.abort();
  episodeSignal.addEventListener("abort", abortFromEpisode, { once: true });
  if (episodeSignal.aborted) gateController.abort();
  let expired = false;
  const { promise: waitExpired, resolve: expireWait } = Promise.withResolvers<"WAIT_EXPIRED">();
  const gateTimer = setTimeout(() => {
    expired = true;
    gateController.abort();
    expireWait("WAIT_EXPIRED");
  }, timeoutMs);
  const evaluation = evaluator.evaluate(action, { signal: gateController.signal }).then(
    (decision) => expired ? new Promise<never>(() => {}) : decision,
    (error) => expired ? new Promise<never>(() => {}) : Promise.reject(error),
  );
  try {
    return await Promise.race([raceAbort(evaluation, episodeSignal), waitExpired]);
  } finally {
    clearTimeout(gateTimer);
    gateController.abort();
    episodeSignal.removeEventListener("abort", abortFromEpisode);
  }
}

export function normalizeControlledGateDecision(
  decision: unknown,
  fallbackFingerprintHash: string,
): NormalizedGateEvaluation {
  if (!decision || typeof decision !== "object") {
    return {
      event: {
        status: "ERROR_FAIL_OPEN",
        fingerprintHash: fallbackFingerprintHash,
        faultCode: "INVALID_EVALUATOR_RESULT",
      },
    };
  }
  const candidate = decision as Partial<ControlledGateDecision>;
  if (
    (
      candidate.status !== "NO_MATCH" &&
      candidate.status !== "MATCH_WARN" &&
      candidate.status !== "ERROR_FAIL_OPEN"
    ) ||
    !isBoundedString(candidate.fingerprintHash, 256) ||
    (candidate.waitExpired !== undefined && typeof candidate.waitExpired !== "boolean")
  ) {
    return {
      event: {
        status: "ERROR_FAIL_OPEN",
        fingerprintHash: fallbackFingerprintHash,
        faultCode: "INVALID_EVALUATOR_RESULT",
      },
    };
  }
  const fingerprintHash = normalizeDigest(candidate.fingerprintHash);
  if (candidate.waitExpired === true) {
    return {
      event: {
        status: "ERROR_FAIL_OPEN",
        fingerprintHash,
        faultCode: "GATE_WAIT_EXPIRED",
      },
    };
  }
  if (candidate.status !== "MATCH_WARN") {
    return {
      event: {
        status: candidate.status,
        fingerprintHash,
        ...(candidate.faultCode ? { faultCode: boundedCode(candidate.faultCode) } : {}),
      },
    };
  }
  if (!isBoundedString(candidate.advisoryText, 4096)) {
    return {
      event: {
        status: "ERROR_FAIL_OPEN",
        fingerprintHash,
        faultCode: "INVALID_ADVISORY",
      },
    };
  }
  return {
    event: {
      status: "MATCH_WARN",
      fingerprintHash,
      warningHash: normalizeDigest(candidate.warningHash ?? candidate.advisoryText),
    },
    advisoryText: candidate.advisoryText,
  };
}

interface EpisodeState {
  history: Array<Record<string, unknown>>;
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

export class ControlledResponsesDriver {
  readonly modelId: string;
  readonly modelProfileId?: string;
  readonly modelProfileHash?: string;

  private readonly config: ControlledResponsesDriverConfig;
  private readonly transport: ControlledResponsesTransport;
  private readonly toolsByName: ReadonlyMap<string, ControlledResponsesToolDefinition>;

  constructor(config: ControlledResponsesDriverConfig) {
    if (typeof config.model !== "string" || config.model.trim().length === 0) {
      throw new Error("Controlled Responses driver requires an explicit model");
    }
    if ((config.modelProfileId === undefined) !== (config.modelProfileHash === undefined)) {
      throw new Error("modelProfileId and modelProfileHash must be provided together");
    }
    if (
      config.modelProfileId !== undefined &&
      !isBoundedString(config.modelProfileId, 256)
    ) {
      throw new Error("modelProfileId must be a bounded non-empty string");
    }
    if (
      config.modelProfileHash !== undefined &&
      !/^[a-f0-9]{64}$/.test(config.modelProfileHash)
    ) {
      throw new Error("modelProfileHash must be a lowercase SHA-256 digest");
    }
    validateSeedCapabilityConfiguration(config);
    if (
      config.gateWaitTimeoutMs !== undefined &&
      (!Number.isFinite(config.gateWaitTimeoutMs) || config.gateWaitTimeoutMs <= 0)
    ) {
      throw new Error("gateWaitTimeoutMs must be positive and finite");
    }
    this.toolsByName = validateTools(config.toolHost.tools);
    this.config = config;
    this.transport = config.transport ?? retryFetch;
    this.modelId = config.model;
    this.modelProfileId = config.modelProfileId;
    if (
      config.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0)
    ) {
      throw new Error("maxOutputTokens must be a positive safe integer");
    }
    this.modelProfileHash = config.modelProfileHash;
  }

  async runEpisode(input: ControlledResponsesEpisodeInput): Promise<ControlledResponsesEpisodeResult> {
    if (!isBoundedString(input.prompt, 100_000)) throw new Error("episode prompt is invalid");
    if (
      input.seed !== undefined &&
      (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff)
    ) {
      throw new Error("episode seed must be an integer in [0, 2^32 - 1]");
    }
    if (input.seed !== undefined && this.config.seedCapability === undefined) {
      throw new Error(`Configured Responses endpoint cannot honor registered seed ${input.seed}`);
    }
    for (const field of ["maxTurns", "maxToolCalls", "maxTotalTokens"] as const) {
      if (!Number.isSafeInteger(input.caps[field]) || input.caps[field] <= 0) {
        throw new Error(`${field} must be a positive integer`);
      }
    }
    for (const field of ["maxDurationMs", "requestTimeoutMs"] as const) {
      if (!Number.isFinite(input.caps[field]) || input.caps[field] <= 0) {
        throw new Error(`${field} must be positive and finite`);
      }
    }
    const state: EpisodeState = {
      history: [{ role: "user", content: [{ type: "input_text", text: input.prompt }] }],
      responses: [],
      tools: [],
      faults: [],
      usage: {
        input: 0,
        output: 0,
        total: 0,
        cachedInput: 0,
        cacheWriteInput: 0,
        reasoningOutput: 0,
      },
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

        const responseResult = await this.requestResponse(
          state.history,
          input.caps,
          controller.signal,
          input.seed,
        );
        if (!responseResult.ok) {
          pushFault(state, responseResult.fault);
          if (controller.signal.aborted) return this.invalidateAbort(state, durationExpired);
          return finalizeResult(state, "INVALID", "FAULT");
        }
        const parsedPayload = parseResponse(responseResult.response);
        if (!parsedPayload.ok) {
          pushFault(state, parsedPayload.fault);
          return finalizeResult(state, "INVALID", "FAULT");
        }
        const payload = parsedPayload.response;
        if (payload.model !== this.modelId) {
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

        const usage = normalizeUsage(payload.usage);
        if (!addUsage(state.usage, usage)) {
          pushFault(state, fault("MALFORMED_RESPONSE", "response", "usage_total"));
          return finalizeResult(state, "INVALID", "FAULT");
        }
        state.responses.push({
          turn: state.responses.length + 1,
          responseId: payload.id,
          status: payload.status,
          model: payload.model,
          outputItemTypes: (payload.output ?? []).map((item) =>
            typeof item.type === "string" && item.type.length <= 64 ? item.type : "unknown",
          ),
          usage,
        });
        state.history.push(...(payload.output ?? []).map((item) => structuredClone(item)));
        state.outputText += extractOutputText(payload.output ?? []);

        if (state.usage.total > input.caps.maxTotalTokens) {
          return this.invalidateCap(state, "TOKEN_CAP");
        }
        if (payload.status !== "completed") {
          pushFault(state, fault("RESPONSE_NOT_COMPLETED", "response", payload.status ?? "missing"));
          return finalizeResult(state, "INVALID", "FAULT");
        }

        const calls = (payload.output ?? []).filter((item) => item.type === "function_call");
        if (calls.length === 0) {
          if (state.warned && state.replacementCallId === undefined) state.disposition = "ABANDONED";
          const completed = await this.completeWithEvidence(state, controller.signal);
          if (controller.signal.aborted) {
            return this.invalidateAbort(state, durationExpired);
          }
          return completed;
        }
        if (calls.length > 1) {
          pushFault(state, fault("MULTIPLE_TOOL_CALLS", "tool_call", String(calls.length)));
          return finalizeResult(state, "INVALID", "FAULT");
        }

        const actionResult = parseAction(calls[0], this.toolsByName, state.callIds);
        if (!actionResult.ok) {
          pushFault(state, actionResult.fault);
          return finalizeResult(state, "INVALID", "FAULT");
        }
        const { action, toolDefinition } = actionResult;
        state.callIds.add(action.callId);
        const actionFingerprint = fingerprintAction(action);
        if (!state.warned && toolDefinition.gateEligible) {
          const gate = await this.evaluateGate(action, controller.signal);
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
              type: "function_call_output",
              call_id: action.callId,
              output: JSON.stringify({
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
          state.disposition =
            actionFingerprint === state.originalFingerprint ? "RESUBMITTED" : "CHANGED";
        }

        if (state.executedToolCalls >= input.caps.maxToolCalls) {
          return this.invalidateCap(state, "TOOL_CAP");
        }
        const toolResult = await this.executeTool(action, controller.signal);
        if (!toolResult.ok) {
          if (controller.signal.aborted) {
            return this.invalidateAbort(state, durationExpired);
          }
          pushFault(state, toolResult.fault);
          return finalizeResult(state, "INVALID", "FAULT");
        }
        state.executedToolCalls += 1;
        if (
          !state.warned &&
          toolDefinition.gateEligible &&
          state.disposition === "NONE"
        ) {
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
          type: "function_call_output",
          call_id: action.callId,
          output: toolResult.serializedOutput,
        });
      }
    } finally {
      clearTimeout(durationTimer);
      input.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async requestResponse(
    history: readonly Record<string, unknown>[],
    caps: ControlledResponsesCaps,
    signal: AbortSignal,
    seed?: number,
  ): Promise<
    | { ok: true; response: unknown }
    | { ok: false; fault: ControlledResponsesFault }
  > {
    const request: ResponsesApiRequest = {
      model: this.config.model,
      ...(seed !== undefined ? { seed } : {}),
      ...(this.config.instructions ? { instructions: this.config.instructions } : {}),
      ...(this.config.maxOutputTokens !== undefined
        ? { max_output_tokens: this.config.maxOutputTokens }
        : {}),
      ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
      ...(this.config.reasoningEffort ? { reasoning: { effort: this.config.reasoningEffort } } : {}),
      include: ["reasoning.encrypted_content"],
      input: history.map((item) => structuredClone(item)),
      tools: [...this.toolsByName.values()].map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: true as const,
      })),
      tool_choice: "auto",
      parallel_tool_calls: false,
      stream: false,
      store: false,
    };

    const requestController = new AbortController();
    let requestExpired = false;
    const onEpisodeAbort = () => requestController.abort();
    signal.addEventListener("abort", onEpisodeAbort, { once: true });
    if (signal.aborted) requestController.abort();
    const requestTimer = setTimeout(() => {
      requestExpired = true;
      requestController.abort();
    }, caps.requestTimeoutMs);
    try {
      const response = await raceAbort(
        this.transport(
          `${trimTrailingSlashes(this.config.baseUrl ?? DEFAULT_RESPONSES_BASE_URL)}/responses`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
              ...(this.config.headers ?? {}),
            },
            signal: requestController.signal,
            body: JSON.stringify(request),
          },
          {
            maxAttempts: 1,
            timeoutMs: caps.requestTimeoutMs,
            retryOnTimeout: false,
            max429WaitMs: 0,
          },
        ),
        requestController.signal,
      );
      if (!response.ok) {
        return {
          ok: false,
          fault: fault(`HTTP_${response.status}`, "transport", String(response.status)),
        };
      }
      try {
        const body = await raceAbort(response.json(), requestController.signal);
        return { ok: true, response: body };
      } catch (error) {
        if (requestController.signal.aborted) throw error;
        return {
          ok: false,
          fault: fault("MALFORMED_RESPONSE", "response", errorMessage(error)),
        };
      }
    } catch (error) {
      const code = signal.aborted
        ? "ABORTED"
        : requestExpired || isAbortError(error)
          ? "REQUEST_TIMEOUT"
          : error instanceof RetryFetchHttpError
            ? `HTTP_${error.status}`
            : "TRANSPORT_ERROR";
      return { ok: false, fault: fault(code, "transport", errorMessage(error)) };
    } finally {
      clearTimeout(requestTimer);
      signal.removeEventListener("abort", onEpisodeAbort);
    }
  }

  private async evaluateGate(
    action: RepeatedFailureProposedAction,
    signal: AbortSignal,
  ): Promise<{ event: RepeatedFailureGateEvent; advisoryText?: string }> {
    const fallbackFingerprintHash = fingerprintAction(action);
    try {
      const decision = await evaluateControlledGateWithDeadline(
        this.config.evaluator,
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
          faultCode: isAbortError(error) ? "EVALUATOR_ABORTED" : "EVALUATOR_ERROR",
        },
      };
    }
  }

  private async executeTool(
    action: RepeatedFailureProposedAction,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; result: RepeatedFailureToolExecutionResult; serializedOutput: string }
    | { ok: false; fault: ControlledResponsesFault }
  > {
    try {
      const result = await raceAbort(this.config.toolHost.execute(action, { signal }), signal);
      if (result.status !== "completed" && result.status !== "failed") {
        return { ok: false, fault: fault("INVALID_TOOL_RESULT", "tool", action.tool) };
      }
      const serializedOutput = serializeBoundedToolOutput(result);
      return { ok: true, result, serializedOutput };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return { ok: false, fault: fault("ABORTED", "tool", action.tool) };
      }
      const result = failedToolExecutionResult();
      return { ok: true, result, serializedOutput: serializeBoundedToolOutput(result) };
    }
  }

  private async completeWithEvidence(
    state: EpisodeState,
    signal: AbortSignal,
  ): Promise<ControlledResponsesEpisodeResult> {
    try {
      const evidence = normalizeFinalEvidence(
        await raceAbort(this.config.toolHost.captureFinalEvidence({ signal }), signal),
      );
      return { ...finalizeResult(state, "COMPLETED"), finalRepoEvidence: evidence };
    } catch (error) {
      pushFault(state, fault("INVALID_FINAL_EVIDENCE", "evidence", errorMessage(error)));
      return finalizeResult(state, "INVALID", "FAULT");
    }
  }

  private invalidateAbort(state: EpisodeState, durationExpired: boolean): ControlledResponsesEpisodeResult {
    if (durationExpired) return this.invalidateCap(state, "DURATION_CAP");
    pushFault(state, fault("ABORTED", "transport", "caller abort"));
    return finalizeResult(state, "INVALID", "ABORTED");
  }

  private invalidateCap(state: EpisodeState, cap: string): ControlledResponsesEpisodeResult {
    pushFault(state, fault(cap, "caps", cap));
    return finalizeResult(state, "INVALID", "CAP_EXCEEDED");
  }
}

export function createControlledResponsesAgentDriver(
  config: ControlledResponsesAgentDriverConfig
): ControlledResponsesAgentDriver {
  if (!isBoundedString(config.modelProfileId, 256)) {
    throw new Error("modelProfileId must be a bounded non-empty string");
  }
  if (!/^[a-f0-9]{64}$/.test(config.modelProfileHash)) {
    throw new Error("modelProfileHash must be a lowercase SHA-256 digest");
  }
  if (!/^[a-f0-9]{64}$/.test(config.modelDigest)) {
    throw new Error("modelDigest must be a lowercase SHA-256 digest");
  }
  if (config.seedCapability === undefined) {
    throw new Error("Controlled Responses agent driver requires registered seed capability");
  }
  validateSeedCapabilityConfiguration(config);
  return {
    driverKind: "responses",
    modelProfileId: config.modelProfileId,
    developerInstructions: config.developerInstructions ?? "",
    tokenizer: config.tokenizer ?? {
      identity: "responses-nfkc-v1",
      implementation: "nfkc-whitespace-v1",
    },
    modelProfileHash: config.modelProfileHash,
    modelDigest: config.modelDigest,
    async runEpisode(request: RepeatedFailureEpisodeInput): Promise<ControlledResponsesEpisodeResult> {
      const driver = new ControlledResponsesDriver({
        ...config,
        toolHost: request.toolHost,
        evaluator: request.evaluator,
      });
      return driver.runEpisode({
        prompt: request.prompt,
        seed: request.identity.seed,
        caps: request.caps,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    },
  };
}

function validateSeedCapabilityConfiguration(
  config: Pick<ControlledResponsesDriverConfig, "seedCapability" | "baseUrl">,
): void {
  if (config.seedCapability === undefined) return;
  const capability = config.seedCapability as unknown;
  if (
    capability === null ||
    typeof capability !== "object" ||
    Array.isArray(capability) ||
    (capability as Record<string, unknown>).kind !== "request_parameter" ||
    (capability as Record<string, unknown>).requestField !== "seed" ||
    Object.keys(capability).length !== 2
  ) {
    throw new Error("seedCapability must declare the exact request_parameter seed shape");
  }
  if (
    config.baseUrl === undefined ||
    trimTrailingSlashes(config.baseUrl) === DEFAULT_RESPONSES_BASE_URL
  ) {
    throw new Error("official Responses endpoint does not support registered seed control");
  }
}

function validateTools(
  tools: readonly ControlledResponsesToolDefinition[],
): ReadonlyMap<string, ControlledResponsesToolDefinition> {
  const byName = new Map<string, ControlledResponsesToolDefinition>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) throw new Error(`invalid tool name: ${tool.name}`);
    if (byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    if (typeof tool.gateEligible !== "boolean") {
      throw new Error(`tool ${tool.name} must declare gateEligible`);
    }
    if (!isBoundedString(tool.description, 1024)) {
      throw new Error(`tool ${tool.name} has an invalid description`);
    }
    validateStrictSchema(tool.inputSchema, `tool ${tool.name}`);
    byName.set(tool.name, tool);
  }
  if (byName.size === 0) throw new Error("at least one local tool is required");
  return byName;
}

function validateStrictSchema(schema: Readonly<Record<string, unknown>>, label: string): void {
  if (
    schema.type !== "object" ||
    typeof schema.properties !== "object" ||
    schema.properties === null ||
    Array.isArray(schema.properties)
  ) {
    throw new Error(`${label} strict schema must be an object with properties`);
  }
  if (schema.additionalProperties !== false) {
    throw new Error(`${label} strict schema must set additionalProperties to false`);
  }
  const properties = schema.properties as Readonly<Record<string, unknown>>;
  const keys = Object.keys(properties).sort();
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string").sort()
    : [];
  if (required.length !== keys.length || required.some((item, index) => item !== keys[index])) {
    throw new Error(`${label} strict schema must require every property`);
  }
  for (const [key, childValue] of Object.entries(properties)) {
    if (typeof childValue !== "object" || childValue === null || Array.isArray(childValue)) {
      throw new Error(`${label}.${key} schema must be an object`);
    }
    validateStrictValueSchema(childValue as Readonly<Record<string, unknown>>, `${label}.${key}`);
  }
}

function validateStrictValueSchema(
  schema: Readonly<Record<string, unknown>>,
  label: string,
): void {
  if (
    typeof schema.type !== "string" ||
    !(schema.type in SUPPORTED_JSON_SCHEMA_TYPES)
  ) {
    throw new Error(`${label} has an unsupported strict schema type`);
  }
  if (schema.type === "object") {
    validateStrictSchema(schema, label);
    return;
  }
  if (schema.type !== "array") return;
  if (typeof schema.items !== "object" || schema.items === null || Array.isArray(schema.items)) {
    throw new Error(`${label} array schema must define one item schema`);
  }
  validateStrictValueSchema(schema.items as Readonly<Record<string, unknown>>, `${label}[]`);
}

function parseResponse(
  payload: unknown,
): { ok: true; response: ParsedResponsesApiResponse } | { ok: false; fault: ControlledResponsesFault } {
  const parsed = ResponsesApiResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.path.join(".") || "shape";
    return { ok: false, fault: fault("MALFORMED_RESPONSE", "response", detail) };
  }
  return { ok: true, response: parsed.data };
}

function parseAction(
  item: ResponsesApiOutputItem | undefined,
  tools: ReadonlyMap<string, ControlledResponsesToolDefinition>,
  seenCallIds: ReadonlySet<string>,
):
  | {
      ok: true;
      action: RepeatedFailureProposedAction;
      toolDefinition: ControlledResponsesToolDefinition;
    }
  | { ok: false; fault: ControlledResponsesFault } {
  if (
    item?.type !== "function_call" ||
    !isBoundedString(item.call_id, 256) ||
    !isBoundedString(item.name, 64) ||
    typeof item.arguments !== "string" ||
    item.arguments.length > MAX_TOOL_ARGUMENT_BYTES
  ) {
    return { ok: false, fault: fault("MALFORMED_TOOL_CALL", "tool_call", "shape") };
  }
  if (seenCallIds.has(item.call_id)) {
    return { ok: false, fault: fault("DUPLICATE_CALL_ID", "tool_call", item.call_id) };
  }
  const tool = tools.get(item.name);
  if (!tool) return { ok: false, fault: fault("UNKNOWN_TOOL", "tool_call", item.name) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.arguments);
  } catch (error) {
    return { ok: false, fault: fault("MALFORMED_TOOL_CALL", "tool_call", errorMessage(error)) };
  }
  if (!matchesToolArguments(parsed, tool.inputSchema)) {
    return { ok: false, fault: fault("INVALID_TOOL_ARGUMENTS", "tool_call", item.name) };
  }
  return {
    ok: true,
    action: { callId: item.call_id, tool: item.name, arguments: parsed },
    toolDefinition: tool,
  };
}

function matchesToolArguments(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    matchesSchema(value, schema)
  );
}

function matchesSchema(value: unknown, schema: Readonly<Record<string, unknown>>): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) return false;
  switch (schema.type) {
    case "object": {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        typeof schema.properties !== "object" ||
        schema.properties === null ||
        Array.isArray(schema.properties)
      ) {
        return false;
      }
      const objectValue = value as Record<string, unknown>;
      const properties = schema.properties as Readonly<Record<string, unknown>>;
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (required.some((key) => typeof key !== "string" || !(key in objectValue))) return false;
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(properties));
        if (Object.keys(objectValue).some((key) => !allowed.has(key))) return false;
      }
      return Object.entries(objectValue).every(([key, child]) => {
        const childSchema = properties[key];
        return (
          typeof childSchema === "object" &&
          childSchema !== null &&
          !Array.isArray(childSchema) &&
          matchesSchema(child, childSchema as Readonly<Record<string, unknown>>)
        );
      });
    }
    case "array": {
      if (!Array.isArray(value)) return false;
      if (typeof schema.items !== "object" || schema.items === null || Array.isArray(schema.items)) {
        return true;
      }
      const itemSchema = schema.items as Readonly<Record<string, unknown>>;
      return value.every((item) => matchesSchema(item, itemSchema));
    }
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function normalizeUsage(usage: ResponsesApiUsage | undefined): RepeatedFailureTokenUsage {
  const input = nonNegativeInteger(usage?.input_tokens);
  const output = nonNegativeInteger(usage?.output_tokens);
  return {
    input,
    output,
    total: usage?.total_tokens === undefined
      ? input + output
      : nonNegativeInteger(usage.total_tokens),
    cachedInput: nonNegativeInteger(usage?.input_tokens_details?.cached_tokens),
    cacheWriteInput: nonNegativeInteger(usage?.input_tokens_details?.cache_write_tokens),
    reasoningOutput: nonNegativeInteger(usage?.output_tokens_details?.reasoning_tokens),
  };
}

function addUsage(total: RepeatedFailureTokenUsage, turn: RepeatedFailureTokenUsage): boolean {
  const input = total.input + turn.input;
  const output = total.output + turn.output;
  const combinedTotal = total.total + turn.total;
  const cachedInput = total.cachedInput + turn.cachedInput;
  const cacheWriteInput = total.cacheWriteInput + turn.cacheWriteInput;
  const reasoningOutput = total.reasoningOutput + turn.reasoningOutput;
  if (
    !Number.isSafeInteger(input)
    || !Number.isSafeInteger(output)
    || !Number.isSafeInteger(combinedTotal)
    || !Number.isSafeInteger(cachedInput)
    || !Number.isSafeInteger(cacheWriteInput)
    || !Number.isSafeInteger(reasoningOutput)
  ) return false;
  total.input = input;
  total.output = output;
  total.total = combinedTotal;
  total.cachedInput = cachedInput;
  total.cacheWriteInput = cacheWriteInput;
  total.reasoningOutput = reasoningOutput;
  return true;
}

function extractOutputText(output: readonly ResponsesApiOutputItem[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        typeof content === "object" &&
        content !== null &&
        !Array.isArray(content) &&
        "type" in content &&
        content.type === "output_text" &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n");
}


function fingerprintAction(action: RepeatedFailureProposedAction): string {
  return sha256(stableStringify({ tool: action.tool, arguments: action.arguments }));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const objectValue = value as Record<string, unknown>;
    return `{${Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}

function finalizeResult(
  state: EpisodeState,
  status: ControlledResponsesEpisodeResult["status"],
  invalidReason?: ControlledResponsesEpisodeResult["invalidReason"],
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
    ...(state.gate ? { gate: { ...state.gate } } : {}),
    gateEvents: state.gateEvents.map((event) => ({ ...event })),
    responses: state.responses.map((event) => ({ ...event, outputItemTypes: [...event.outputItemTypes] })),
    tools: state.tools.map((event) => ({ ...event })),
    usage: { ...state.usage },
    faults: state.faults.map((event) => ({ ...event })),
  };
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function pushFault(state: EpisodeState, value: ControlledResponsesFault): void {
  if (state.faults.length < MAX_FAULTS) state.faults.push(value);
}

function fault(
  code: string,
  stage: ControlledResponsesFault["stage"],
  message: string,
): ControlledResponsesFault {
  return { code: boundedCode(code), stage, messageHash: sha256(message.slice(0, 4096)) };
}

function boundedCode(value: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : "INVALID_CODE";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeDigest(value: string): string {
  return /^[a-f0-9]{64}$/.test(value) ? value : sha256(value);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
