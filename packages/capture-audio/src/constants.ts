/** Package-wide constants for @remnic/capture-audio. */

/**
 * Reported by GET /v1/health. Kept in sync with package.json by the
 * release tooling; the health endpoint tolerates drift because the
 * connector never gates on an exact match (it reads `ok`).
 */
export const CAPTURE_AUDIO_VERSION = "9.14.0";

/** Loopback default; capture is local-first (charter). */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4340;

/** Spool schema version, persisted in the `meta` table. */
export const SPOOL_SCHEMA_VERSION = 3;

/** Upper bound for the conversations `limit` query parameter. */
export const MAX_CONVERSATIONS_LIMIT = 500;
/** Default page size when `limit` is omitted. */
export const DEFAULT_CONVERSATIONS_LIMIT = 50;
