/**
 * Location tagging service (issue #2046) — the IO half around the pure
 * matcher in `matching.ts`. Three consumers share it so the policy can never
 * fork:
 *
 *  1. Write-time enrichment: after an extraction batch has cleared the
 *     trust/importance/content-hash gates and persisted, the caller tags the
 *     new memories (post-write, best-effort, never fails the extraction).
 *  2. Historical backfill (`location/backfill.ts`): the same plan/apply core
 *     over a bounded date range, idempotent by construction.
 *  3. Wearable conversation fill: `WearableConversation.location` is filled
 *     ONLY when the source did not provide one and the match passes policy.
 *
 * Segment data comes from the machine-global location sync state
 * (`state/locations/sync.json`, ≤ 90 tracked days — matching the bounded
 * backfill range). Reads are plain file loads; every memory mutation goes
 * through `StorageManager.writeMemoryFrontmatter`, the atomic frontmatter
 * chokepoint that preserves content (and therefore the content hash),
 * lifecycle, and versioning invariants.
 */

import type { StorageManager } from "../index.js";
import { log } from "../logger.js";
import type { MemoryFile } from "../types.js";
import type { WearableConversation } from "../wearables/types.js";
import { localDayKey, placeDurations } from "./intervals.js";
import {
  matchDominantPlace,
  memoryLocationWindow,
  planLocationUpdate,
  type LocationSourceSegments,
  type LocationTagPolicy,
  type LocationUpdatePlan,
} from "./matching.js";
import { loadLocationSyncState } from "./store.js";
import type { LocationConfig } from "./types.js";

/** Segments for one local day, per source id, from the sync state. */
export type DaySegmentIndex = Map<string, LocationSourceSegments[]>;

/** Load every tracked day's per-source segments (one file read). */
export async function loadDaySegmentIndex(memoryDir: string): Promise<DaySegmentIndex> {
  const state = await loadLocationSyncState(memoryDir);
  const index: DaySegmentIndex = new Map();
  for (const [sourceId, source] of Object.entries(state.sources)) {
    for (const [date, payload] of Object.entries(source.days ?? {})) {
      const entry: LocationSourceSegments = { sourceId, segments: payload.segments ?? [] };
      const existing = index.get(date);
      if (existing === undefined) index.set(date, [entry]);
      else existing.push(entry);
    }
  }
  return index;
}

export function locationTagPolicy(config: LocationConfig): LocationTagPolicy {
  return {
    minimumOverlapSeconds: config.minimumOverlapSeconds,
    minimumConfidence: config.minimumConfidence,
    retainCoordinates: config.retainCoordinates,
  };
}

/** Every tagging path is off unless BOTH gates are on. */
export function locationTaggingEnabled(config: LocationConfig): boolean {
  return config.enabled && config.tagging.enabled;
}

/**
 * Write-time post-persist hook (issue #2046): tag the memories an extraction
 * batch just made durable. Best-effort by contract — gated on both location
 * gates, and a location failure must never fail the extraction that already
 * persisted.
 */
export async function tagPersistedMemories(
  storage: StorageManager,
  memoryIds: string[],
  config: { memoryDir: string; location?: LocationConfig },
): Promise<void> {
  if (memoryIds.length === 0 || !config.location || !locationTaggingEnabled(config.location)) return;
  try {
    await enrichMemoriesWithLocation({
      storage,
      memoryIds,
      memoryDir: config.memoryDir,
      config: config.location,
    });
  } catch (locationError) {
    log.warn("[location] post-write tagging failed (non-fatal)", locationError);
  }
}

function segmentsForDays(index: DaySegmentIndex, days: readonly string[]): LocationSourceSegments[] {
  const merged = new Map<string, LocationSourceSegments>();
  for (const day of days) {
    for (const entry of index.get(day) ?? []) {
      const existing = merged.get(entry.sourceId);
      if (existing === undefined) {
        merged.set(entry.sourceId, { sourceId: entry.sourceId, segments: [...entry.segments] });
        continue;
      }
      existing.segments.push(...entry.segments);
    }
  }
  return [...merged.values()];
}

/** The full plan for one memory: window → segments → match → provider-owned diff. */
function planForMemory(
  frontmatter: Pick<MemoryFile["frontmatter"], "valid_at" | "observedAt" | "invalid_at" | "tags" | "structuredAttributes">,
  index: DaySegmentIndex,
  config: LocationConfig,
): LocationUpdatePlan {
  const policy = locationTagPolicy(config);
  const result = memoryLocationWindow(frontmatter, (instant) => localDayKey(instant, config.timezone));
  if (result.rejected === "span-too-long") return { outcome: "span-too-long" };
  if (result.rejected === "untimed" || result.window === undefined || result.days === undefined) {
    return { outcome: "untimed" };
  }
  const sources = segmentsForDays(index, result.days);
  return planLocationUpdate(frontmatter, matchDominantPlace(result.window, sources, policy), policy);
}

export interface LocationEnrichmentCounts {
  tagged: number;
  updated: number;
  removed: number;
  unchanged: number;
  unmatched: number;
  manual: number;
  untimed: number;
  spanTooLong: number;
  failed: number;
}

export function emptyEnrichmentCounts(): LocationEnrichmentCounts {
  return {
    tagged: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    unmatched: 0,
    manual: 0,
    untimed: 0,
    spanTooLong: 0,
    failed: 0,
  };
}

