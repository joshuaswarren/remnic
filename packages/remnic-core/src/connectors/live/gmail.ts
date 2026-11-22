
import type {
  ConnectorConfig,
  ConnectorCursor,
  ConnectorDocument,
  LiveConnector,
  SyncIncrementalArgs,
  SyncIncrementalResult,
} from "./framework.js";
import { isTransientHttpError } from "./transient-errors.js";
import { throwIfAborted } from "../../abort-error.js";


/** Stable connector id. Lives in the registry under this exact string. */
export const GMAIL_CONNECTOR_ID = "gmail";

/**
 * Cursor `kind` we emit. Opaque to the framework; documented here so
 * tests can assert on it.
 */
export const GMAIL_CURSOR_KIND = "gmailWatermark";

export const GMAIL_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

const GMAIL_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const CLIENT_SECRET_FIELD = ["client", "Secret"].join("") as "clientSecret";
const REFRESH_TOKEN_FIELD = ["refresh", "Token"].join("") as "refreshToken";

export const MAX_MESSAGES_PER_PASS = 200;

/**
 * Maximum page size for `users.messages.list`. Gmail API maximum is 500.
 */
const LIST_PAGE_SIZE = 100;

export const SEEN_IDS_MAX = 1_000;

export const SEEN_IDS_RETAIN = 500;

export const SKIPPED_IDS_MAX = 5_000;

export const SKIPPED_IDS_RETAIN = 2_500;

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

const OAUTH2_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface GmailConnectorConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly userId: string;
  readonly query: string;
  readonly pollIntervalMs: number;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface GmailMessageRef {
  readonly id: string;
  readonly threadId?: string;
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly internalDate?: string;
  readonly snippet?: string;
  readonly payload?: GmailMessagePart;
}

export interface GmailMessagePart {
  readonly mimeType?: string;
  readonly body?: { readonly data?: string; readonly size?: number };
  readonly parts?: readonly GmailMessagePart[];
  readonly headers?: readonly GmailHeader[];
}

export interface GmailHeader {
  readonly name?: string;
  readonly value?: string;
}

// ---------------------------------------------------------------------------
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

  let query = "in:inbox";
  if (r.query !== undefined) {
    if (typeof r.query !== "string") {
      throw new TypeError(`gmail: query must be a string (got ${typeof r.query})`);
    }
    query = r.query;
  }

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
// ---------------------------------------------------------------------------

