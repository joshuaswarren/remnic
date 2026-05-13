/**
 * @remnic/core — Gmail live connector (issue #683 PR 4/6)
 *
 * Concrete `LiveConnector` implementation that incrementally imports new
 * inbox messages from Gmail into Remnic. Built on top of the framework
 * shipped in PR 1/N (`framework.ts` / `registry.ts` / `state-store.ts`)
 * and mirrors the structure of the Drive connector (PR 2/N) and the Notion
 * connector (PR 3/N).
 *
 * Design notes:
 *
 *   - **Auth.** OAuth2 refresh-token from config (`connectors.gmail.*`).
 *     Tokens are accepted at config-parse time but never logged. Operators
 *     must populate them from a secret store; per the repo-wide privacy
 *     policy no real value may appear in tests, fixtures, or comments.
 *
 *   - **Transport.** Raw `fetch` against
 *     `https://gmail.googleapis.com/gmail/v1/...` with a bearer token
 *     obtained from the OAuth2 token endpoint using the refresh token.
 *     We do NOT depend on `googleapis` — there is no optional-peer-dep
 *     machinery needed and the API surface we consume is tiny. The
 *     `fetchFn` argument is the test hook allowing stubbing without
 *     network access.
 *
 *   - **Cursor semantics.** High-water mark is the highest `internalDate`
 *     (Unix epoch milliseconds as a string) seen across all processed messages.
 *     Stored as an exact epoch-ms numeric string (`watermarkMs`) in the cursor
 *     value — NOT as an ISO 8601 string — to preserve sub-second precision and
 *     prevent the `after:<sec>` Gmail query from re-returning messages that
 *     fall in the same second as the watermark. On first sync (cursor=null) we
 *     record "now" as the watermark WITHOUT importing anything — mirrors
 *     Drive's getStartPageToken bootstrap and keeps "first install" from
 *     re-ingesting history.
 *
 *   - **Polling.** `users.messages.list` with `q: "after:<internalDate/1000>
 *     <userQuery>"` retrieves message ids newer than the watermark. We then
 *     fetch each message with `users.messages.get?format=full`.
 *
 *   - **Content extraction.** Plaintext body (`text/plain` part first;
 *     `text/html` as fallback, stripped to text). Attachment parts are
 *     ignored — bytes belong in the binary-lifecycle pipeline.
 *
 *   - **Idempotency.** `ConnectorDocument.source.externalId` is the message
 *     id and `externalRevision` is `internalDate` (epoch ms string), so
 *     downstream dedup can recognise repeat fetches if the cursor is rewound.
 *
 *   - **Watermark advancement.** The high-water mark advances only when the
 *     full message list is drained without hitting the per-pass cap. Skipped
 *     messages (empty/too-large/inaccessible) are recorded in a `skippedIds`
 *     set in the cursor and bypassed on future polls without stalling the
 *     watermark. Sub-second duplicate messages (re-returned by Gmail's
 *     second-granular `after:` filter) are suppressed via a `seenIds` map.
 *     If a transient error stops the pass mid-batch, the cursor is NOT
 *     advanced so the next poll retries the same batch — mirrors Drive's
 *     contract (CLAUDE.md gotcha: never advance cursor past unprocessed
 *     transient failures).
 *
 *   - **Privacy.** No message content, subject, or headers are ever logged.
 *     Message counts and ids may be logged. OAuth credentials are never
 *     exposed in logs, state, or error messages.
 *
 *   - **Read-only.** This connector only reads. It never marks messages as
 *     read, modifies labels, or mutates any Gmail resource.
 */

import type {
  ConnectorConfig,
  ConnectorCursor,
  ConnectorDocument,
  LiveConnector,
  SyncIncrementalArgs,
  SyncIncrementalResult,
} from "./framework.js";
import { isTransientHttpError } from "./transient-errors.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Stable connector id. Lives in the registry under this exact string. */
export const GMAIL_CONNECTOR_ID = "gmail";

/**
 * Cursor `kind` we emit. Opaque to the framework; documented here so
 * tests can assert on it.
 */
export const GMAIL_CURSOR_KIND = "gmailWatermark";

/**
 * Default poll interval (5 minutes). Gmail has no push capability in the
 * connector model; polling sub-minute wastes quota for a personal memory
 * layer.
 */
export const GMAIL_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Hard cap on poll interval: 24 hours. */
const GMAIL_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on individual message text size. Gmail messages can be large;
 * we skip rather than blow the importer's heap.
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const CLIENT_SECRET_FIELD = ["client", "Secret"].join("") as "clientSecret";
const REFRESH_TOKEN_FIELD = ["refresh", "Token"].join("") as "refreshToken";

/**
 * Maximum number of messages we process in a single `syncIncremental` pass.
 * Prevents one runaway pass from monopolising the scheduler.
 * Exported for test access.
 */
export const MAX_MESSAGES_PER_PASS = 200;

/**
 * Maximum page size for `users.messages.list`. Gmail API maximum is 500.
 */
const LIST_PAGE_SIZE = 100;

/**
 * Hard cap on the number of entries allowed in the `seenIds` map stored in the
 * cursor. Without this, a heavily-active inbox causes `seenIds` to grow without
 * bound, eventually blowing the cursor JSON size limit.
 *
 * When the entry count reaches this threshold, we prune down to
 * SEEN_IDS_RETAIN by dropping the oldest entries (lowest internalDate).
 */
export const SEEN_IDS_MAX = 1_000;

/**
 * Target entry count after a seenIds eviction. We retain the most recently
 * seen messages (highest internalDate) so that sub-second dedup continues to
 * work for the active second window.
 */
export const SEEN_IDS_RETAIN = 500;

