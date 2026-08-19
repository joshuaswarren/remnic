/**
 * Screen-activity subsystem — shared types (issue #1899).
 *
 * A third ingestion modality alongside wearables (conversations) and live
 * connectors (documents). Screen text has no speakers and is high-volume, so it
 * gets its own store and day-digest rather than being forced into the wearable
 * conversation shape. Capture daemons live in the à-la-carte `@remnic/capture-screen`
 * package; this core subsystem is host-agnostic and consumes snapshots over a
 * loopback HTTP client.
 *
 * All timestamps are UTC ISO-8601; day bucketing is half-open [start, end).
 */

import type { ImportanceLevel } from "../types.js";

export type ActivityExtractionMode = "off" | "smart";

/** One captured on-screen text snapshot (a single window at a single instant). */
export interface ActivitySnapshot {
  /** Store row id (assigned on insert; absent before persistence). */
  id?: number;
  /** Capture-machine label (disambiguates multi-machine stores). */
  machine: string;
  /** UTC ISO-8601 capture instant. */
  capturedAtUtc: string;
  /** Frontmost application name. */
  app: string;
  /** Frontmost window title. */
  windowTitle: string;
  /** Browser tab URL, when the frontmost window is a known browser. */
  browserUrl?: string;
  /** Extracted visible text (accessibility tree or OCR). */
  text: string;
  /** Where the text came from. */
  textSource: "ax" | "ocr";
  /** SHA-256 of the normalized snapshot content (idempotency key). */
  contentHash: string;
  /** 64-bit SimHash (hex) for near-duplicate detection, when computed. */
  simhash?: string;
}

/** Frontmatter persisted on a rendered day digest. */
export interface ActivityDayMeta {
  kind: "activity-digest";
  /** Local day, YYYY-MM-DD. */
  date: string;
  /** Machines that contributed snapshots, sorted. */
  machines: string[];
  snapshotCount: number;
  /** SHA-256 of the rendered body (rebuild-idempotency). */
  contentHash: string;
  formatVersion: number;
}

/** A parsed day digest (frontmatter + rendered body). */
export interface ActivityDayDigest {
  meta: ActivityDayMeta;
  body: string;
}

/** Result of a capture-daemon auth/health probe. */
export interface ActivitySourceCheck {
  ok: boolean;
  detail?: string;
}

/** One page of snapshots pulled from a capture daemon. */
export interface ActivitySnapshotPage {
  snapshots: ActivitySnapshot[];
  nextCursor: string | null;
}

/**
 * Client contract for a screen-capture daemon (one per capture machine).
 * Implemented by a later slice (the HTTP source client); defined here so the
 * store and pipeline can be built and tested against a fixture double first.
 */
export interface ActivitySourceClient {
  /** Stable capture-machine label. */
  machineLabel: string;
  /** Probe connectivity/auth without mutating anything. */
  verify(signal?: AbortSignal): Promise<ActivitySourceCheck>;
  /** Fetch one page of snapshots for a single local day. */
  fetchSnapshots(opts: {
    date: string;
    timezone: string;
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<ActivitySnapshotPage>;
}

/** One trusted capture daemon that feeds this memory directory. */
export interface ActivitySourceConfig {
  machineLabel: string;
  baseUrl: string;
  token?: string;
}

/** Opt-in daily journal settings (issue #1984). Default off. */
export interface ActivityTimelineJournalConfig {
  enabled: boolean;
  /** Where the journal text is read from (issue #1987). */
  source: "file" | "vault";
  /** Vault section heading, trimmed. Required when `source` is `"vault"`; not stored in `"file"` mode. */
  heading?: string;
}

/** Opt-in timeline Q&A range/search settings (issue #1983 PR1). Default off. */
export interface ActivityTimelineQaConfig {
  enabled: boolean;
  /** Inclusive max half-open range length in 24h days. Integer 1..366. */
  maxRangeDays: number;
}

/** Opt-in timeline-card derivation settings (issue #2049). Default off. */
export interface ActivityTimelineConfig {
  enabled: boolean;
  journal: ActivityTimelineJournalConfig;
  qa: ActivityTimelineQaConfig;
}

/** Opt-in activity synchronization + trust-gated extraction settings. */
export interface ActivityConfig {
  enabled: boolean;
  timezone: string;
  syncDays: number;
  /** Periodic auto-sync cadence in minutes (default 15). */
  autoSyncIntervalMinutes: number;
  sources: ActivitySourceConfig[];
  /** `off` keeps activity searchable only; `smart` trust-gates durable first-person claims. */
  extractionMode: ActivityExtractionMode;
  /** Baseline confidence in activity as a source of the user's own actions. */
  sourceTrust: number;
  autoApproveTrust: number;
  reviewTrust: number;
  minConfidence: number;
  minImportance: ImportanceLevel;
  /** `0` means no count cap. */
  maxMemoriesPerDay: number;
  timeline: ActivityTimelineConfig;
}