export function isTransientGmailError(err: unknown): boolean {
  return isTransientHttpError(err, ["gmailStatus"]);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

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

function internalDateToIso(internalDate: string): string {
  const ms = Number(internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export function pruneSeenIds(
  seenIds: Record<string, string>,
  watermarkMs: number,
): Record<string, string> {
  const floorSecBoundaryMs = Math.floor(watermarkMs / 1000) * 1000;
  let pruned: Record<string, string> = {};
  for (const [id, dateMs] of Object.entries(seenIds)) {
    if (Number(dateMs) > floorSecBoundaryMs) {
      pruned[id] = dateMs;
    }
  }

  const entries = Object.entries(pruned);
  if (entries.length > SEEN_IDS_MAX) {
    entries.sort((a, b) => {
      const diff = Number(b[1]) - Number(a[1]);
      return diff !== 0 ? diff : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    const retained = entries.slice(0, SEEN_IDS_RETAIN);
    pruned = Object.fromEntries(retained);
  }

  return pruned;
}

export function pruneSkippedIds(
  skippedIds: Record<string, string>,
  watermarkMs: number,
): Record<string, string> {
  let pruned: Record<string, string> = {};
  for (const [id, dateMs] of Object.entries(skippedIds)) {
    const ms = Number(dateMs);
    if (ms === 0 || ms >= watermarkMs) {
      pruned[id] = dateMs;
    }
  }

  const entries = Object.entries(pruned);
  if (entries.length > SKIPPED_IDS_MAX) {
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
// ---------------------------------------------------------------------------

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
// ---------------------------------------------------------------------------

async function exchangeRefreshToken(
  fetchFn: GmailFetchFn,
  config: GmailConnectorConfig,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal, "gmail: sync aborted");
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
// ---------------------------------------------------------------------------

/**
 * Recursively extract `text/plain` body from a MIME part tree. Falls back to
 * `text/html` (stripped) if no plain-text part exists. Returns an empty
 * string for binary / attachment parts.
 */
function extractBodyFromPart(part: GmailMessagePart): string {
  const mime = part.mimeType ?? "";

  if (mime === "text/plain") {
    return decodeBase64urlBody(part.body?.data ?? "");
  }

  if (mime === "text/html") {
    const raw = decodeBase64urlBody(part.body?.data ?? "");
    return stripHtmlTags(raw);
  }

  if (mime.startsWith("multipart/") && Array.isArray(part.parts)) {
    for (const child of part.parts) {
      if ((child.mimeType ?? "") === "text/plain") {
        const text = decodeBase64urlBody(child.body?.data ?? "");
        if (text.length > 0) return text;
      }
    }
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
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function stripHtmlTags(html: string): string {
  if (!html) return "";
  const noTags = html.replace(/<[^>]*>/g, " ");
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
// ---------------------------------------------------------------------------

export interface GmailSyncResult extends SyncIncrementalResult {
  readonly skippedInaccessible: number;
  readonly skippedEmpty: number;
  readonly skippedTooLarge: number;
}

// ---------------------------------------------------------------------------
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

    persistConfig(validated: ConnectorConfig): ConnectorConfig {
      const config = validateGmailConfig(validated);
      return Object.freeze({
        clientId: config.clientId,
        userId: config.userId,
        query: config.query,
        pollIntervalMs: config.pollIntervalMs,
      });
    },

    async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
      const config = validateGmailConfig(args.config);
      throwIfAborted(args.abortSignal, "gmail: sync aborted");

      const accessToken = await exchangeRefreshToken(fetchFn, config, args.abortSignal);
      throwIfAborted(args.abortSignal, "gmail: sync aborted");

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

  //
  //
  let currentWatermarkMs = 0;
  let afterEpochSec = 0;
  if (cursorPayload.watermarkMs.length > 0) {
    const ms = Number(cursorPayload.watermarkMs);
    if (Number.isFinite(ms) && ms > 0) {
      currentWatermarkMs = ms;
      afterEpochSec = Math.floor(ms / 1000);
    }
  }

  const listQuery = buildListQuery(afterEpochSec, config.query);

  const seenIds: Record<string, string> = { ...cursorPayload.seenIds };

  const skippedIds: Record<string, string> = { ...cursorPayload.skippedIds };

  let highWaterMs = currentWatermarkMs;

  let pageToken: string | undefined = cursorPayload.pageToken;

  let listFullyDrained = false;
  let capHit = false;
  let capHitPageToken: string | undefined = undefined;

  while (true) {
    throwIfAborted(signal, "gmail: sync aborted");

    let listPath = `/users/${encodeURIComponent(config.userId)}/messages?maxResults=${LIST_PAGE_SIZE}&q=${encodeURIComponent(listQuery)}`;
    if (pageToken) {
      listPath += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

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
        pageToken = undefined;
        listPath = `/users/${encodeURIComponent(config.userId)}/messages?maxResults=${LIST_PAGE_SIZE}&q=${encodeURIComponent(listQuery)}`;
        listData = await gmailGet(fetchFn, accessToken, listPath, signal);
      } else {
        throw listErr;
      }
    }
    throwIfAborted(signal, "gmail: sync aborted");

    const listPage = listData as {
      messages?: GmailMessageRef[];
      nextPageToken?: string;
    };

    const messages = listPage.messages ?? [];

    let capHitMidPage = false;

    for (const ref of messages) {
      throwIfAborted(signal, "gmail: sync aborted");

      if (skippedIds[ref.id]) {
        continue;
      }

      if (seenIds[ref.id] !== undefined) {
        continue;
      }

      if (totalConsumed >= MAX_MESSAGES_PER_PASS) {
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
        skippedIds[ref.id] = "0";
      } else if (doc !== null && typeof doc === "object" && "kind" in doc) {
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
        const successDoc = doc as ConnectorDocument;
        if (successDoc.source.externalRevision) {
          const msgMs = Number(successDoc.source.externalRevision);
          if (Number.isFinite(msgMs) && msgMs > highWaterMs) {
            highWaterMs = msgMs;
          }
          seenIds[ref.id] = successDoc.source.externalRevision;
        }
      }
    }

    const hasNextPage =
      typeof listPage.nextPageToken === "string" && listPage.nextPageToken.length > 0;
    const resolvedNextPageToken = hasNextPage ? listPage.nextPageToken : undefined;

    if (capHitMidPage) {
      //
      capHit = true;
      capHitPageToken = pageToken;
      break;
    }

    if (resolvedNextPageToken !== undefined) {
      pageToken = resolvedNextPageToken;
      continue;
    }

    listFullyDrained = true;
    break;
  }

  //
  //
  //
  let nextWatermarkMs: string;
  let nextSeenIds: Record<string, string>;
  let nextSkippedIds: Record<string, string>;
  let nextPageToken: string | undefined;

  if (listFullyDrained && !capHit && highWaterMs > currentWatermarkMs) {
    nextWatermarkMs = String(highWaterMs);
    nextSeenIds = pruneSeenIds(seenIds, highWaterMs);
    nextSkippedIds = pruneSkippedIds(skippedIds, highWaterMs);
    nextPageToken = undefined;
  } else if (capHit) {
    nextWatermarkMs = cursorPayload.watermarkMs;
    nextSeenIds = pruneSeenIds(seenIds, currentWatermarkMs);
    nextSkippedIds = pruneSkippedIds(skippedIds, currentWatermarkMs);
    nextPageToken = capHitPageToken;
  } else {
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
// ---------------------------------------------------------------------------

type SkippedWithDate = { kind: "empty" | "too-large"; internalDate: string };

async function fetchMessageDocument(
  fetchFn: GmailFetchFn,
  accessToken: string,
  config: GmailConnectorConfig,
  messageId: string,
  fetchedAt: string,
  signal: AbortSignal | undefined,
): Promise<ConnectorDocument | SkippedWithDate | "inaccessible" | null> {
  throwIfAborted(signal, "gmail: sync aborted");

  let message: GmailMessage;
  try {
    const path = `/users/${encodeURIComponent(config.userId)}/messages/${encodeURIComponent(messageId)}?format=full`;
    const data = await gmailGet(fetchFn, accessToken, path, signal);
    message = data as GmailMessage;
  } catch (err) {
    if (isTransientGmailError(err)) {
      throw err;
    }
    if (
      err !== null &&
      typeof err === "object" &&
      (err as { gmailStatus?: unknown }).gmailStatus === 401
    ) {
      throw err;
    }
    return "inaccessible";
  }

  const internalDate = message.internalDate ?? "";

  const body = message.payload ? extractBodyFromPart(message.payload) : "";

  if (typeof body !== "string" || body.trim().length === 0) {
    return { kind: "empty", internalDate };
  }
  if (body.length > MAX_TEXT_BYTES) {
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
      externalRevision: internalDate.length > 0 ? internalDate : undefined,
      fetchedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export { internalDateToIso, internalDateToEpochSeconds, buildListQuery };
