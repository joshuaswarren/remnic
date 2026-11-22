
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

// ---------------------------------------------------------------------------

/** Stable connector id. Lives in the registry under this exact string. */
export const NOTION_CONNECTOR_ID = "notion";

/**
 * Cursor `kind` we emit. Opaque to the framework; documented here so
 * tests can assert on it.
 */
export const NOTION_CURSOR_KIND = "notionWatermark";

export const NOTION_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Hard cap on poll interval: 24 hours. */
const NOTION_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const MAX_BLOCK_DEPTH = 5;

const MAX_PAGES_PER_PASS = 200;

const NOTION_TOKEN_PREFIX = "secret_";

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

const NOTION_BASE_URL = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";

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
// ---------------------------------------------------------------------------

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
  throwIfAborted(signal, "notion: sync aborted");

  const lines: string[] = [];
  let cursor: string | undefined = undefined;

  while (true) {
    throwIfAborted(signal, "notion: sync aborted");
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
      throwIfAborted(signal, "notion: sync aborted");
      const text = extractBlockText(block);
      if (text.length > 0) lines.push(text);

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

    persistConfig(validated: ConnectorConfig): ConnectorConfig {
      const config = validateNotionConfig(validated);
      return Object.freeze({
        databaseIds: config.databaseIds,
        pollIntervalMs: config.pollIntervalMs,
      });
    },

    async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
      const config = validateNotionConfig(args.config);
      throwIfAborted(args.abortSignal, "notion: sync aborted");

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

      const isFirstSync = args.cursor === null;
      const payload: NotionCursorPayload = isFirstSync
        ? { pages: {}, databases: {} }
        : parseCursorPayload(args.cursor);

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

      return await incrementalSync(fetchFn, config, payload, args.abortSignal);
    },
  };
}

// ---------------------------------------------------------------------------
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
    throwIfAborted(signal, "notion: sync aborted");
    let notionCursor: string | undefined = undefined;
    let latestInDb = "";

    while (true) {
      throwIfAborted(signal, "notion: sync aborted");
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
    throwIfAborted(signal, "notion: sync aborted");
    if (totalConsumed >= MAX_PAGES_PER_PASS) break;

    const dbWatermark = payload.databases[dbId];
    let notionCursor: string | undefined = undefined;
    let latestInDb = dbWatermark ?? "";
    //
    //
    let databaseFullyDrained = false;

    while (true) {
      throwIfAborted(signal, "notion: sync aborted");
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
        throwIfAborted(signal, "notion: sync aborted");

        const pageId = notionPage.id;
        const lastEdited = notionPage.last_edited_time;

        if (typeof pageId !== "string" || typeof lastEdited !== "string") continue;

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

        const doc = await fetchPageDocument(
          fetchFn,
          config.token,
          notionPage,
          fetchedAt,
          signal,
        );

        if (doc === "too-large") {
          skippedTooLarge++;
          updatedPages[pageId] = lastEdited;
          if (!latestInDb || lastEdited > latestInDb) {
            latestInDb = lastEdited;
          }
        } else if (doc === "empty") {
          skippedEmpty++;
          updatedPages[pageId] = lastEdited;
          if (!latestInDb || lastEdited > latestInDb) {
            latestInDb = lastEdited;
          }
        } else if (doc !== null) {
          newDocs.push(doc);
          updatedPages[pageId] = lastEdited;
          if (!latestInDb || lastEdited > latestInDb) {
            latestInDb = lastEdited;
          }
        } else {
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
        break;
      }

      if (pageResp.has_more === true) {
        if (typeof pageResp.next_cursor === "string" && pageResp.next_cursor.length > 0) {
          notionCursor = pageResp.next_cursor;
          continue;
        }
        break;
      }
      databaseFullyDrained = true;
      break;
    }

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
// ---------------------------------------------------------------------------

async function fetchPageDocument(
  fetchFn: NotionFetchFn,
  token: string,
  notionPage: NotionPage,
  fetchedAt: string,
  signal: AbortSignal | undefined,
): Promise<ConnectorDocument | "too-large" | "empty" | null> {
  throwIfAborted(signal, "notion: sync aborted");

  let text: string;
  try {
    text = await fetchPageText(fetchFn, token, notionPage.id, 0, signal);
  } catch (err) {
    if (isTransientNotionError(err)) {
      throw err;
    }
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
