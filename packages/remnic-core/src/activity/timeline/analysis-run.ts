/**
 * Config-driven surface for evidence-bound timeline-card analysis (issue #2050).
 *
 * Composes the parsed `activity.timeline.analysis` config with the local/remote
 * provider seams and `analyzeTimelineCards`. The AI gate is independent of
 * activity capture, timeline derivation, and memory creation: disabled means
 * zero provider calls and zero analysis artifacts. Every failure leaves the
 * deterministic cards byte-identical and returns a typed status.
 */
import { activityDayWindow } from "../digest.js";
import type { ActivityTimelineAnalysisConfig } from "../types.js";
import { analyzeTimelineCards, type TimelineAnalysisStatus } from "./analysis.js";
import type { AnalysisFailure } from "./analysis-failure.js";
import {
  timelineAnalysisCompleteFromClients,
  type TimelineAnalysisLocalLlm,
  type TimelineAnalysisRemoteLlm,
} from "./analysis-provider.js";
import { buildAnalysisRunMetadata, type AnalysisRunMetadata } from "./analysis-metadata.js";
import type { TimelineCard, TimelineCategory, TimelineCorrection, TimelineObservation } from "./types.js";

export interface TimelineAnalysisRunInput {
  /** Local calendar day being analyzed (YYYY-MM-DD). */
  date: string;
  /** IANA timezone the day is bucketed in. */
  timezone: string;
  /** Deterministic cards for the day (the bytes that must survive failure). */
  cards: readonly TimelineCard[];
  /** Day observations — the only evidence the provider may see. */
  observations: readonly TimelineObservation[];
  categories?: readonly TimelineCategory[];
  /** Prior accepted manual corrections, surfaced to the prompt as edits. */
  corrections?: readonly TimelineCorrection[];
  config: ActivityTimelineAnalysisConfig;
  deps: {
    localLlm?: TimelineAnalysisLocalLlm | null;
    remoteLlm?: TimelineAnalysisRemoteLlm | null;
  };
  signal?: AbortSignal;
}

export interface TimelineAnalysisRunResult {
  status: TimelineAnalysisStatus;
  /** Same card objects as the input on any non-ok status. */
  cards: TimelineCard[];
  failure?: AnalysisFailure;
  /** Provider/model/prompt-version provenance; identifiers only, never content. */
  metadata?: AnalysisRunMetadata;
}

/**
 * Run the optional analysis for one day. Observations are confined to the
 * DST-aware day window before anything is sent, so a mis-scoped caller cannot
 * widen the evidence the provider sees.
 */
export async function runTimelineCardAnalysis(
  input: TimelineAnalysisRunInput,
): Promise<TimelineAnalysisRunResult> {
  // Throws RangeError on an impossible date or invalid timezone before any
  // provider contact — the window bounds the whole run.
  const { startUtc, endUtc } = activityDayWindow(input.date, input.timezone);
  if (!input.config.enabled) {
    return { status: "disabled", cards: input.cards as TimelineCard[] };
  }
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  const observations = input.observations.filter((observation) => {
    const captured = Date.parse(observation.capturedAtUtc);
    return Number.isFinite(captured) && captured >= start && captured < end;
  });
  const result = await analyzeTimelineCards({
    enabled: true,
    cards: input.cards,
    observations,
    provider: input.config.provider,
    model: input.config.model,
    complete: timelineAnalysisCompleteFromClients({
      localLlm: input.deps.localLlm ?? null,
      remoteLlm: input.deps.remoteLlm ?? null,
    }),
    ...(input.config.timeoutMs === undefined ? {} : { timeoutMs: input.config.timeoutMs }),
    date: input.date,
    timezone: input.timezone,
    ...(input.categories === undefined ? {} : { categories: input.categories }),
    ...(input.config.preferences === undefined ? {} : { preferences: input.config.preferences }),
    ...(input.corrections === undefined ? {} : { priorEdits: input.corrections }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (result.status !== "ok") {
    return {
      status: result.status,
      cards: result.cards,
      ...(result.failure === undefined ? {} : { failure: result.failure }),
    };
  }
  return {
    status: "ok",
    cards: result.cards,
    metadata: buildAnalysisRunMetadata({
      provider: result.provider ?? "unknown",
      model: result.model ?? "unknown",
      promptVersion: String(result.promptVersion ?? "v0"),
      observationCount: observations.length,
    }),
  };
}
