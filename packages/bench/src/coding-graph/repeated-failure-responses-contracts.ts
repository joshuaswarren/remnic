import { z } from "zod";
import type { RetryFetchOptions } from "../providers/retry-fetch.js";
import type {
  RepeatedFailureEpisodeDriver,
  RepeatedFailureGateEvent,
  RepeatedFailureProposedAction,
  RepeatedFailureTokenizer,
  RepeatedFailureTokenUsage,
  RepeatedFailureToolDefinition,
} from "./repeated-failure-types.js";

const ResponseStatusSchema = z.enum([
  "completed",
  "failed",
  "incomplete",
  "cancelled",
  "queued",
  "in_progress",
]);
const ResponseUsageCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ResponsesApiUsageSchema = z.object({
  input_tokens: ResponseUsageCountSchema,
  output_tokens: ResponseUsageCountSchema,
  total_tokens: ResponseUsageCountSchema.optional(),
  input_tokens_details: z.object({
    cached_tokens: ResponseUsageCountSchema.optional(),
    cache_write_tokens: ResponseUsageCountSchema.optional(),
  }).strict().optional(),
  output_tokens_details: z.object({
    reasoning_tokens: ResponseUsageCountSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((usage, context) => {
  const derivedTotal = usage.input_tokens + usage.output_tokens;
  if (
    !Number.isSafeInteger(derivedTotal) ||
    (usage.total_tokens !== undefined && usage.total_tokens !== derivedTotal)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["total_tokens"],
      message: "total_tokens must equal input_tokens plus output_tokens",
    });
  }
});
export const ResponsesApiResponseSchema = z.object({
  id: z.string().min(1).max(256),
  model: z.string().min(1).max(256).optional(),
  status: ResponseStatusSchema,
  output: z.array(z.object({}).catchall(z.unknown())),
  usage: ResponsesApiUsageSchema,
}).passthrough();
export type ParsedResponsesApiResponse = z.infer<typeof ResponsesApiResponseSchema>;

export interface ResponsesApiOutputItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  role?: string;
  status?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ResponsesApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface ResponsesApiResponse {
  id?: string;
  model?: string;
  status?: z.infer<typeof ResponseStatusSchema>;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesApiOutputItem[];
  usage?: ResponsesApiUsage;
}

export interface ResponsesApiRequest {
  model: string;
  seed?: number;
  instructions?: string;
  max_output_tokens?: number;
  temperature?: 0;
  reasoning?: { effort: "low" | "medium" | "high" };
  include: readonly ["reasoning.encrypted_content"];
  input: Array<Record<string, unknown>>;
  tools: Array<{
    type: "function";
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
    strict: true;
  }>;
  tool_choice: "auto";
  parallel_tool_calls: false;
  stream: false;
  store: false;
}

export type ControlledResponsesTransport = (
  url: string,
  init: RequestInit,
  options: RetryFetchOptions,
) => Promise<Response>;

export interface RepeatedFailureToolExecutionResult {
  status: "completed" | "failed";
  output: unknown;
}

export interface RepeatedFailureFinalRepoEvidence {
  repoHash: string;
  checkResult: "UNFIXED" | "TRAPPED" | "FIXED" | "NO_TRAP" | "INDETERMINATE";
  changedFiles: readonly string[];
}

export interface ControlledResponsesToolDefinition extends RepeatedFailureToolDefinition {
  gateEligible: boolean;
}

export interface RepeatedFailureLocalToolHost {
  readonly tools: readonly ControlledResponsesToolDefinition[];
  execute(
    action: RepeatedFailureProposedAction,
    context: { signal: AbortSignal },
  ): Promise<RepeatedFailureToolExecutionResult>;
  captureFinalEvidence(context: { signal: AbortSignal }): Promise<RepeatedFailureFinalRepoEvidence>;
}

export interface ControlledGateDecision extends RepeatedFailureGateEvent {
  advisoryText?: string;
  waitExpired?: boolean;
}

export interface RepeatedFailureActionEvaluator {
  evaluate(
    action: RepeatedFailureProposedAction,
    context: { signal: AbortSignal },
  ): Promise<ControlledGateDecision>;
}
export interface NormalizedGateEvaluation {
  event: RepeatedFailureGateEvent;
  advisoryText?: string;
}

export interface ControlledResponsesSeedCapability {
  readonly kind: "request_parameter";
  readonly requestField: "seed";
}

export interface ControlledResponsesDriverConfig {
  model: string;
  modelProfileId?: string;
  modelProfileHash?: string;
  instructions?: string;
  seedCapability?: ControlledResponsesSeedCapability;
  gateWaitTimeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: 0;
  reasoningEffort?: "low" | "medium" | "high";
  apiKey?: string;
  baseUrl?: string;
  headers?: Readonly<Record<string, string>>;
  transport?: ControlledResponsesTransport;
  toolHost: RepeatedFailureLocalToolHost;
  evaluator: RepeatedFailureActionEvaluator;
}

export interface ControlledResponsesAgentDriverConfig
  extends Omit<ControlledResponsesDriverConfig, "toolHost" | "evaluator" | "modelProfileId" | "modelProfileHash"> {
  modelProfileId: string;
  modelProfileHash: string;
  modelDigest: string;
  developerInstructions?: string;
  tokenizer?: RepeatedFailureTokenizer;
}

export interface ControlledResponsesAgentDriver extends RepeatedFailureEpisodeDriver {
  readonly driverKind: "responses";
}

export interface ControlledResponsesCaps {
  maxTurns: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxDurationMs: number;
  requestTimeoutMs: number;
}

export interface ControlledResponsesEpisodeInput {
  prompt: string;
  seed?: number;
  caps: ControlledResponsesCaps;
  signal?: AbortSignal;
}

export interface ControlledResponsesResponseEvent {
  turn: number;
  responseId: string;
  status: NonNullable<ResponsesApiResponse["status"]>;
  model: string;
  outputItemTypes: readonly string[];
  usage: RepeatedFailureTokenUsage;
}

export interface ControlledResponsesToolEvent {
  callId: string;
  tool: string;
  fingerprint: string;
  status: "completed" | "failed";
  outputHash: string;
}

export interface ControlledResponsesFault {
  code: string;
  stage: "transport" | "response" | "tool_call" | "tool" | "caps" | "evidence";
  messageHash: string;
}

export type ControlledResponsesDisposition =
  | "NONE"
  | "EXECUTED"
  | "RESUBMITTED"
  | "CHANGED"
  | "ABANDONED";

export interface ControlledResponsesEpisodeResult {
  status: "COMPLETED" | "INVALID";
  invalidReason?: "FAULT" | "ABORTED" | "CAP_EXCEEDED";
  disposition: ControlledResponsesDisposition;
  outputTextHash: string;
  outputTextBytes: number;
  originalCallId?: string;
  originalFingerprint?: string;
  replacementCallId?: string;
  replacementFingerprint?: string;
  gate?: RepeatedFailureGateEvent;
  gateEvents: readonly RepeatedFailureGateEvent[];
  responses: readonly ControlledResponsesResponseEvent[];
  tools: readonly ControlledResponsesToolEvent[];
  usage: RepeatedFailureTokenUsage;
  faults: readonly ControlledResponsesFault[];
  finalRepoEvidence?: RepeatedFailureFinalRepoEvidence;
}
