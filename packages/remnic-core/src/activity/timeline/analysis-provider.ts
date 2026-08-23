/**
 * Provider-neutral completion adapter for timeline analysis (issue #2050).
 *
 * Routes the analysis prompt through the existing LLM contracts — the local
 * client (`provider: "local"`) or the gateway fallback client pinned to the
 * ONE explicitly configured remote provider/model. An invalid or missing
 * explicit provider surfaces as a typed failure; there is no chain fallback,
 * so a bad config can never silently answer from a different provider.
 *
 * Structural seams (not concrete classes) so hosts and tests inject fakes.
 * Never logs prompt or response content.
 */
import type { AnalysisFailureKind } from "./analysis-failure.js";
import type { TimelineAnalysisComplete } from "./analysis.js";

/** Structural slice of LocalLlmClient.chatCompletion (local seam). */
export interface TimelineAnalysisLocalLlm {
  chatCompletion(
    messages: Array<{ role: "system" | "user"; content: string }>,
    options: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: { type: string };
      signal?: AbortSignal;
      operation?: string;
      redactProviderErrors?: boolean;
    },
  ): Promise<{ content: string } | null>;
}

/** Structural slice of FallbackLlmClient.chatCompletion (remote seam). */
export interface TimelineAnalysisRemoteLlm {
  chatCompletion(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: {
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      modelChain?: { primary?: string; fallbacks?: string[] };
      includeDefaultModelFallback?: boolean;
      redactProviderErrors?: boolean;
    },
  ): Promise<{ content: string } | null>;
}

/** Marker base for provider errors the analysis run classifies by kind. */
export class TimelineAnalysisProviderError extends Error {
  override readonly name = "TimelineAnalysisProviderError";
  constructor(
    readonly kind: AnalysisFailureKind,
    message: string,
  ) {
    super(message);
  }
}

/** The provider id that routes to the local LLM client. */
export const TIMELINE_ANALYSIS_LOCAL_PROVIDER_ID = "local";

const RATE_LIMIT_MESSAGE = /rate limit|too many requests/i;

/**
 * Map a thrown provider error onto the typed failure kinds. Name- and
 * status-based only: the message is matched, never logged, so provider error
 * text cannot become a log line.
 */
export function classifyAnalysisProviderError(error: unknown): AnalysisFailureKind {
  if (error instanceof TimelineAnalysisProviderError) return error.kind;
  if (error instanceof Error) {
    if (error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR")) {
      return "aborted";
    }
    if (error.name === "TimeoutError") return "timeout";
    const status = "status" in error ? error.status : "statusCode" in error ? error.statusCode : undefined;
    if (status === 429 || RATE_LIMIT_MESSAGE.test(error.message)) return "rate_limited";
  }
  return "provider_unavailable";
}

/**
 * Build the `complete` function `analyzeTimelineCards` calls, from the local
 * and remote client seams. Selection is by the explicit provider id carried
 * on each call: `"local"` uses the local client; anything else is a remote
 * provider id pinned as the single-model chain (no default-chain fallback is
 * ever appended).
 */
export function timelineAnalysisCompleteFromClients(input: {
  localLlm: TimelineAnalysisLocalLlm | null;
  remoteLlm: TimelineAnalysisRemoteLlm | null;
}): TimelineAnalysisComplete {
  const { localLlm, remoteLlm } = input;
  return async ({ prompt, provider, model, signal }) => {
    const messages = [{ role: "user" as const, content: prompt }];
    if (provider === TIMELINE_ANALYSIS_LOCAL_PROVIDER_ID) {
      if (!localLlm) {
        throw new TimelineAnalysisProviderError(
          "provider_unavailable",
          "timeline analysis local provider is not configured",
        );
      }
      const result = await localLlm.chatCompletion(messages, {
        temperature: 0,
        maxTokens: 2048,
        signal,
        operation: "timeline-analysis",
        redactProviderErrors: true,
      });
      if (result === null) {
        throw new TimelineAnalysisProviderError(
          "provider_unavailable",
          "timeline analysis local provider returned no completion",
        );
      }
      return result.content;
    }
    if (!remoteLlm) {
      throw new TimelineAnalysisProviderError(
        "provider_unavailable",
        "timeline analysis remote provider is not configured",
      );
    }
    const result = await remoteLlm.chatCompletion(messages, {
      temperature: 0,
      maxTokens: 2048,
      signal,
      modelChain: { primary: `${provider}/${model}` },
      includeDefaultModelFallback: false,
      redactProviderErrors: true,
    });
    if (result === null) {
      throw new TimelineAnalysisProviderError(
        "provider_unavailable",
        `timeline analysis provider "${provider}" is not configured`,
      );
    }
    return result.content;
  };
}
