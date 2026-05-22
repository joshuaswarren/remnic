/**
 * @remnic/core — Notion live connector (issue #683 PR 3/N)
 *
 * Concrete `LiveConnector` implementation that incrementally imports text
 * content from Notion database pages into Remnic. Built on top of the
 * framework shipped in PR 1/N (`framework.ts` / `registry.ts` /
 * `state-store.ts`) and mirrors the structure of the Google Drive connector
 * (PR 2/N).
 *
 * Design notes:
 *
 *   - **Auth.** Integration token from config (`connectors.notion.token`).
 *     The token is accepted at config-parse time but never logged. Operators
 *     must populate it from a secret store; per the repo-wide privacy policy
 *     no real value may appear in tests or comments.
 *
 *   - **Scope.** `databaseIds` in config limits the import to the listed
 *     Notion databases. The connector queries each database for pages whose
 *     `last_edited_time` is after a per-page high-water mark stored in the
 *     cursor. When `databaseIds` is empty the connector does nothing (safe
 *     default — no credentials → no import).
 *
 *   - **Cursor semantics.** The cursor is a JSON string encoding a
 *     `NotionCursorPayload`: a map from page-id to last-seen
 *     `last_edited_time` ISO string. On the first sync (cursor=null) we
 *     seed the payload from the current state of each database WITHOUT
 *     importing any content, so "first install" doesn't re-ingest history.
 *     Each subsequent pass only imports pages edited after the stored
 *     watermark.
 *
 *   - **Block extraction.** Page content is fetched via
 *     `blocks.children.list` recursively up to `MAX_BLOCK_DEPTH` levels.
 *     Block text is extracted to Markdown-ish plain text (no raw JSON blobs).
 *     Only text-bearing block types are included; unsupported types are
 *     silently skipped.
 *
 *   - **Raw `fetch`.** We call the Notion REST API directly rather than using
 *     `@notionhq/client` — there is no optional-peer-dep machinery needed and
 *     the API surface we consume is tiny. The `fetchFn` argument is the test
 *     hook allowing stubbing without network access.
 *
 *   - **Idempotency.** `ConnectorDocument.source.externalId` is the page id
 *     and `externalRevision` is `last_edited_time`, so downstream dedup can
 *     recognise repeat fetches if the cursor is rewound.
 *
 *   - **Privacy.** No page content is ever logged. Database ids and counts
 *     may be logged. The integration token is never exposed in logs, state,
 *     or error messages.
 *
 *   - **Read-only.** This connector only reads. It never modifies pages,
 *     databases, or any other Notion resource.
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
export const NOTION_CONNECTOR_ID = "notion";

/**
 * Cursor `kind` we emit. Opaque to the framework; documented here so
 * tests can assert on it.
 */
export const NOTION_CURSOR_KIND = "notionWatermark";

/**
 * Default poll interval (5 minutes). Notion's API has no push capability;
 * polling sub-minute wastes quota for a personal memory layer.
 */
export const NOTION_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Hard cap on poll interval: 24 hours. */
const NOTION_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on individual page text size. Notion pages can be very long;
 * we skip rather than blow the importer's heap.
 */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/**
 * Maximum recursion depth when fetching block children. Notion pages can
 * nest blocks (e.g. toggle → bulleted list → quote). We cap depth so a
 * pathologically deep page doesn't exhaust the call stack or quota.
 */
const MAX_BLOCK_DEPTH = 5;

/**
 * Maximum number of pages we import in a single `syncIncremental` pass
 * across all databases. Prevents one runaway pass from monopolising the
 * scheduler.
 */
const MAX_PAGES_PER_PASS = 200;

/**
 * Notion integration tokens always start with `secret_`. We validate this
 * prefix so a typo (e.g. pasting an OAuth token instead) is caught early.
 */
const NOTION_TOKEN_PREFIX = "secret_";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/**
 * Validated, frozen view of `connectors.notion.*`.
 */
