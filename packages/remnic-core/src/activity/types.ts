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
import type { JournalSource } from "./journal-source.js";

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

/** Opt-in daily journal settings (issue #1984; vault read-back #1987). Default off. */
export interface ActivityTimelineJournalConfig {
  enabled: boolean;
  /** Where the journal text is read from: the memoryDir day file (default) or the vault daily note. */
  source: JournalSource;
  /** Review-only journal extraction gate (issue #1987): "off" | "review". No auto mode by design. */
  extractionMode: ActivityJournalExtractionMode;
}

/** Journal extraction is review-only by design (#1984 decision): no "auto". */
export type ActivityJournalExtractionMode = "off" | "review";

/** Vault daily-note read-back settings (issue #1987). */
export interface ActivityTimelineVaultReadbackConfig {
  /** Heading whose section is the user's journal; arbitrary user-chosen text. */
  journalSection: string;
}

/** Section ownership strategy for vault publishing (issue #1985). */
export type VaultSectionStrategy = "markers" | "heading";

/** Where section stats are written (issue #1985). `off` writes none. */
export type VaultPropertiesMode = "off" | "frontmatter" | "dataview-inline";

export interface ActivityTimelineVaultTargetConfig {
  enabled: boolean;
  target: "daily" | "weekly";
  section: string;
}

/**
 * Opt-in markdown-vault publisher settings (issue #1985). Default off:
 * `enabled: false` means no vault reads or writes ever occur.
 */
export interface ActivityTimelineVaultConfig {
  enabled: boolean;
  /** Vault root; absolute or `~` path. Required and non-empty when enabled. */
  vaultPath: string;
  /** Vault-relative daily-note path template; date tokens. */
  dailyNotePath: string;
  /** Empty means weekly-note publishing is disabled. */
  weeklyNotePath: string;
  createMissingNotes: boolean;
  /** Vault-relative template file, used only when creating a missing note. */
  noteTemplate: string;
  sectionStrategy: VaultSectionStrategy;
  publish: {
    timeline: ActivityTimelineVaultTargetConfig;
    /** Standup target lights up when phase 3 lands. */
    standup: ActivityTimelineVaultTargetConfig;
    /** Weekly target lights up when phase 4 lands. */
    weekly: ActivityTimelineVaultTargetConfig;
    /** Locations target lights up with the location day renderer. */
    locations: ActivityTimelineVaultTargetConfig;
  };
  /** Markers strategy: heading under which missing marker pairs are inserted; empty = never insert. */
  insertUnderHeading: string;
  readback: ActivityTimelineVaultReadbackConfig;
  wikilinks: { places: boolean; placesFolder: string };
  properties: { mode: VaultPropertiesMode; prefix: string };
  autoPublish: boolean;
}

/** Opt-in timeline Q&A range/search settings (issue #1983 PR1). Default off. */
export interface ActivityTimelineQaConfig {
  enabled: boolean;
  /** Inclusive max half-open range length in 24h days. Integer 1..366. */
  maxRangeDays: number;
}

/**
 * Opt-in AI analysis over deterministic timeline cards (issue #2050).
 * Default off; gated independently of `activity.timeline.enabled`, capture,
 * and memory creation. When disabled, zero provider calls and zero analysis
 * artifacts occur.
 */
export interface ActivityTimelineAnalysisConfig {
  enabled: boolean;
  /**
   * Explicit provider id: `"local"` routes to the local LLM client; any other
   * identifier routes to the configured remote provider registry. Required
   * when enabled. A single provider segment only — `/` is rejected at parse.
   * At most 120 characters so accepted config cannot fail metadata validation.
   */
  provider?: string;
  /** Model id. Required when enabled. May include `/`. At most 120 characters. */
  model?: string;
  /** Per-request timeout in ms. Positive integer. */
  timeoutMs?: number;
  /** Free-form user preferences passed to the prompt (no secrets). */
  preferences?: string[];
}

/** Opt-in timeline-card derivation settings (issue #2049). Default off. */
export interface ActivityTimelineConfig {
  enabled: boolean;
  analysis: ActivityTimelineAnalysisConfig;
  journal: ActivityTimelineJournalConfig;
  qa: ActivityTimelineQaConfig;
  vault: ActivityTimelineVaultConfig;
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