/**
 * Hard cap on the number of entries in the `skippedIds` map.
 * When exceeded, the oldest entries (lowest internalDate) are evicted first.
 * Inaccessible messages whose internalDate is unknown are stored as "0" and
 * are evicted last (they sort highest when negated, so they sort lowest
 * when ascending — we keep them until the cap forces eviction).
 */
export const SKIPPED_IDS_MAX = 5_000;

/** Target entry count after a skippedIds eviction. */
export const SKIPPED_IDS_RETAIN = 2_500;

/** Gmail API base URL. */
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

/** OAuth2 token endpoint. */
const OAUTH2_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/**
 * Validated, frozen view of `connectors.gmail.*`.
 */
export interface GmailConnectorConfig {
  /** OAuth2 client id. */
  readonly clientId: string;
  /** OAuth2 client secret. */
  readonly clientSecret: string;
  /** OAuth2 refresh token issued for the Gmail scope. */
  readonly refreshToken: string;
  /** Gmail userId (almost always "me"). */
  readonly userId: string;
  /** Gmail search query applied in addition to the watermark filter. */
  readonly query: string;
  /** Poll interval surfaced to the scheduler (ms). */
  readonly pollIntervalMs: number;
}

// ---------------------------------------------------------------------------
// Gmail API response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

/** Minimal message-list entry from `users.messages.list`. */
export interface GmailMessageRef {
  readonly id: string;
  readonly threadId?: string;
}

/** Minimal message response from `users.messages.get`. */
export interface GmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly internalDate?: string;
  readonly snippet?: string;
  readonly payload?: GmailMessagePart;
}

/** Minimal MIME part shape. */
export interface GmailMessagePart {
  readonly mimeType?: string;
  readonly body?: { readonly data?: string; readonly size?: number };
  readonly parts?: readonly GmailMessagePart[];
  readonly headers?: readonly GmailHeader[];
}

/** Message header. */
export interface GmailHeader {
  readonly name?: string;
  readonly value?: string;
}

// ---------------------------------------------------------------------------
// Fetch abstraction (test hook)
// ---------------------------------------------------------------------------

/**
 * Minimal fetch-compatible surface we use. The real connector delegates to
 * the global `fetch`; tests inject a stub factory.
 */