export interface NotionConnectorConfig {
  /** Notion integration token. Starts with `secret_`. */
  readonly token: string;
  /** Database ids to import pages from. Empty = connector is a no-op. */
  readonly databaseIds: readonly string[];
  /** Poll interval surfaced to the scheduler (ms). */
  readonly pollIntervalMs: number;
}

/**
 * The JSON payload we encode into `ConnectorCursor.value`. Maps each
 * page id to the ISO 8601 `last_edited_time` we have already ingested.
 * Also tracks the ISO 8601 high-water mark per database (used for the
 * initial `filter.timestamp` query to skip unchanged pages).
 */
interface NotionCursorPayload {
  /** pageId → last_edited_time (ISO 8601). */
  pages: Record<string, string>;
  /** databaseId → latest last_edited_time seen in that DB. */
  databases: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Notion API response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

/** Minimal Notion page shape from `databases/{id}/query`. */
export interface NotionPage {
  readonly id: string;
  readonly last_edited_time: string;
  readonly url?: string;
  readonly properties?: Record<
    string,
    {
      type?: string;
      title?: Array<{ plain_text?: string }>;
    }
  >;
}

/** Minimal block shape from `blocks/{id}/children`. */
export interface NotionBlock {
  readonly id: string;
  readonly type: string;
  readonly has_children?: boolean;
  // We index by `type` to extract text.
  readonly [key: string]: unknown;
}

/** Minimal Notion API error shape. */
interface NotionApiError {
  readonly object: "error";
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Fetch abstraction (test hook)
// ---------------------------------------------------------------------------

/**
 * Minimal fetch-compatible surface we use. The real connector delegates to
 * the global `fetch`; tests inject a stub factory.
 */
export type NotionFetchFn = (
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
export function validateNotionConfig(raw: unknown): NotionConnectorConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(
      `notion: config must be an object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const r = raw as Record<string, unknown>;

  // token
  if (typeof r.token !== "string") {
    throw new TypeError(`notion: token must be a string (got ${typeof r.token})`);
  }
  const token = r.token.trim();
  if (token.length === 0) {
    throw new RangeError("notion: token must be non-empty");
  }
  if (!token.startsWith(NOTION_TOKEN_PREFIX)) {
    throw new RangeError(
      `notion: token must start with "${NOTION_TOKEN_PREFIX}" (looks like a non-integration token)`,
    );
  }

  // pollIntervalMs
  let pollIntervalMs: number;
  if (r.pollIntervalMs === undefined) {
    pollIntervalMs = NOTION_DEFAULT_POLL_INTERVAL_MS;
  } else if (typeof r.pollIntervalMs !== "number" || !Number.isFinite(r.pollIntervalMs)) {
    throw new TypeError(
      `notion: pollIntervalMs must be a finite number (got ${JSON.stringify(r.pollIntervalMs)})`,
    );
  } else if (!Number.isInteger(r.pollIntervalMs)) {
    throw new TypeError(`notion: pollIntervalMs must be an integer (got ${r.pollIntervalMs})`);
  } else if (r.pollIntervalMs < 1_000) {
    throw new RangeError(`notion: pollIntervalMs must be ≥1000ms; got ${r.pollIntervalMs}`);
  } else if (r.pollIntervalMs > NOTION_MAX_POLL_INTERVAL_MS) {
    throw new RangeError(
      `notion: pollIntervalMs must be ≤${NOTION_MAX_POLL_INTERVAL_MS} (24h); got ${r.pollIntervalMs}`,
    );
  } else {
    pollIntervalMs = r.pollIntervalMs;
  }

  // databaseIds
  let databaseIds: readonly string[] = [];
  if (r.databaseIds !== undefined) {
    if (!Array.isArray(r.databaseIds)) {
      throw new TypeError(
        `notion: databaseIds must be an array of strings (got ${typeof r.databaseIds})`,
      );
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of r.databaseIds) {
      if (typeof value !== "string") {
        throw new TypeError(
          `notion: databaseIds entries must be strings; found ${typeof value}`,
        );
      }
      const trimmed = value.trim();
      if (!isValidNotionId(trimmed)) {
        throw new RangeError(
          `notion: databaseIds entry ${JSON.stringify(value)} is not a valid Notion id`,
        );
      }
      // Dedupe per CLAUDE.md gotcha #49.
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    databaseIds = Object.freeze(out);
  }

  return Object.freeze({ token, databaseIds, pollIntervalMs });
}

/**
 * Notion UUIDs look like `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (32 hex, no
 * dashes) or `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (standard UUID). We
 * accept both and reject everything else to surface config typos.
 */
function isValidNotionId(value: string): boolean {
  // Standard UUID with dashes.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }
  // Notion's compact form (32 hex chars, no dashes).
  if (/^[0-9a-f]{32}$/i.test(value)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

function makeCursor(payload: NotionCursorPayload): ConnectorCursor {
  return {
    kind: NOTION_CURSOR_KIND,
    value: JSON.stringify(payload),
    updatedAt: new Date().toISOString(),
  };
}

function parseCursorPayload(cursor: ConnectorCursor): NotionCursorPayload {
  if (cursor.kind !== NOTION_CURSOR_KIND) {
    throw new Error(
      `notion: unexpected cursor kind ${JSON.stringify(cursor.kind)}; expected ${NOTION_CURSOR_KIND}`,
    );
  }
  // CLAUDE.md gotcha #18: validate after parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor.value);
  } catch {
    throw new Error(`notion: cursor value is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`notion: cursor value does not match NotionCursorPayload shape`);
  }
  const p = parsed as Record<string, unknown>;
  const pages = typeof p.pages === "object" && p.pages !== null && !Array.isArray(p.pages)
    ? (p.pages as Record<string, string>)
    : {};
  const databases = typeof p.databases === "object" && p.databases !== null && !Array.isArray(p.databases)
    ? (p.databases as Record<string, string>)
    : {};
  return { pages, databases };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a per-page fetch error as transient (re-throw to caller so the
 * sync stops without advancing the cursor and the next poll retries) or
 * terminal (skip the page and continue).
 *
 * We use raw `fetch`, so errors arrive either as network-layer `Error`
 * instances (no `.status`) or we detect them ourselves by inspecting the
 * HTTP status code from the parsed JSON body (attached as `notionStatus`).
 *
 * Delegates to the shared `isTransientHttpError` helper in
 * `transient-errors.ts` (Thread 3 — Cursor PRRT_kwDORJXyws59sdH4). The
 * Notion-specific `notionStatus` property is passed as an extra lookup key
 * so the shared resolver finds it before the generic `status` field.
 */
export function isTransientNotionError(err: unknown): boolean {
  return isTransientHttpError(err, ["notionStatus"]);
}

// ---------------------------------------------------------------------------
// Notion API client helpers
// ---------------------------------------------------------------------------

const NOTION_BASE_URL = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";

/**
 * Throw if aborted (cooperative cancellation).
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("notion: sync aborted");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Build a Notion API error with the HTTP status attached for classification.
 */
function makeNotionApiError(apiErr: NotionApiError): Error & { notionStatus: number } {
  const err = new Error(
    `notion: API error ${apiErr.status} (${apiErr.code}): ${apiErr.message}`,
  ) as Error & { notionStatus: number };
  err.notionStatus = apiErr.status;
  return err;
}

/**
 * Helper to call a Notion API endpoint. Throws a structured error on
 * non-2xx responses and propagates network errors unchanged so the
 * transient/terminal classifier can inspect them.
 */
async function notionFetch(
  fetchFn: NotionFetchFn,
  token: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const url = `${NOTION_BASE_URL}${path}`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    // Notion error responses carry `{object: "error", status, code, message}`.
    if (
      typeof data === "object" &&
      data !== null &&
      (data as Record<string, unknown>).object === "error"
    ) {
      throw makeNotionApiError(data as NotionApiError);
    }
    // Unexpected non-error-shaped body.
    const err = new Error(`notion: HTTP ${res.status}`) as Error & { notionStatus: number };
    err.notionStatus = res.status;
    throw err;
  }
  return data;
}

/**
 * GET helper — used for block children (GET endpoint, no body).
 */
async function notionGet(
  fetchFn: NotionFetchFn,
  token: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const url = `${NOTION_BASE_URL}${path}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
    },
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    if (
      typeof data === "object" &&
      data !== null &&
      (data as Record<string, unknown>).object === "error"
    ) {
      throw makeNotionApiError(data as NotionApiError);
    }
    const err = new Error(`notion: HTTP ${res.status}`) as Error & { notionStatus: number };
    err.notionStatus = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Block text extraction
// ---------------------------------------------------------------------------

/**
 * Extract all `rich_text[].plain_text` segments from a rich-text array.
 */
function extractRichText(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((span) => {
      if (typeof span !== "object" || span === null) return "";
      return typeof (span as Record<string, unknown>).plain_text === "string"
        ? ((span as Record<string, unknown>).plain_text as string)
        : "";
    })
    .join("");
}

/**
 * Extract the text portion of a single block. Returns an empty string for
 * block types we don't recognize.
 */
function extractBlockText(block: NotionBlock): string {
  const type = block.type;
  const blockData = block[type];
  if (typeof blockData !== "object" || blockData === null) return "";
  const data = blockData as Record<string, unknown>;

  // Most text-bearing blocks have a `rich_text` array.
  if (Array.isArray(data.rich_text)) {
    const text = extractRichText(data.rich_text);
    if (text.length > 0) {
      // Prefix heading blocks with Markdown syntax.
      if (type === "heading_1") return `# ${text}`;
      if (type === "heading_2") return `## ${text}`;
      if (type === "heading_3") return `### ${text}`;
      if (type === "to_do") {
        const checked = data.checked === true;
        return `- [${checked ? "x" : " "}] ${text}`;
      }
      if (type === "bulleted_list_item" || type === "numbered_list_item") {
        return `- ${text}`;
      }
      return text;
    }
    return "";
  }

  // Code block has `rich_text` plus an optional `language` field.
  if (type === "code" && Array.isArray(data.rich_text)) {
    return extractRichText(data.rich_text);
  }

  return "";
}