function countOutcome(counts: LocationEnrichmentCounts, outcome: LocationUpdatePlan["outcome"]): void {
  if (outcome === "tagged") counts.tagged += 1;
  else if (outcome === "updated") counts.updated += 1;
  else if (outcome === "removed") counts.removed += 1;
  else if (outcome === "unchanged") counts.unchanged += 1;
  else if (outcome === "manual-metadata") counts.manual += 1;
  else if (outcome === "unmatched") counts.unmatched += 1;
  else if (outcome === "untimed") counts.untimed += 1;
  else if (outcome === "span-too-long") counts.spanTooLong += 1;
}

export interface EnrichMemoriesOptions {
  storage: Pick<StorageManager, "getMemoryById" | "writeMemoryFrontmatter">;
  memoryDir: string;
  config: LocationConfig;
  /** Enrich exactly these memory ids (write-time path). */
  memoryIds?: string[];
  /** Pre-loaded memories (backfill path — one readAllMemories per run). */
  memories?: MemoryFile[];
  /** Reuse a caller-loaded segment index (backfill). */
  index?: DaySegmentIndex;
  /** Skip every mutation and only report (dry-run). */
  dryRun?: boolean;
}

/**
 * Apply the matcher to a set of memories and patch provider-owned location
 * metadata. A failure on ONE memory is counted and skipped — it never blocks
 * the others (failure isolation, issue #2046).
 */
export async function enrichMemoriesWithLocation(
  options: EnrichMemoriesOptions,
): Promise<LocationEnrichmentCounts> {
  if (!locationTaggingEnabled(options.config)) return emptyEnrichmentCounts();
  const counts = emptyEnrichmentCounts();
  const index = options.index ?? (await loadDaySegmentIndex(options.memoryDir));

  let memories = options.memories;
  if (memories === undefined && options.memoryIds !== undefined) {
    memories = [];
    for (const id of options.memoryIds) {
      const memory = await options.storage.getMemoryById(id);
      if (memory !== null) memories.push(memory);
    }
  }
  if (memories === undefined) return counts;

  for (const memory of memories) {
    try {
      const plan = planForMemory(memory.frontmatter, index, options.config);
      // Count patch outcomes (tagged/updated/removed) only after the write
      // lands — a rejected write is `failed`, never also `tagged`.
      if (plan.patch === undefined || options.dryRun === true) {
        countOutcome(counts, plan.outcome);
        continue;
      }
      await options.storage.writeMemoryFrontmatter(memory, plan.patch, { actor: "location-tagging" });
      countOutcome(counts, plan.outcome);
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

/**
 * Fill `WearableConversation.location` for conversations whose source did not
 * provide one. Missing-only and source-aware: a provider-supplied value is
 * never overwritten, and a failing conversation never blocks the others.
 */
export async function fillWearableConversationLocations(
  conversations: WearableConversation[],
  deps: { memoryDir: string; config: LocationConfig },
): Promise<void> {
  if (!locationTaggingEnabled(deps.config) || conversations.length === 0) return;
  let index: DaySegmentIndex;
  try {
    index = await loadDaySegmentIndex(deps.memoryDir);
  } catch {
    return;
  }
  const policy = locationTagPolicy(deps.config);
  for (const conversation of conversations) {
    if (conversation.location !== undefined && conversation.location.length > 0) continue;
    try {
      const startMs = Date.parse(conversation.startIso);
      const endMs = conversation.endIso !== undefined ? Date.parse(conversation.endIso) : Number.NaN;
      const window =
        Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
          ? { kind: "interval" as const, startUtc: conversation.startIso, endUtc: conversation.endIso as string }
          : { kind: "instant" as const, atUtc: conversation.startIso };
      const anchor = window.kind === "interval" ? new Date(Date.parse(window.endUtc) - 1).toISOString() : window.atUtc;
      const days = [...new Set([localDayKey(anchor, deps.config.timezone), localDayKey(conversation.startIso, deps.config.timezone)])];
      const outcome = matchDominantPlace(window, segmentsForDays(index, days), policy);
      if (outcome.status === "matched") {
        conversation.location = outcome.match.place.label;
      }
    } catch {
      // One bad conversation never blocks the rest of the day's fill.
    }
  }
}

/** Render an opt-in, labels-only location context section for a day summary. */
export async function renderDayLocationContext(
  memoryDir: string,
  date: string,
  config: LocationConfig,
): Promise<string | null> {
  if (!locationTaggingEnabled(config)) return null;
  const state = await loadLocationSyncState(memoryDir);
  const segments = [];
  for (const source of Object.values(state.sources)) {
    for (const segment of source.days?.[date]?.segments ?? []) segments.push(segment);
  }
  if (segments.length === 0) return null;
  const durations = placeDurations(segments)
    .filter((duration) => ["home", "work", "poi"].includes(duration.place.kind ?? "poi"))
    .sort((a, b) => (a.totalMs !== b.totalMs ? b.totalMs - a.totalMs : a.place.id < b.place.id ? -1 : 1));
  if (durations.length === 0) return null;
  const lines = durations.map((duration) => {
    const minutes = Math.round(duration.totalMs / 60_000);
    const hours = Math.floor(minutes / 60);
    const rendered = hours <= 0 ? `${minutes}m` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
    return `- ${duration.place.label.replace(/\s+/g, " ").replace(/[`*_]/g, "").trim()}: ${rendered}`;
  });
  return `## Location context\n\n${lines.join("\n")}`;
}

/**
 * Location context for a briefing (issue #2925): the place names of the
 * local day containing the briefing window's start, bucketed in the
 * location config's own timezone (the store's bucketing zone). Opt-in and
 * labels-only — the caller decides whether to include it.
 */
export async function briefingLocationSection(
  memoryDir: string,
  windowStartUtc: string,
  config: LocationConfig,
): Promise<string | null> {
  return renderDayLocationContext(
    memoryDir,
    localDayKey(windowStartUtc, config.timezone),
    config,
  );
}