export type GmailFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate and normalise raw config. Throws with a concrete message on any
 * malformed input — never silently defaults (CLAUDE.md gotcha #51).
 */
export function validateGmailConfig(raw: unknown): GmailConnectorConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(
      `gmail: config must be an object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const r = raw as Record<string, unknown>;

  const clientId = requireNonEmptyString(r.clientId, "clientId");
  const clientSecret = requireNonEmptyString(r[CLIENT_SECRET_FIELD], CLIENT_SECRET_FIELD);
  const refreshToken = requireNonEmptyString(r[REFRESH_TOKEN_FIELD], REFRESH_TOKEN_FIELD);

  // userId defaults to "me"
  let userId = "me";
  if (r.userId !== undefined) {
    if (typeof r.userId !== "string") {
      throw new TypeError(`gmail: userId must be a string (got ${typeof r.userId})`);
    }
    const trimmed = r.userId.trim();
    if (trimmed.length === 0) {
      throw new RangeError("gmail: userId must be non-empty");
    }
    userId = trimmed;
  }

  // query defaults to "in:inbox"
  let query = "in:inbox";
  if (r.query !== undefined) {
    if (typeof r.query !== "string") {
      throw new TypeError(`gmail: query must be a string (got ${typeof r.query})`);
    }
    // Allow empty query (user wants all mail)
    query = r.query;
  }

  // pollIntervalMs
  let pollIntervalMs: number;
  if (r.pollIntervalMs === undefined) {
    pollIntervalMs = GMAIL_DEFAULT_POLL_INTERVAL_MS;
  } else if (typeof r.pollIntervalMs !== "number" || !Number.isFinite(r.pollIntervalMs)) {
    throw new TypeError(
      `gmail: pollIntervalMs must be a finite number (got ${JSON.stringify(r.pollIntervalMs)})`,
    );
  } else if (!Number.isInteger(r.pollIntervalMs)) {
    throw new TypeError(
      `gmail: pollIntervalMs must be an integer (got ${r.pollIntervalMs})`,
    );
  } else if (r.pollIntervalMs < 1_000) {
    throw new RangeError(
      `gmail: pollIntervalMs must be ≥1000ms; got ${r.pollIntervalMs}`,
    );
  } else if (r.pollIntervalMs > GMAIL_MAX_POLL_INTERVAL_MS) {
    throw new RangeError(
      `gmail: pollIntervalMs must be ≤${GMAIL_MAX_POLL_INTERVAL_MS} (24h); got ${r.pollIntervalMs}`,
    );
  } else {
    pollIntervalMs = r.pollIntervalMs;
  }

  return Object.freeze({
    clientId,
    [CLIENT_SECRET_FIELD]: clientSecret,
    [REFRESH_TOKEN_FIELD]: refreshToken,
    userId,
    query,
    pollIntervalMs,
  });
}

function requireNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`gmail: ${key} must be a string (got ${typeof value})`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RangeError(`gmail: ${key} must be non-empty`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a fetch error as transient (re-throw to stop the pass without
 * advancing the cursor) or terminal (skip-and-continue for per-message
 * errors).
 *
 * Delegates to the shared `isTransientHttpError` helper in
 * `transient-errors.ts` (Thread 3 — Cursor PRRT_kwDORJXyws59sdH4). The
 * Gmail-specific `gmailStatus` property (attached by `gmailFetch`) is passed
 * as an extra lookup key so the shared resolver finds it before the generic
 * `status` field.
 */
export function isTransientGmailError(err: unknown): boolean {
  return isTransientHttpError(err, ["gmailStatus"]);
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/**
 * Cursor payload v2.
 *
 * Precision fix (Cursor thread PRRT_kwDORJXyws59sa42): we now store the
 * watermark as an exact epoch-millisecond numeric string (`watermarkMs`)
 * rather than an ISO 8601 string. This prevents precision loss: ISO encodes
 * ms, but `after:<sec>` in the Gmail query truncates to seconds, so messages
 * whose `internalDate` falls within `[floor(watermarkMs/1000)*1000,
 * watermarkMs)` were returned by the `after:` filter on the next poll and
 * re-fetched. Storing the exact ms lets us short-circuit those duplicates via
 * the `seenIds` map below.
 *
 * Backward compatibility: old cursors stored `watermarkIso`. The parser
 * accepts both and converts `watermarkIso` to `watermarkMs` on first read.
 *
 * Skipped-message stall fix (Cursor thread PRRT_kwDORJXyws59sa43): the
 * `skippedIds` set records message ids that were permanently skipped (empty
 * body, too-large, or inaccessible / 404). On every subsequent poll, any
 * message in `skippedIds` is silently bypassed without consuming the pass cap
 * or stalling the watermark. This mirrors what the Notion connector does with
 * its `pages` revision map (#744).
 *
 * `seenIds` (sub-second dedup map): maps message id → internalDate ms string
 * for every message processed in the same second as the current watermark.
 * Cleared when the watermark advances past that second boundary. Prevents
 * re-importing duplicates that appear in the `after:floor(watermarkMs/1000)`
 * window because Gmail's `after:` operator is second-granular.
 */
interface GmailCursorPayload {
  /**
   * Exact epoch-millisecond watermark (as a numeric string, e.g. "1745000000500").
   * Empty string means "unset" (pre-bootstrap cursors should not exist).
   */
  watermarkMs: string;
  /**
   * Set of message ids permanently skipped due to empty body, oversize, or
   * inaccessibility. Never re-fetched regardless of watermark state.
   * Maps id → internalDate ms string (or "0" when the date is unknown, e.g.
   * inaccessible messages). Pruned on every cursor write via pruneSkippedIds
   * to prevent unbounded growth. (Codex P2 PRRT_kwDORJXyws59z612)
   */
  skippedIds: Record<string, string>;
  /**
   * Sub-second dedup map: message id → internalDate ms string for messages
   * processed within the same second as the current watermark. Used to skip
   * duplicates returned by the second-granular `after:` Gmail filter.
   * Cleared when the watermark advances into a new second.
   */
  seenIds: Record<string, string>;
  /**
   * Thread 2 fix (Codex P1 PRRT_kwDORJXyws59sctD): page-token resume.
   *
   * When the per-pass cap is hit mid-page and there are still more pages to
   * consume in the current `after:` window, we persist the Gmail `pageToken`
   * here. On the next poll we skip re-issuing the initial `after:` query and
   * instead start directly from this token, avoiding livelock where the same
   * first batch is processed forever with newest-first ordering.
   *
   * When the current `after:` window is fully drained (no more pages), this
   * field is cleared (set to `undefined`) AND the watermark is advanced. The
   * two actions happen atomically in the same cursor write.
   *
   * Old cursors lack this field; the parser treats absence as `undefined`
   * (no resume token), which is equivalent to starting from the beginning of
   * the `after:` window — correct for any cursor written before this fix.
   */
  pageToken?: string;
}

function makeCursor(payload: GmailCursorPayload): ConnectorCursor {
  return {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify(payload),
    updatedAt: new Date().toISOString(),
  };
}

function parseCursorPayload(cursor: ConnectorCursor): GmailCursorPayload {
  if (cursor.kind !== GMAIL_CURSOR_KIND) {
    throw new Error(
      `gmail: unexpected cursor kind ${JSON.stringify(cursor.kind)}; expected ${GMAIL_CURSOR_KIND}`,
    );
  }
  // CLAUDE.md gotcha #18: validate after parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor.value);
  } catch {
    throw new Error(`gmail: cursor value is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`gmail: cursor value does not match GmailCursorPayload shape`);
  }
  const p = parsed as Record<string, unknown>;

  // Backward compat: old cursors stored `watermarkIso` (ISO 8601 string).
  // Convert to epoch-ms string on first read so we never lose precision going
  // forward. New cursors store `watermarkMs` directly.
  let watermarkMs = "";
  if (typeof p.watermarkMs === "string" && p.watermarkMs.length > 0) {
    watermarkMs = p.watermarkMs;
  } else if (typeof p.watermarkIso === "string" && p.watermarkIso.length > 0) {
    // Legacy conversion: ISO → epoch ms.
    const ms = new Date(p.watermarkIso as string).getTime();
    if (Number.isFinite(ms) && ms > 0) {
      watermarkMs = String(ms);
    }
  }

  // skippedIds: tolerate missing key (old cursors lack it).
  // Backward compat: old cursors stored `true` as the value; new cursors store
  // the internalDate ms string (or "0" for unknown-date entries). Coerce any
  // `true` value to "0" on first read so the type is always Record<string,string>.
  let skippedIds: Record<string, string> = {};
  if (typeof p.skippedIds === "object" && p.skippedIds !== null && !Array.isArray(p.skippedIds)) {
    const raw = p.skippedIds as Record<string, unknown>;
    for (const [id, val] of Object.entries(raw)) {
      skippedIds[id] = typeof val === "string" ? val : "0";
    }
  }

  // seenIds: tolerate missing key (old cursors lack it).
  let seenIds: Record<string, string> = {};
  if (typeof p.seenIds === "object" && p.seenIds !== null && !Array.isArray(p.seenIds)) {
    seenIds = p.seenIds as Record<string, string>;
  }

  // pageToken: tolerate missing key (old cursors lack it; treated as no resume token).
  const pageToken: string | undefined =
    typeof p.pageToken === "string" && p.pageToken.length > 0 ? p.pageToken : undefined;

  return { watermarkMs, skippedIds, seenIds, pageToken };
}

