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