/**
 * Recursively fetch all block children for a page (or block with children)
 * and extract plain text. Bounded by `MAX_BLOCK_DEPTH` and `MAX_TEXT_BYTES`
 * to prevent runaway recursion or OOM on huge pages.
 */
async function fetchPageText(
  fetchFn: NotionFetchFn,
  token: string,
  blockId: string,
  depth: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (depth > MAX_BLOCK_DEPTH) return "";
  throwIfAborted(signal);

  const lines: string[] = [];
  let cursor: string | undefined = undefined;

  // Page through block children.
  while (true) {
    throwIfAborted(signal);
    const pathQuery = cursor
      ? `/blocks/${blockId}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
      : `/blocks/${blockId}/children?page_size=100`;
    const data = await notionGet(fetchFn, token, pathQuery, signal);

    if (typeof data !== "object" || data === null) break;
    const page = data as {
      results?: NotionBlock[];
      next_cursor?: string | null;
      has_more?: boolean;
    };

    for (const block of page.results ?? []) {
      throwIfAborted(signal);
      const text = extractBlockText(block);
      if (text.length > 0) lines.push(text);

      // Recurse into nested blocks.
      if (block.has_children && depth < MAX_BLOCK_DEPTH) {
        const childText = await fetchPageText(
          fetchFn,
          token,
          block.id,
          depth + 1,
          signal,
        );
        if (childText.length > 0) lines.push(childText);
      }

      // Guard against oversized pages.
      const currentSize = lines.reduce((acc, l) => acc + l.length + 1, 0);
      if (currentSize >= MAX_TEXT_BYTES) break;
    }

    if (!page.has_more || typeof page.next_cursor !== "string" || page.next_cursor === null) {
      break;
    }
    cursor = page.next_cursor;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Page title extraction
// ---------------------------------------------------------------------------

/**
 * Extract the page title from the page properties. Notion stores the title
 * under a property of type `"title"` — typically named "Name" but the name
 * can vary. We look for the first `type: "title"` property we find.
 */
function extractPageTitle(page: NotionPage): string | undefined {
  if (typeof page.properties !== "object" || page.properties === null) return undefined;
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title.map((t) => t.plain_text ?? "").join("");
      if (text.trim().length > 0) return text.trim();
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
export interface NotionSyncResult extends SyncIncrementalResult {
  readonly skippedUnchanged: number;
  readonly skippedTooLarge: number;
  readonly skippedEmpty: number;
}

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

/**
 * Construct the connector. The `fetchFn` argument is the test hook —
 * production callers omit it and the connector uses the global `fetch`.
 */
export function createNotionConnector(
  options: { fetchFn?: NotionFetchFn } = {},
): LiveConnector {
  const fetchFn: NotionFetchFn =
    options.fetchFn ??
    // Use global fetch (available in Node.js 18+). The cast is safe — we
    // only use the subset defined in `NotionFetchFn`.
    (globalThis.fetch as unknown as NotionFetchFn);

  return {
    id: NOTION_CONNECTOR_ID,
    displayName: "Notion",
    description:
      "Imports text content from Notion database pages into Remnic on a poll schedule.",

    validateConfig(raw: unknown): ConnectorConfig {
      return validateNotionConfig(raw) as unknown as ConnectorConfig;
    },

    async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
      const config = validateNotionConfig(args.config);
      throwIfAborted(args.abortSignal);

      // Short-circuit: if no databases are configured, there is nothing to do.
      // We still return a valid cursor so the framework has something to
      // persist (avoids a null-cursor on the next pass).
      if (config.databaseIds.length === 0) {
        const emptyPayload: NotionCursorPayload = { pages: {}, databases: {} };
        const result: NotionSyncResult = {
          newDocs: [],
          nextCursor: makeCursor(emptyPayload),
          skippedUnchanged: 0,
          skippedTooLarge: 0,
          skippedEmpty: 0,
        };
        return result;
      }

      // Parse or seed the cursor.
      const isFirstSync = args.cursor === null;
      const payload: NotionCursorPayload = isFirstSync
        ? { pages: {}, databases: {} }
        : parseCursorPayload(args.cursor);

      // On first sync we seed the watermark WITHOUT importing any content
      // (mirrors Drive's getStartPageToken bootstrap pattern).
      if (isFirstSync) {
        const seedPayload = await seedWatermark(
          fetchFn,
          config,
          payload,
          args.abortSignal,
        );
        return {
          newDocs: [],
          nextCursor: makeCursor(seedPayload),
          skippedUnchanged: 0,
          skippedTooLarge: 0,
          skippedEmpty: 0,
        } as NotionSyncResult;
      }

      // Incremental pass.
      return await incrementalSync(fetchFn, config, payload, args.abortSignal);
    },
  };
}

// ---------------------------------------------------------------------------
// First-sync seeding
// ---------------------------------------------------------------------------

/**
 * Seed the watermark from the current state of every configured database.
 * We record the latest `last_edited_time` we see per page and per database
 * so the next pass only imports future edits.
 */
async function seedWatermark(
  fetchFn: NotionFetchFn,
  config: NotionConnectorConfig,
  payload: NotionCursorPayload,
  signal: AbortSignal | undefined,
): Promise<NotionCursorPayload> {
  const pages = { ...payload.pages };
  const databases = { ...payload.databases };

  for (const dbId of config.databaseIds) {
    throwIfAborted(signal);
    let notionCursor: string | undefined = undefined;
    let latestInDb = "";

    while (true) {
      throwIfAborted(signal);
      const body: Record<string, unknown> = { page_size: 100, sorts: [] };
      if (notionCursor) body.start_cursor = notionCursor;

      const data = await notionFetch(
        fetchFn,
        config.token,
        `/databases/${dbId}/query`,
        body,
        signal,
      );

      if (typeof data !== "object" || data === null) break;
      const page = data as {
        results?: NotionPage[];
        next_cursor?: string | null;
        has_more?: boolean;
      };

      for (const p of page.results ?? []) {
        if (typeof p.id === "string" && typeof p.last_edited_time === "string") {
          pages[p.id] = p.last_edited_time;
          if (!latestInDb || p.last_edited_time > latestInDb) {
            latestInDb = p.last_edited_time;
          }
        }
      }

      if (!page.has_more || typeof page.next_cursor !== "string" || page.next_cursor === null) {
        break;
      }
      notionCursor = page.next_cursor;
    }

    if (latestInDb) databases[dbId] = latestInDb;
  }

  return { pages, databases };
}

// ---------------------------------------------------------------------------
// Incremental sync
// ---------------------------------------------------------------------------

async function incrementalSync(
  fetchFn: NotionFetchFn,
  config: NotionConnectorConfig,
  payload: NotionCursorPayload,
  signal: AbortSignal | undefined,
): Promise<NotionSyncResult> {
  const fetchedAt = new Date().toISOString();
  const newDocs: ConnectorDocument[] = [];
  const updatedPages = { ...payload.pages };
  const updatedDatabases = { ...payload.databases };
  let skippedUnchanged = 0;
  let skippedTooLarge = 0;
  let skippedEmpty = 0;
  let totalConsumed = 0;

  for (const dbId of config.databaseIds) {
    throwIfAborted(signal);
    if (totalConsumed >= MAX_PAGES_PER_PASS) break;

    const dbWatermark = payload.databases[dbId];
    let notionCursor: string | undefined = undefined;
    let latestInDb = dbWatermark ?? "";
    // Track whether we fully drained this database during the pass.
    //
    // Why this matters (codex review P1): we sort the query descending by
    // `last_edited_time` and filter `after: dbWatermark`. If we hit
    // MAX_PAGES_PER_PASS or get aborted mid-database, the pages we
    // *haven't* seen yet are *older* than the ones we have seen. Advancing
    // `databases[dbId]` to the highest `last_edited_time` we saw would set
    // the next pass's `after` filter past those still-pending older pages
    // and skip them forever (they only resurface if re-edited).
    //
    // Solution: only persist the new database watermark when the database
    // was fully drained for this pass. If we cut off early, leave
    // `databases[dbId]` at its previous value so the next pass re-queries
    // the same `after` filter and finishes the leftovers.
    let databaseFullyDrained = false;

    while (true) {
      throwIfAborted(signal);
      if (totalConsumed >= MAX_PAGES_PER_PASS) break;

      const body: Record<string, unknown> = {
        page_size: 100,
        sorts: [
          {
            timestamp: "last_edited_time",
            direction: "descending",
          },
        ],
      };
      // Filter to pages edited after the database watermark.
      if (dbWatermark) {
        body.filter = {
          timestamp: "last_edited_time",
          last_edited_time: { after: dbWatermark },
        };
      }
      if (notionCursor) body.start_cursor = notionCursor;

      const data = await notionFetch(
        fetchFn,
        config.token,
        `/databases/${dbId}/query`,
        body,
        signal,
      );

      if (typeof data !== "object" || data === null) break;
      const pageResp = data as {
        results?: NotionPage[];
        next_cursor?: string | null;
        has_more?: boolean;
      };

      let cutoffMidPage = false;
      for (const notionPage of pageResp.results ?? []) {
        throwIfAborted(signal);

        const pageId = notionPage.id;
        const lastEdited = notionPage.last_edited_time;

        if (typeof pageId !== "string" || typeof lastEdited !== "string") continue;

        // Skip pages that haven't changed since we last saw them.
        const knownRevision = payload.pages[pageId];
        if (knownRevision && knownRevision >= lastEdited) {
          skippedUnchanged++;
          if (!latestInDb || lastEdited > latestInDb) {
            latestInDb = lastEdited;
          }
          continue;
        }

        if (totalConsumed >= MAX_PAGES_PER_PASS) {
          cutoffMidPage = true;
          break;
        }
        totalConsumed++;

        // Fetch and build the document.
        const doc = await fetchPageDocument(
          fetchFn,
          config.token,
          notionPage,
          fetchedAt,
          signal,
        );

        if (doc === "too-large") {
          skippedTooLarge++;
          // Codex review P2: record the revision so we don't re-fetch this
          // oversized page on every subsequent poll. If the page shrinks
          // below the limit on a future edit, `last_edited_time` will
          // advance and the watermark check above will let it through.
          updatedPages[pageId] = lastEdited;
          if (!latestInDb || lastEdited > latestInDb) {
            latestInDb = lastEdited;
          }
        } else if (doc === "empty") {
          skippedEmpty++;
          // Codex review P2: same reasoning as too-large — record the
          // revision so we don't re-fetch an empty page indefinitely.
          updatedPages[pageId] = lastEdited;
          if (!latestInDb || lastEdited > latestInDb) {
            latestInDb = lastEdited;
          }
        } else if (doc !== null) {
          newDocs.push(doc);
          // Advance watermarks.
          updatedPages[pageId] = lastEdited;
          if (!latestInDb || lastEdited > latestInDb) {
            latestInDb = lastEdited;
          }
        } else {
          // null = terminal skip (404/403). Record the version so we
          // don't repeatedly attempt a permanently-inaccessible page.
          updatedPages[pageId] = lastEdited;
          if (!latestInDb || lastEdited > latestInDb) {
            latestInDb = lastEdited;
          }
        }

        if (totalConsumed >= MAX_PAGES_PER_PASS) {
          cutoffMidPage = true;
          break;
        }
      }

      if (cutoffMidPage) {
        // Hit the per-pass cap inside this database's results. The
        // database is NOT fully drained; leave its watermark intact so
        // the next pass re-queries the same `after` filter.
        break;
      }

      if (pageResp.has_more === true) {
        // Notion claims there are more pages.
        if (typeof pageResp.next_cursor === "string" && pageResp.next_cursor.length > 0) {
          // Continue paging.
          notionCursor = pageResp.next_cursor;
          continue;
        }
        // Defensive bail: has_more=true but no usable next_cursor. We do
        // NOT mark the database fully drained — the next pass must retry
        // the same `after` filter and pick up whatever we missed.
        break;
      }
      // has_more is false (or absent): the database is fully drained for
      // this pass. Safe to advance the database watermark below.
      databaseFullyDrained = true;
      break;
    }

    // Only advance the database watermark when we fully drained the
    // database. See the long comment above on `databaseFullyDrained`.
    if (databaseFullyDrained && latestInDb) {
      updatedDatabases[dbId] = latestInDb;
    }
  }

  const nextCursor = makeCursor({ pages: updatedPages, databases: updatedDatabases });
  return {
    newDocs,
    nextCursor,
    skippedUnchanged,
    skippedTooLarge,
    skippedEmpty,
  };
}

// ---------------------------------------------------------------------------
// Per-page document fetch
// ---------------------------------------------------------------------------

async function fetchPageDocument(
  fetchFn: NotionFetchFn,
  token: string,
  notionPage: NotionPage,
  fetchedAt: string,
  signal: AbortSignal | undefined,
): Promise<ConnectorDocument | "too-large" | "empty" | null> {
  throwIfAborted(signal);

  let text: string;
  try {
    text = await fetchPageText(fetchFn, token, notionPage.id, 0, signal);
  } catch (err) {
    if (isTransientNotionError(err)) {
      throw err;
    }
    // Terminal (404/403/400): skip this page.
    return null;
  }

  if (typeof text !== "string" || text.trim().length === 0) return "empty";
  if (text.length > MAX_TEXT_BYTES) return "too-large";

  const title = extractPageTitle(notionPage);

  return {
    id: notionPage.id,
    title,
    content: text,
    source: {
      connector: NOTION_CONNECTOR_ID,
      externalId: notionPage.id,
      externalRevision: notionPage.last_edited_time,
      externalUrl: typeof notionPage.url === "string" ? notionPage.url : undefined,
      fetchedAt,
    },
  };
}