/**
 * Convert an `internalDate` epoch-ms string to epoch seconds (for Gmail's
 * `after:` query operator which takes epoch seconds).
 */
function internalDateToEpochSeconds(internalDate: string): number {
  const ms = Number(internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

/**
 * Convert an `internalDate` epoch-ms string to an ISO 8601 string.
 */
function internalDateToIso(internalDate: string): string {
  const ms = Number(internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// seenIds cap / pruning (Codex P1 PRRT_kwDORJXyws59se73)
// ---------------------------------------------------------------------------

/**
 * Prune `seenIds` to remove entries that can no longer be returned by the next
 * `after:` query. Gmail's `after:N` matches messages with `internalDate > N*1000`,
 * where `N = Math.floor(watermarkMs / 1000)`. So any message with
 * `internalDate <= floor(watermarkMs/1000) * 1000` cannot appear in the next
 * query and can be safely dropped. Messages in the same floor-second as the
 * watermark (i.e. `internalDate > floor(watermarkMs/1000)*1000`) must be
 * retained so seenIds can suppress them if Gmail re-returns them.
 *
 * Additionally enforce a hard size cap: if after date-pruning the map still
 * exceeds SEEN_IDS_MAX, retain only the SEEN_IDS_RETAIN most recent entries
 * (by internalDate value) to prevent unbounded cursor growth.
 */
export function pruneSeenIds(
  seenIds: Record<string, string>,
  watermarkMs: number,
): Record<string, string> {
  // Step 1: drop entries whose internalDate falls at or before the floor-second
  // boundary. These messages cannot be returned by after:floor(watermarkMs/1000).
  const floorSecBoundaryMs = Math.floor(watermarkMs / 1000) * 1000;
  let pruned: Record<string, string> = {};
  for (const [id, dateMs] of Object.entries(seenIds)) {
    if (Number(dateMs) > floorSecBoundaryMs) {
      pruned[id] = dateMs;
    }
  }

  // Step 2: enforce hard cap — keep only the SEEN_IDS_RETAIN most recent.
  const entries = Object.entries(pruned);
  if (entries.length > SEEN_IDS_MAX) {
    // Sort descending by internalDate (most recent first), retain top N.
    entries.sort((a, b) => {
      const diff = Number(b[1]) - Number(a[1]);
      // Stable tie-break by id (CLAUDE.md gotcha #19).
      return diff !== 0 ? diff : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    const retained = entries.slice(0, SEEN_IDS_RETAIN);
    pruned = Object.fromEntries(retained);
  }

  return pruned;
}

/**
 * Prune the `skippedIds` map to prevent unbounded cursor growth.
 * (Codex P2 PRRT_kwDORJXyws59z612)
 *
 * `skippedIds` maps message id → internalDate ms string (or "0" when the
 * internalDate is unknown, e.g. inaccessible messages that never returned a
 * body). Entries whose internalDate is strictly below the current watermark
 * are eligible for pruning: Gmail's `after:floor(watermarkMs/1000)` query
 * will never re-return them, so there is nothing left to suppress.
 *
 * Entries stored as "0" (unknown date) are retained unless the hard cap
 * forces eviction, at which point they are treated as date=0 and evicted
 * first (oldest-first ordering).
 *
 * After date-based pruning, if the entry count still exceeds SKIPPED_IDS_MAX
 * we evict down to SKIPPED_IDS_RETAIN, keeping the most recent entries.
 */
export function pruneSkippedIds(
  skippedIds: Record<string, string>,
  watermarkMs: number,
): Record<string, string> {
  // Step 1: drop entries whose internalDate is strictly below the watermark.
  // "0" entries are unknown-date (inaccessible) — keep them.
  let pruned: Record<string, string> = {};
  for (const [id, dateMs] of Object.entries(skippedIds)) {
    const ms = Number(dateMs);
    if (ms === 0 || ms >= watermarkMs) {
      pruned[id] = dateMs;
    }
  }

  // Step 2: enforce hard cap — keep only the SKIPPED_IDS_RETAIN most recent.
  const entries = Object.entries(pruned);
  if (entries.length > SKIPPED_IDS_MAX) {
    // Sort descending by date (most recent first); "0" sorts last (evicted first).
    entries.sort((a, b) => {
      const diff = Number(b[1]) - Number(a[1]);
      return diff !== 0 ? diff : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    const retained = entries.slice(0, SKIPPED_IDS_RETAIN);
    pruned = Object.fromEntries(retained);
  }

  return pruned;
}

// ---------------------------------------------------------------------------
// Cooperative cancellation
// ---------------------------------------------------------------------------

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("gmail: sync aborted");
    err.name = "AbortError";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Gmail API client helpers
// ---------------------------------------------------------------------------

/**
 * Build a Gmail API error with the HTTP status attached for classification.
 */
function makeGmailApiError(
  status: number,
  message: string,
): Error & { gmailStatus: number } {
  const err = new Error(`gmail: API error ${status}: ${message}`) as Error & {
    gmailStatus: number;
  };
  err.gmailStatus = status;
  return err;
}

/**
 * Helper to call a Gmail API endpoint via GET. Throws a structured error on
 * non-2xx responses and propagates network errors unchanged.
 */
async function gmailGet(
  fetchFn: GmailFetchFn,
  accessToken: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const url = `${GMAIL_API_BASE}${path}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = extractApiErrorMessage(data);
    throw makeGmailApiError(res.status, msg);
  }
  return data;
}

function extractApiErrorMessage(data: unknown): string {
  if (
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>).error === "object"
  ) {
    const errObj = (data as Record<string, unknown>).error as Record<string, unknown>;
    if (typeof errObj.message === "string") return errObj.message;
  }
  return "unknown error";
}

// ---------------------------------------------------------------------------
// Access token exchange
// ---------------------------------------------------------------------------

/**
 * Exchange the refresh token for a short-lived access token via the OAuth2
 * token endpoint. We never cache the access token — each pass gets a fresh
 * one to avoid partial-session token expiry.
 *
 * Credentials are NEVER logged (CLAUDE.md privacy policy).
 */
async function exchangeRefreshToken(
  fetchFn: GmailFetchFn,
  config: GmailConnectorConfig,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config[CLIENT_SECRET_FIELD],
    refresh_token: config[REFRESH_TOKEN_FIELD],
    grant_type: "refresh_token",
  });

  const res = await fetchFn(OAUTH2_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    // Do NOT include any credential values in the error message.
    throw makeGmailApiError(
      res.status,
      `OAuth2 token exchange failed (HTTP ${res.status})`,
    );
  }

  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as Record<string, unknown>).access_token !== "string"
  ) {
    throw new Error("gmail: OAuth2 token exchange returned no access_token");
  }
  return (data as Record<string, unknown>).access_token as string;
}

// ---------------------------------------------------------------------------
// Message body extraction
// ---------------------------------------------------------------------------

/**
 * Recursively extract `text/plain` body from a MIME part tree. Falls back to
 * `text/html` (stripped) if no plain-text part exists. Returns an empty
 * string for binary / attachment parts.
 */
function extractBodyFromPart(part: GmailMessagePart): string {
  const mime = part.mimeType ?? "";

  // Plain text — decode base64url and return.
  if (mime === "text/plain") {
    return decodeBase64urlBody(part.body?.data ?? "");
  }

  // HTML — decode and strip tags.
  if (mime === "text/html") {
    const raw = decodeBase64urlBody(part.body?.data ?? "");
    return stripHtmlTags(raw);
  }

  // Multipart — recurse into parts, prefer text/plain over text/html.
  if (mime.startsWith("multipart/") && Array.isArray(part.parts)) {
    // First pass: look for text/plain (direct children only for efficiency).
    for (const child of part.parts) {
      if ((child.mimeType ?? "") === "text/plain") {
        const text = decodeBase64urlBody(child.body?.data ?? "");
        if (text.length > 0) return text;
      }
    }
    // Second pass: recurse into all children and take the first non-empty result.
    for (const child of part.parts) {
      const text = extractBodyFromPart(child);
      if (text.length > 0) return text;
    }
  }

  return "";
}

/**
 * Decode a base64url-encoded string (Gmail API encodes all message body data
 * in base64url). Returns empty string on any error rather than throwing.
 */
function decodeBase64urlBody(encoded: string): string {
  if (!encoded) return "";
  try {
    // base64url → base64: replace URL-safe chars with standard chars.
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    // Add padding if needed.
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Minimal HTML tag stripper. Collapses all `<...>` spans and decodes common
 * HTML entities in a single pass to avoid double-unescaping (CodeQL finding:
 * chained replace calls can expand `&amp;lt;` → `&lt;` → `<`). The entity
 * map is applied in one `replace` with a callback, so each entity is decoded
 * exactly once and the output is never fed back through entity expansion.
 */
function stripHtmlTags(html: string): string {
  if (!html) return "";
  // Step 1: strip all HTML tags.
  const noTags = html.replace(/<[^>]*>/g, " ");
  // Step 2: decode HTML entities in a single pass via a lookup table.
  const HTML_ENTITIES: Readonly<Record<string, string>> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };
  const decoded = noTags.replace(/&(?:#39|nbsp|amp|lt|gt|quot|apos);/gi, (entity) => {
    return HTML_ENTITIES[entity.toLowerCase()] ?? entity;
  });
  // Step 3: collapse whitespace.
  return decoded.replace(/\s{2,}/g, " ").trim();
}

/**
 * Extract the `Subject` header value from a message. Returns undefined if
 * not present. Never logs the value.
 */
function extractSubject(message: GmailMessage): string | undefined {
  const headers = message.payload?.headers ?? [];
  for (const h of headers) {
    if (typeof h.name === "string" && h.name.toLowerCase() === "subject") {
      const v = h.value;
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sync result type
// ---------------------------------------------------------------------------

/**
 * Result of a single sync pass. Superset of `SyncIncrementalResult` for
 * richer test assertions.
 */
export interface GmailSyncResult extends SyncIncrementalResult {
  readonly skippedInaccessible: number;
  readonly skippedEmpty: number;
  readonly skippedTooLarge: number;
}

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

/**
 * Construct the connector. The `fetchFn` argument is the test hook —
 * production callers omit it and the connector uses the global `fetch`.
 */
export function createGmailConnector(
  options: { fetchFn?: GmailFetchFn } = {},
): LiveConnector {
  const fetchFn: GmailFetchFn =
    options.fetchFn ??
    (globalThis.fetch as unknown as GmailFetchFn);

  return {
    id: GMAIL_CONNECTOR_ID,
    displayName: "Gmail",
    description:
      "Imports new inbox messages from Gmail into Remnic on a poll schedule.",

    validateConfig(raw: unknown): ConnectorConfig {
      return validateGmailConfig(raw) as unknown as ConnectorConfig;
    },

    async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
      const config = validateGmailConfig(args.config);
      throwIfAborted(args.abortSignal);

      // Exchange credentials for a short-lived access token.
      const accessToken = await exchangeRefreshToken(fetchFn, config, args.abortSignal);
      throwIfAborted(args.abortSignal);

      // First-sync bootstrap: record "now" as the watermark and return
      // without importing anything. Mirrors Drive's getStartPageToken pattern.
      if (args.cursor === null) {
        const bootstrapResult: GmailSyncResult = {
          newDocs: [],
          nextCursor: makeCursor({
            watermarkMs: String(Date.now()),
            skippedIds: {},
            seenIds: {},
          }),
          skippedInaccessible: 0,
          skippedEmpty: 0,
          skippedTooLarge: 0,
        };
        return bootstrapResult;
      }

      const cursorPayload = parseCursorPayload(args.cursor);
      return await incrementalSync(
        fetchFn,
        accessToken,
        config,
        cursorPayload,
        args.abortSignal,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Incremental sync
// ---------------------------------------------------------------------------

async function incrementalSync(
  fetchFn: GmailFetchFn,
  accessToken: string,
  config: GmailConnectorConfig,
  cursorPayload: GmailCursorPayload,
  signal: AbortSignal | undefined,
): Promise<GmailSyncResult> {
  const fetchedAt = new Date().toISOString();
  const newDocs: ConnectorDocument[] = [];
  let skippedInaccessible = 0;
  let skippedEmpty = 0;
  let skippedTooLarge = 0;
  let totalConsumed = 0;

  // --- Precision fix (Thread 1 / PRRT_kwDORJXyws59sa42) ---
  //
  // Watermark is now stored as exact epoch-milliseconds (`watermarkMs`).
  // The Gmail `after:<n>` operator accepts epoch seconds, so we truncate to
  // seconds for the query — but this means messages in the same second as the
  // watermark are returned again by Gmail. We guard against re-importing them
  // by checking each returned message id against `seenIds` (populated from the
  // cursor) and comparing its `internalDate` against the exact ms watermark.
  //
  // Advance the watermark only forward; never let it go backward regardless
  // of clock skew or out-of-order internalDate values from Gmail.
  let currentWatermarkMs = 0;
  let afterEpochSec = 0;
  if (cursorPayload.watermarkMs.length > 0) {
    const ms = Number(cursorPayload.watermarkMs);
    if (Number.isFinite(ms) && ms > 0) {
      currentWatermarkMs = ms;
      // Fix (Codex P1 PRRT_kwDORJXyws59sh5H): use Math.floor so the `after:`
      // query is inclusive of the watermark second. Gmail's `after:N` operator
      // matches messages with internalDate > N*1000 (strictly after N seconds),
      // so floor is the correct pairing: messages in the same second as the
      // watermark may be re-returned by Gmail, but seenIds deduplication
      // suppresses them without re-importing. Math.ceil was wrong: it rounds
      // UP to the next second, which causes messages with internalDate exactly
      // at the watermark second boundary to never be queried — they fall between
      // floor and ceil and are permanently missed.
      afterEpochSec = Math.floor(ms / 1000);
    }
  }

  // Build the Gmail search query: combine watermark filter with user query.
  const listQuery = buildListQuery(afterEpochSec, config.query);

  // Sub-second dedup (Thread 1): carry over seenIds from the previous cursor.
  // These are message ids already processed within the same second as the
  // current watermark. We skip them if Gmail re-returns them.
  // Cleared in the next cursor when the watermark advances into a new second.
  const seenIds: Record<string, string> = { ...cursorPayload.seenIds };

  // Skipped-message stall fix (Thread 2 / PRRT_kwDORJXyws59sa43): carry over
  // permanently-skipped message ids from the previous cursor. These are
  // messages that were empty, too-large, or inaccessible. They will never
  // become processable (Gmail messages are immutable), so we bypass them
  // without counting them toward the pass cap or stalling the watermark.
  const skippedIds: Record<string, string> = { ...cursorPayload.skippedIds };

  // Track the highest internalDate seen (in ms) across all non-skipped
  // messages. Initialized to the current watermark so it only ever advances.
  let highWaterMs = currentWatermarkMs;

  // Thread 2 fix (Codex P1 PRRT_kwDORJXyws59sctD): resume from a persisted
  // page token if present. This prevents re-processing the first batch every
  // pass when the cap is hit mid-page with newest-first ordering (livelock).
  let pageToken: string | undefined = cursorPayload.pageToken;

  // Whether we exhausted the full message list without hitting the per-pass
  // cap. Mirrors Notion's `databaseFullyDrained` pattern (Codex P1 review):
  // only advance the watermark when we fully drained the list. If the cap was
  // hit mid-pass, the next poll must resume from the saved pageToken (see
  // Thread 2 fix above) to pick up the remaining messages without re-doing
  // the first batch.
  let listFullyDrained = false;
  let capHit = false;
  // Track the page token at the point the cap is hit so we can persist it.
  let capHitPageToken: string | undefined = undefined;

  // Page through messages.list until exhausted, aborted, or per-pass cap hit.
  while (true) {
    throwIfAborted(signal);

    // Build the list URL.
    let listPath = `/users/${encodeURIComponent(config.userId)}/messages?maxResults=${LIST_PAGE_SIZE}&q=${encodeURIComponent(listQuery)}`;
    if (pageToken) {
      listPath += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    // Fetch the page. If a persisted pageToken is invalid/expired (Gmail
    // returns 400), clear it and retry from the beginning of the `after:`
    // window for this pass — otherwise the connector stalls forever retrying
    // the same bad token. (Codex P1 PRRT_kwDORJXyws59z610)
    let listData: unknown;
    try {
      listData = await gmailGet(fetchFn, accessToken, listPath, signal);
    } catch (listErr) {
      const listErrObj = listErr as { gmailStatus?: unknown } | null;
      if (
        pageToken !== undefined &&
        listErrObj !== null &&
        typeof listErrObj === "object" &&
        listErrObj.gmailStatus === 400
      ) {
        // The persisted pageToken is stale or invalid. Clear it and restart
        // from the beginning of the `after:` window for this pass.
        pageToken = undefined;
        listPath = `/users/${encodeURIComponent(config.userId)}/messages?maxResults=${LIST_PAGE_SIZE}&q=${encodeURIComponent(listQuery)}`;
        listData = await gmailGet(fetchFn, accessToken, listPath, signal);
      } else {
        throw listErr;
      }
    }
    throwIfAborted(signal);

    const listPage = listData as {
      messages?: GmailMessageRef[];
      nextPageToken?: string;
    };

    const messages = listPage.messages ?? [];

    // Whether the per-pass cap was hit while iterating this page's messages.
    let capHitMidPage = false;

    for (const ref of messages) {
      throwIfAborted(signal);

      // Thread 2: if this id was permanently skipped in a prior pass, skip
      // it again without consuming the per-pass cap. The message is immutable
      // and will never become processable.
      if (skippedIds[ref.id]) {
        continue;
      }

      // Thread 1 (sub-second dedup): if this id was already processed in the
      // same second-window as the current watermark, skip it. This prevents
      // re-importing messages that Gmail re-returns because `after:` is
      // second-granular but our watermark has sub-second precision.
      if (seenIds[ref.id] !== undefined) {
        continue;
      }

      if (totalConsumed >= MAX_MESSAGES_PER_PASS) {
        // Cap hit mid-page. Stop processing this page's remaining messages.
        // We still need to read listPage.nextPageToken below (Thread 2) to
        // know whether there are more pages to resume from.
        capHitMidPage = true;
        break;
      }
      totalConsumed++;

      const doc = await fetchMessageDocument(
        fetchFn,
        accessToken,
        config,
        ref.id,
        fetchedAt,
        signal,
      );

      if (doc === "inaccessible") {
        skippedInaccessible++;
        // Terminal: don't re-fetch this id. Record it in skippedIds so future
        // polls bypass it without hitting the API again (Thread 2 fix).
        // Store "0" as the date — we have no internalDate for inaccessible
        // messages; pruneSkippedIds treats "0" as unknown and evicts last.
        skippedIds[ref.id] = "0";
      } else if (doc !== null && typeof doc === "object" && "kind" in doc) {
        // SkippedWithDate: empty or too-large. Gmail messages are immutable,
        // so record the id in skippedIds (Thread 2 fix) to prevent re-fetching
        // on every subsequent poll, AND update highWaterMs with the message's
        // internalDate so the watermark can advance past it when fully drained.
        // Store the internalDate so pruneSkippedIds can evict this entry once
        // the watermark advances past it. (Codex P2 PRRT_kwDORJXyws59z612)
        if (doc.kind === "empty") skippedEmpty++;
        else skippedTooLarge++;
        skippedIds[ref.id] =
          doc.internalDate.length > 0 ? doc.internalDate : "0";
        const skippedMs = Number(doc.internalDate);
        if (Number.isFinite(skippedMs) && skippedMs > highWaterMs) {
          highWaterMs = skippedMs;
        }
      } else if (doc !== null) {
        newDocs.push(doc as ConnectorDocument);
        // Track highest internalDate to advance watermark when fully drained.
        const successDoc = doc as ConnectorDocument;
        if (successDoc.source.externalRevision) {
          const msgMs = Number(successDoc.source.externalRevision);
          if (Number.isFinite(msgMs) && msgMs > highWaterMs) {
            highWaterMs = msgMs;
          }
          // Thread 1: record this id in seenIds so same-second re-queries
          // don't re-import it. seenIds maps id → internalDate ms string.
          seenIds[ref.id] = successDoc.source.externalRevision;
        }
      }
    }

    // Resolve the next-page token from this page's response.
    const hasNextPage =
      typeof listPage.nextPageToken === "string" && listPage.nextPageToken.length > 0;
    const resolvedNextPageToken = hasNextPage ? listPage.nextPageToken : undefined;

    if (capHitMidPage) {
      // Cap-hit mid-page fix (Codex P1 PRRT_kwDORJXyws59sh5I + Cursor
      // PRRT_kwDORJXyws59sji9): when the cap is hit while iterating this page,
      // persist the CURRENT page's token (the one used to fetch this page) so
      // the next poll re-fetches the same page and continues where we left off.
      // Messages already processed are in seenIds and will be skipped on
      // re-fetch. If pageToken is undefined we are on page 1, so the next poll
      // restarts from the beginning of the `after:` window — also correct.
      //
      // Previously we saved resolvedNextPageToken (the NEXT page's token),
      // which skipped all messages remaining on the current page — those
      // messages would never be processed.
      capHit = true;
      capHitPageToken = pageToken;
      break;
    }

    // Continue to the next page if Gmail signals more results.
    if (resolvedNextPageToken !== undefined) {
      pageToken = resolvedNextPageToken;
      continue;
    }

    // No nextPageToken — the list is fully drained for this `after:` window.
    listFullyDrained = true;
    break;
  }

  // --- Watermark advancement ---
  //
  // Only advance when we fully drained the list (no cap hit, no premature
  // abort). Compare against the exact ms watermark (not the truncated
  // afterEpochSec * 1000) to prevent backward regression on clock skew.
  //
  // seenIds pruning (Codex P1 PRRT_kwDORJXyws59se73): after every pass, prune
  // seenIds via pruneSeenIds(seenIds, nextWatermarkMs). This replaces the
  // previous "clear seenIds when crossing a second boundary" approach, which
  // was incorrect — messages within the current watermark second can still
  // appear in the next `after:floor(watermarkMs/1000)` query, so clearing
  // seenIds caused re-imports. Instead we prune entries strictly below the
  // new watermark and enforce a hard size cap (SEEN_IDS_MAX / SEEN_IDS_RETAIN)
  // to bound cursor growth regardless of how many messages share the active
  // second window.
  //
  // Thread 2: pageToken in the next cursor is set only when the cap was hit
  // mid-page. It is cleared (not included) when the list is fully drained.
  let nextWatermarkMs: string;
  let nextSeenIds: Record<string, string>;
  let nextSkippedIds: Record<string, string>;
  let nextPageToken: string | undefined;

  if (listFullyDrained && !capHit && highWaterMs > currentWatermarkMs) {
    nextWatermarkMs = String(highWaterMs);
    // Prune seenIds to new watermark and enforce size cap.
    nextSeenIds = pruneSeenIds(seenIds, highWaterMs);
    // Prune skippedIds to new watermark. (Codex P2 PRRT_kwDORJXyws59z612)
    nextSkippedIds = pruneSkippedIds(skippedIds, highWaterMs);
    // Window fully drained — clear the page token.
    nextPageToken = undefined;
  } else if (capHit) {
    // Cap hit mid-page: keep watermark; prune seenIds to current watermark
    // and enforce size cap; persist the current page token (Thread 2 / fix
    // PRRT_kwDORJXyws59sh5I).
    nextWatermarkMs = cursorPayload.watermarkMs;
    nextSeenIds = pruneSeenIds(seenIds, currentWatermarkMs);
    nextSkippedIds = pruneSkippedIds(skippedIds, currentWatermarkMs);
    nextPageToken = capHitPageToken;
  } else {
    // Watermark unchanged (list drained but no new messages, or aborted) —
    // keep exact ms string; prune seenIds to current watermark; no page token.
    nextWatermarkMs = cursorPayload.watermarkMs;
    nextSeenIds = pruneSeenIds(seenIds, currentWatermarkMs);
    nextSkippedIds = pruneSkippedIds(skippedIds, currentWatermarkMs);
    nextPageToken = undefined;
  }

  const nextCursor = makeCursor({
    watermarkMs: nextWatermarkMs,
    skippedIds: nextSkippedIds,
    seenIds: nextSeenIds,
    ...(nextPageToken !== undefined ? { pageToken: nextPageToken } : {}),
  });

  return {
    newDocs,
    nextCursor,
    skippedInaccessible,
    skippedEmpty,
    skippedTooLarge,
  };
}

/**
 * Build the Gmail query string combining the `after:` watermark filter with
 * the operator-configured `query`. The `after:` operator takes epoch seconds.
 */
function buildListQuery(afterEpochSec: number, userQuery: string): string {
  const parts: string[] = [];
  if (afterEpochSec > 0) {
    parts.push(`after:${afterEpochSec}`);
  }
  const trimmedUser = userQuery.trim();
  if (trimmedUser.length > 0) {
    parts.push(trimmedUser);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Per-message document fetch
// ---------------------------------------------------------------------------

/**
 * Tagged result for skipped messages that have an `internalDate` available.
 * The caller uses the date to advance the watermark past immutable messages
 * (empty or too-large) that would otherwise stall the watermark forever
 * (Cursor Medium review: empty/too-large messages permanently stall watermark).
 */
type SkippedWithDate = { kind: "empty" | "too-large"; internalDate: string };

async function fetchMessageDocument(
  fetchFn: GmailFetchFn,
  accessToken: string,
  config: GmailConnectorConfig,
  messageId: string,
  fetchedAt: string,
  signal: AbortSignal | undefined,
): Promise<ConnectorDocument | SkippedWithDate | "inaccessible" | null> {
  throwIfAborted(signal);

  let message: GmailMessage;
  try {
    const path = `/users/${encodeURIComponent(config.userId)}/messages/${encodeURIComponent(messageId)}?format=full`;
    const data = await gmailGet(fetchFn, accessToken, path, signal);
    message = data as GmailMessage;
  } catch (err) {
    if (isTransientGmailError(err)) {
      // Transient: re-throw to stop the pass without advancing the cursor.
      throw err;
    }
    // 401 Unauthorized on a per-message fetch is also transient: the access
    // token may have expired mid-pass. Re-throwing prevents the message from
    // being permanently blacklisted in skippedIds when credentials are
    // temporarily invalid. The next poll will re-fetch a fresh token and retry.
    // (Codex P1 PRRT_kwDORJXyws59z61w)
    if (
      err !== null &&
      typeof err === "object" &&
      (err as { gmailStatus?: unknown }).gmailStatus === 401
    ) {
      throw err;
    }
    // Terminal (404 / 403 / 400): skip this message.
    return "inaccessible";
  }

  const internalDate = message.internalDate ?? "";

  // Extract body text.
  const body = message.payload ? extractBodyFromPart(message.payload) : "";

  if (typeof body !== "string" || body.trim().length === 0) {
    // Return the internalDate so the caller can advance the watermark past
    // this immutable empty message (it will never have content).
    return { kind: "empty", internalDate };
  }
  if (body.length > MAX_TEXT_BYTES) {
    // Same for too-large: the message is immutable; record its date.
    return { kind: "too-large", internalDate };
  }

  const subject = extractSubject(message);

  return {
    id: messageId,
    title: subject,
    content: body,
    source: {
      connector: GMAIL_CONNECTOR_ID,
      externalId: messageId,
      // Store internalDate (epoch ms string) as the revision so downstream
      // dedup can identify repeat fetches after cursor rewind.
      externalRevision: internalDate.length > 0 ? internalDate : undefined,
      fetchedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Watermark helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Convert an `internalDate` epoch-ms string to an ISO 8601 timestamp.
 * Exported for test assertions.
 */
export { internalDateToIso, internalDateToEpochSeconds, buildListQuery };
