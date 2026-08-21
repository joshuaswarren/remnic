/** Package-wide constants for @remnic/capture-screen. */

/**
 * Reported by GET /v1/health. Kept in sync with package.json by the release
 * tooling; the health endpoint tolerates drift because the connector never
 * gates on an exact match (it reads `ok`).
 */
export const CAPTURE_SCREEN_VERSION = "9.14.0";

/** Loopback default; capture is local-first (charter). */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4341;

/** Spool schema version, persisted in the `meta` table. */
export const SPOOL_SCHEMA_VERSION = 1;

/** Upper bound for the snapshots `limit` query parameter. */
export const MAX_SNAPSHOTS_LIMIT = 500;
/** Default page size when `limit` is omitted. */
export const DEFAULT_SNAPSHOTS_LIMIT = 100;

/** Default capture-time processing knobs (all overridable in config). */
export const DEFAULT_SPOOL_RETENTION_DAYS = 14;
export const DEFAULT_SIMHASH_THRESHOLD = 10;
export const DEFAULT_DEDUP_TTL_SECONDS = 60;
/** Two snapshots of the same window within this gap belong to one session. */
export const DEFAULT_SESSION_GAP_SECONDS = 300;
/** AX-tree traversal cap (nodes) — bounds pathological accessibility trees. */
export const DEFAULT_MAX_NODES = 4000;
/** Per-snapshot dwell cap for /v1/stats time attribution. */
export const DEFAULT_MAX_DWELL_SECONDS = 300;
/** Live capture loop cadence (#1899 Part 1; all overridable in config). */
/** How often the loop polls the frontmost AX snapshot for a change. */
export const DEFAULT_POLL_INTERVAL_MS = 1000;
/** Foreground must be stable this long after a change before a snapshot is stored. */
export const DEFAULT_SETTLE_MS = 500;
/** Re-sample an unchanging foreground at least this often (dedup drops repeats). */
export const DEFAULT_IDLE_FALLBACK_SECONDS = 30;
