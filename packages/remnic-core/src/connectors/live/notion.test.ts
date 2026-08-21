import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTION_CONNECTOR_ID,
  NOTION_CURSOR_KIND,
  NOTION_DEFAULT_POLL_INTERVAL_MS,
  createNotionConnector,
  isTransientNotionError,
  validateNotionConfig,
  type NotionFetchFn,
  type NotionPage,
  type NotionSyncResult,
} from "./notion.js";
import type { ConnectorCursor } from "./framework.js";

/**
 * Tests for the Notion connector (#683 PR 3/N). All Notion API calls are
 * stubbed via the `fetchFn` test hook — the test suite never touches the
 * network.
 *
 * Per CLAUDE.md privacy rules: no real tokens, no real database ids, no
 * real page ids. All inputs are obviously-synthetic strings shaped roughly
 * like the real values.
 */

// ---------------------------------------------------------------------------
// Synthetic test data
// ---------------------------------------------------------------------------

/** Synthetic integration token shaped like a real one. */
const SYNTHETIC_TOKEN = "secret_synthetic_integration_token_DO_NOT_USE_aabbccdd";

/** Synthetic Notion UUIDs (hex-only compact form). */
const DB_ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DB_ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PAGE_ID_1 = "11111111111111111111111111111111";
const PAGE_ID_2 = "22222222222222222222222222222222";

const SYNTHETIC_CONFIG = Object.freeze({
  token: SYNTHETIC_TOKEN,
  databaseIds: [DB_ID_A],
});

function makeSyntheticPage(
  id: string,
  lastEdited: string,
  title?: string,
): NotionPage {
  const properties: NotionPage["properties"] = {};
  if (title !== undefined) {
    properties["Name"] = {
      type: "title",
      title: [{ plain_text: title }],
    };
  }
  return {
    id,
    last_edited_time: lastEdited,
    url: `https://notion.so/${id}`,
    properties,
  };
}

// ---------------------------------------------------------------------------
// Mock fetch builder
// ---------------------------------------------------------------------------

/**
 * Minimal fetch stub. Per-URL handlers return raw JSON-compatible objects;
 * the stub serialises them through `res.json()`.
 *
 * `handlers` maps URL substring patterns to response factories.
 */
function makeFetch(
  handlers: Array<{
    match: (url: string) => boolean;
    respond: (url: string, body: unknown) => { status: number; data: unknown };
  }>,
): NotionFetchFn {
  return async (url, init) => {
    let body: unknown = undefined;
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    for (const handler of handlers) {
      if (handler.match(url)) {
        const { status, data } = handler.respond(url, body);
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => data,
        };
      }
    }
    throw new Error(`fetch stub: no handler for ${url}`);
  };
}

/** Returns an empty paginated response for any database query. */
function emptyQueryFetch(): NotionFetchFn {
  return makeFetch([
    {
      match: (url) => url.includes("/databases/"),
      respond: () => ({
        status: 200,
        data: { object: "list", results: [], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 200,
        data: { object: "list", results: [], has_more: false, next_cursor: null },
      }),
    },
  ]);
}

/** Build a valid first-sync cursor from a payload. */
function makeNotionCursor(payload: { pages: Record<string, string>; databases: Record<string, string> }): ConnectorCursor {
  return {
    kind: NOTION_CURSOR_KIND,
    value: JSON.stringify(payload),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test("validateNotionConfig accepts a minimal valid config", () => {
  const cfg = validateNotionConfig({ token: SYNTHETIC_TOKEN });
  assert.equal(cfg.token, SYNTHETIC_TOKEN);
  assert.equal(cfg.pollIntervalMs, NOTION_DEFAULT_POLL_INTERVAL_MS);
  assert.deepEqual([...cfg.databaseIds], []);
});

test("validateNotionConfig rejects non-object input", () => {
  assert.throws(() => validateNotionConfig(null), /must be an object/);
  assert.throws(() => validateNotionConfig([]), /must be an object/);
  assert.throws(() => validateNotionConfig("nope"), /must be an object/);
});

test("validateNotionConfig rejects missing or empty token", () => {
  assert.throws(() => validateNotionConfig({}), /token must be a string/);
  assert.throws(() => validateNotionConfig({ token: "" }), /non-empty/);
  assert.throws(() => validateNotionConfig({ token: "   " }), /non-empty/);
});

test("validateNotionConfig rejects tokens not starting with secret_", () => {
  assert.throws(
    () => validateNotionConfig({ token: "ntn_not_an_integration_token_xxxx" }),
    /must start with "secret_"/,
  );
  assert.throws(
    () => validateNotionConfig({ token: "sk-openai-wrong-token-here" }),
    /must start with "secret_"/,
  );
});

test("validateNotionConfig rejects malformed pollIntervalMs", () => {
  // Non-number.
  assert.throws(
    () => validateNotionConfig({ token: SYNTHETIC_TOKEN, pollIntervalMs: "300000" }),
    /pollIntervalMs/,
  );
  // Below floor.
  assert.throws(
    () => validateNotionConfig({ token: SYNTHETIC_TOKEN, pollIntervalMs: 50 }),
    /≥1000/,
  );
  // Above ceiling.
  assert.throws(
    () => validateNotionConfig({ token: SYNTHETIC_TOKEN, pollIntervalMs: 25 * 60 * 60 * 1000 }),
    /≤/,
  );
  // Non-integer.
  assert.throws(
    () => validateNotionConfig({ token: SYNTHETIC_TOKEN, pollIntervalMs: 3000.5 }),
    /integer/,
  );
});

test("validateNotionConfig accepts valid databaseIds (compact + UUID formats)", () => {
  const compactId = "abcdef1234567890abcdef1234567890"; // 32 hex
  const uuidId = "abcdef12-3456-7890-abcd-ef1234567890"; // standard UUID

  const cfg1 = validateNotionConfig({ token: SYNTHETIC_TOKEN, databaseIds: [compactId] });
  assert.deepEqual([...cfg1.databaseIds], [compactId]);

  const cfg2 = validateNotionConfig({ token: SYNTHETIC_TOKEN, databaseIds: [uuidId] });
  assert.deepEqual([...cfg2.databaseIds], [uuidId]);
});

test("validateNotionConfig rejects invalid databaseIds", () => {
  // Non-array.
  assert.throws(
    () => validateNotionConfig({ token: SYNTHETIC_TOKEN, databaseIds: "not-an-array" }),
    /databaseIds.*array/,
  );
  // Non-string entry.
  assert.throws(
    () => validateNotionConfig({ token: SYNTHETIC_TOKEN, databaseIds: [42] }),
    /databaseIds.*strings/,
  );
  // Wrong shape (not 32 hex or UUID).
  assert.throws(
    () => validateNotionConfig({ token: SYNTHETIC_TOKEN, databaseIds: ["short"] }),
    /not a valid Notion id/,
  );
  assert.throws(
    () => validateNotionConfig({ token: SYNTHETIC_TOKEN, databaseIds: ["../etc/passwd"] }),
    /not a valid Notion id/,
  );
});

test("validateNotionConfig deduplicates databaseIds", () => {
  const cfg = validateNotionConfig({
    token: SYNTHETIC_TOKEN,
    databaseIds: [DB_ID_A, DB_ID_A, DB_ID_B],
  });
  assert.deepEqual([...cfg.databaseIds], [DB_ID_A, DB_ID_B]);
});

// ---------------------------------------------------------------------------
// Connector identity
// ---------------------------------------------------------------------------

test("createNotionConnector exposes the documented id and display name", () => {
  const connector = createNotionConnector({ fetchFn: emptyQueryFetch() });
  assert.equal(connector.id, NOTION_CONNECTOR_ID);
  assert.equal(connector.displayName, "Notion");
  assert.equal(connector.id, "notion"); // stable id contract
});

// ---------------------------------------------------------------------------
// No-op when databaseIds is empty
// ---------------------------------------------------------------------------

test("syncIncremental is a no-op when databaseIds is empty", async () => {
  let fetchCalled = false;
  const fetchFn: NotionFetchFn = async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  };
  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN });

  // cursor=null (first sync) with empty databaseIds.
  const r1 = (await connector.syncIncremental({ cursor: null, config })) as NotionSyncResult;
  assert.deepEqual(r1.newDocs, []);
  assert.equal(r1.nextCursor.kind, NOTION_CURSOR_KIND);
  assert.equal(fetchCalled, false);

  // cursor present, still no-op.
  const r2 = (await connector.syncIncremental({
    cursor: r1.nextCursor,
    config,
  })) as NotionSyncResult;
  assert.deepEqual(r2.newDocs, []);
  assert.equal(fetchCalled, false);
});

// ---------------------------------------------------------------------------
// First-sync bootstrap behavior (cursor=null)
// ---------------------------------------------------------------------------

test("first sync (cursor=null) seeds watermark and returns no docs", async () => {
  const page = makeSyntheticPage(PAGE_ID_1, "2026-04-25T10:00:00.000Z", "Seed Page");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page], has_more: false, next_cursor: null },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });

  const result = (await connector.syncIncremental({ cursor: null, config })) as NotionSyncResult;

  // No docs on first sync — we only seed the watermark.
  assert.deepEqual(result.newDocs, []);
  assert.equal(result.nextCursor.kind, NOTION_CURSOR_KIND);

  // The cursor payload must contain the page's last_edited_time.
  const payload = JSON.parse(result.nextCursor.value) as {
    pages: Record<string, string>;
    databases: Record<string, string>;
  };
  assert.equal(payload.pages[PAGE_ID_1], "2026-04-25T10:00:00.000Z");
  assert.equal(payload.databases[DB_ID_A], "2026-04-25T10:00:00.000Z");
});

test("first sync with empty database seeds an empty cursor", async () => {
  const connector = createNotionConnector({ fetchFn: emptyQueryFetch() });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });

  const result = await connector.syncIncremental({ cursor: null, config });
  assert.deepEqual(result.newDocs, []);
  assert.equal(result.nextCursor.kind, NOTION_CURSOR_KIND);
});

// ---------------------------------------------------------------------------
// Incremental sync: produces expected documents
// ---------------------------------------------------------------------------

test("incremental sync emits ConnectorDocument for pages edited after watermark", async () => {
  const page1 = makeSyntheticPage(PAGE_ID_1, "2026-04-26T09:00:00.000Z", "New Page");

  // Stub: database query returns page1; block fetch returns a paragraph.
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page1], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes(`/blocks/${PAGE_ID_1}/children`),
      respond: () => ({
        status: 200,
        data: {
          results: [
            {
              id: "block-1",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "Hello world" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });

  // Cursor with a watermark older than page1's last_edited_time.
  const cursor = makeNotionCursor({
    pages: {},
    databases: { [DB_ID_A]: "2026-04-25T00:00:00.000Z" },
  });

  const result = (await connector.syncIncremental({ cursor, config })) as NotionSyncResult;

  assert.equal(result.newDocs.length, 1);
  const doc = result.newDocs[0];
  assert.equal(doc.source.connector, NOTION_CONNECTOR_ID);
  assert.equal(doc.source.externalId, PAGE_ID_1);
  assert.equal(doc.source.externalRevision, "2026-04-26T09:00:00.000Z");
  assert.equal(doc.source.externalUrl, `https://notion.so/${PAGE_ID_1}`);
  assert.equal(doc.title, "New Page");
  assert.ok(doc.content.includes("Hello world"));
});

test("incremental sync skips pages whose watermark is up-to-date", async () => {
  // PAGE_ID_1 has same last_edited_time as what's in the cursor → skip.
  const page1 = makeSyntheticPage(PAGE_ID_1, "2026-04-25T00:00:00.000Z", "Old Page");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page1], has_more: false, next_cursor: null },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({
    pages: { [PAGE_ID_1]: "2026-04-25T00:00:00.000Z" },
    databases: { [DB_ID_A]: "2026-04-25T00:00:00.000Z" },
  });

  const result = (await connector.syncIncremental({ cursor, config })) as NotionSyncResult;
  assert.deepEqual(result.newDocs, []);
  assert.equal(result.skippedUnchanged, 1);
});

test("incremental sync advances cursor after importing pages", async () => {
  const page1 = makeSyntheticPage(PAGE_ID_1, "2026-04-26T10:00:00.000Z");
  const page2 = makeSyntheticPage(PAGE_ID_2, "2026-04-26T11:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page2, page1], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 200,
        data: {
          results: [
            {
              id: "blk",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "content" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({
    pages: {},
    databases: { [DB_ID_A]: "2026-04-25T00:00:00.000Z" },
  });

  const result = (await connector.syncIncremental({ cursor, config })) as NotionSyncResult;
  assert.equal(result.newDocs.length, 2);

  const payload = JSON.parse(result.nextCursor.value) as {
    pages: Record<string, string>;
    databases: Record<string, string>;
  };
  assert.equal(payload.pages[PAGE_ID_1], "2026-04-26T10:00:00.000Z");
  assert.equal(payload.pages[PAGE_ID_2], "2026-04-26T11:00:00.000Z");
  // Database watermark should be the latest across both pages.
  assert.equal(payload.databases[DB_ID_A], "2026-04-26T11:00:00.000Z");
});

test("incremental sync handles multiple databases independently", async () => {
  const pageA = makeSyntheticPage(PAGE_ID_1, "2026-04-26T08:00:00.000Z", "Page A");
  const pageB = makeSyntheticPage(PAGE_ID_2, "2026-04-26T09:00:00.000Z", "Page B");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [pageA], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes(`/databases/${DB_ID_B}/query`),
      respond: () => ({
        status: 200,
        data: { results: [pageB], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 200,
        data: {
          results: [
            {
              id: "blk",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "body" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({
    token: SYNTHETIC_TOKEN,
    databaseIds: [DB_ID_A, DB_ID_B],
  });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  const result = (await connector.syncIncremental({ cursor, config })) as NotionSyncResult;
  assert.equal(result.newDocs.length, 2);
  const ids = result.newDocs.map((d) => d.source.externalId).sort();
  assert.deepEqual(ids, [PAGE_ID_1, PAGE_ID_2].sort());
});

// ---------------------------------------------------------------------------
// Empty/too-large pages
// ---------------------------------------------------------------------------

test("incremental sync skips empty pages (no extractable text)", async () => {
  const page = makeSyntheticPage(PAGE_ID_1, "2026-04-26T08:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 200,
        data: { results: [], has_more: false, next_cursor: null },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  const result = (await connector.syncIncremental({ cursor, config })) as NotionSyncResult;
  assert.deepEqual(result.newDocs, []);
  assert.equal(result.skippedEmpty, 1);
});

test("incremental sync does not let replayed skipped pages exhaust the page cap", async () => {
  const emptyPages = Array.from({ length: 200 }, (_, index) =>
    makeSyntheticPage(
      `a${String(index).padStart(31, "0")}`,
      new Date(Date.UTC(2026, 3, 26, 12, 0, 0) - index * 1000).toISOString(),
    ),
  );
  const validPage = makeSyntheticPage(
    "cccccccccccccccccccccccccccccccc",
    "2026-04-26T10:00:00.000Z",
    "Older valid page",
  );

  const queryPage = (cursor: unknown) => {
    if (cursor === "page-2") {
      return { results: emptyPages.slice(100, 200), has_more: true, next_cursor: "page-3" };
    }
    if (cursor === "page-3") {
      return { results: [validPage], has_more: false, next_cursor: null };
    }
    return { results: emptyPages.slice(0, 100), has_more: true, next_cursor: "page-2" };
  };

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: (_url, body) => ({
        status: 200,
        data: queryPage((body as { start_cursor?: unknown } | undefined)?.start_cursor),
      }),
    },
    {
      match: (url) => url.includes(`/blocks/${validPage.id}/children`),
      respond: () => ({
        status: 200,
        data: {
          results: [
            {
              id: "valid-block",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "eventually imported content" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 200,
        data: { results: [], has_more: false, next_cursor: null },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({
    pages: {},
    databases: { [DB_ID_A]: "2026-04-26T09:00:00.000Z" },
  });

  const firstPass = (await connector.syncIncremental({ cursor, config })) as NotionSyncResult;
  assert.deepEqual(firstPass.newDocs, []);
  assert.equal(firstPass.skippedEmpty, 200);

  const secondPass = (await connector.syncIncremental({
    cursor: firstPass.nextCursor,
    config,
  })) as NotionSyncResult;
  assert.equal(secondPass.newDocs.length, 1);
  assert.equal(secondPass.newDocs[0]?.source.externalId, validPage.id);

  const payload = JSON.parse(secondPass.nextCursor.value) as {
    pages: Record<string, string>;
    databases: Record<string, string>;
  };
  assert.equal(payload.pages[validPage.id], validPage.last_edited_time);
  assert.equal(payload.databases[DB_ID_A], emptyPages[0]!.last_edited_time);
});

// ---------------------------------------------------------------------------
// Block text extraction (heading, todo, list items)
// ---------------------------------------------------------------------------

test("block text extraction handles headings, todos, and list items", async () => {
  const page = makeSyntheticPage(PAGE_ID_1, "2026-04-26T08:00:00.000Z", "Rich Page");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes(`/blocks/${PAGE_ID_1}/children`),
      respond: () => ({
        status: 200,
        data: {
          results: [
            {
              id: "b1",
              type: "heading_1",
              has_children: false,
              heading_1: { rich_text: [{ plain_text: "Title" }] },
            },
            {
              id: "b2",
              type: "heading_2",
              has_children: false,
              heading_2: { rich_text: [{ plain_text: "Subtitle" }] },
            },
            {
              id: "b3",
              type: "heading_3",
              has_children: false,
              heading_3: { rich_text: [{ plain_text: "Section" }] },
            },
            {
              id: "b4",
              type: "to_do",
              has_children: false,
              to_do: { rich_text: [{ plain_text: "Task" }], checked: false },
            },
            {
              id: "b5",
              type: "bulleted_list_item",
              has_children: false,
              bulleted_list_item: { rich_text: [{ plain_text: "Bullet" }] },
            },
            {
              id: "b6",
              type: "numbered_list_item",
              has_children: false,
              numbered_list_item: { rich_text: [{ plain_text: "Number" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  const result = await connector.syncIncremental({ cursor, config });
  assert.equal(result.newDocs.length, 1);
  const content = result.newDocs[0].content;
  assert.ok(content.includes("# Title"), `expected '# Title' in: ${content}`);
  assert.ok(content.includes("## Subtitle"));
  assert.ok(content.includes("### Section"));
  assert.ok(content.includes("- [ ] Task"));
  assert.ok(content.includes("- Bullet"));
  assert.ok(content.includes("- Number"));
});

// ---------------------------------------------------------------------------
// Error classification: transient vs terminal
// ---------------------------------------------------------------------------

test("isTransientNotionError classifies common error shapes", () => {
  // Terminal — skip-and-continue.
  assert.equal(isTransientNotionError({ notionStatus: 404 }), false);
  assert.equal(isTransientNotionError({ notionStatus: 403 }), false);
  assert.equal(isTransientNotionError({ notionStatus: 400 }), false);
  assert.equal(isTransientNotionError({ status: 410 }), false);
  // Transient — re-throw.
  assert.equal(isTransientNotionError({ notionStatus: 429 }), true);
  assert.equal(isTransientNotionError({ notionStatus: 500 }), true);
  assert.equal(isTransientNotionError({ notionStatus: 503 }), true);
  assert.equal(isTransientNotionError({ status: 504 }), true);
  // Network errors.
  assert.equal(isTransientNotionError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientNotionError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientNotionError({ code: "ENOTFOUND" }), true);
  assert.equal(isTransientNotionError({ code: "EAI_AGAIN" }), true);
  // AbortError.
  assert.equal(isTransientNotionError({ name: "AbortError" }), true);
  // Bare Error with no metadata — conservatively transient.
  assert.equal(isTransientNotionError(new Error("unknown")), true);
  // Non-objects.
  assert.equal(isTransientNotionError(null), false);
  assert.equal(isTransientNotionError(undefined), false);
  assert.equal(isTransientNotionError("oops"), false);
});

// ---------------------------------------------------------------------------
// 404 / 403 skip-and-continue
// ---------------------------------------------------------------------------

test("a 404 on block fetch is treated as terminal (skip page, cursor advances)", async () => {
  const goodPage = makeSyntheticPage(PAGE_ID_1, "2026-04-26T08:00:00.000Z", "Good Page");
  const notFoundPage = makeSyntheticPage(PAGE_ID_2, "2026-04-26T08:00:00.000Z", "Not Found Page");

  let blockCallCount = 0;
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [goodPage, notFoundPage], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: (url) => {
        blockCallCount++;
        if (url.includes(PAGE_ID_2)) {
          return {
            status: 404,
            data: {
              object: "error",
              status: 404,
              code: "object_not_found",
              message: "Could not find block with ID",
            },
          };
        }
        return {
          status: 200,
          data: {
            results: [
              {
                id: "blk",
                type: "paragraph",
                has_children: false,
                paragraph: { rich_text: [{ plain_text: "body" }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          },
        };
      },
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  const result = await connector.syncIncremental({ cursor, config });
  // Good page imported, 404 page skipped.
  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, PAGE_ID_1);
  assert.ok(blockCallCount >= 2, "should have called blocks for both pages");
  // Cursor must still advance.
  const payload = JSON.parse(result.nextCursor.value) as { pages: Record<string, string> };
  assert.ok(payload.pages[PAGE_ID_1]);
});

test("a 403 on block fetch is treated as terminal (skip page, cursor advances)", async () => {
  const page = makeSyntheticPage(PAGE_ID_1, "2026-04-26T08:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 403,
        data: {
          object: "error",
          status: 403,
          code: "restricted_resource",
          message: "Insufficient permissions",
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  const result = await connector.syncIncremental({ cursor, config });
  assert.deepEqual(result.newDocs, []);
  // Cursor advances even for terminal errors so we don't retry forever.
  const payload = JSON.parse(result.nextCursor.value) as { pages: Record<string, string> };
  assert.ok(payload.pages[PAGE_ID_1]);
});

// ---------------------------------------------------------------------------
// 429 / 5xx re-throw (transient)
// ---------------------------------------------------------------------------

test("a 429 on database query re-throws and cursor does NOT advance", async () => {
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 429,
        data: {
          object: "error",
          status: 429,
          code: "rate_limited",
          message: "Rate limit exceeded",
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({
    pages: {},
    databases: { [DB_ID_A]: "2026-04-25T00:00:00.000Z" },
  });

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /Rate limit exceeded/,
  );
});

test("a 429 on block fetch re-throws and cursor does NOT advance", async () => {
  const page = makeSyntheticPage(PAGE_ID_1, "2026-04-26T09:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 429,
        data: {
          object: "error",
          status: 429,
          code: "rate_limited",
          message: "Rate limit exceeded",
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({
    pages: {},
    databases: { [DB_ID_A]: "2026-04-25T00:00:00.000Z" },
  });

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /Rate limit exceeded/,
  );
});

test("a 503 on database query re-throws", async () => {
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 503,
        data: {
          object: "error",
          status: 503,
          code: "service_unavailable",
          message: "Service temporarily unavailable",
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /temporarily unavailable/,
  );
});

// ---------------------------------------------------------------------------
// AbortError propagation
// ---------------------------------------------------------------------------

test("an AbortError raised mid-fetch re-throws", async () => {
  const page = makeSyntheticPage(PAGE_ID_1, "2026-04-26T09:00:00.000Z");

  const fetchFn: NotionFetchFn = async (url) => {
    if (url.includes("/blocks/")) {
      throw Object.assign(new Error("request aborted"), { name: "AbortError" });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [page], has_more: false, next_cursor: null }),
    };
  };

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /aborted/,
  );
});

test("syncIncremental honors abortSignal via throwIfAborted", async () => {
  const controller = new AbortController();
  let callCount = 0;

  const fetchFn: NotionFetchFn = async () => {
    callCount++;
    // Abort after the first call.
    if (callCount === 1) controller.abort();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [makeSyntheticPage(PAGE_ID_1, "2026-04-26T09:00:00.000Z")],
        has_more: false,
        next_cursor: null,
      }),
    };
  };

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  await assert.rejects(
    connector.syncIncremental({ cursor, config, abortSignal: controller.signal }),
    /aborted/,
  );
});

// ---------------------------------------------------------------------------
// Cursor validation
// ---------------------------------------------------------------------------

test("syncIncremental rejects a cursor of an unexpected kind", async () => {
  const connector = createNotionConnector({ fetchFn: emptyQueryFetch() });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const badCursor: ConnectorCursor = {
    kind: "wrong-kind",
    value: "{}",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor: badCursor, config }),
    /unexpected cursor kind/,
  );
});

test("syncIncremental rejects a cursor with invalid JSON value", async () => {
  const connector = createNotionConnector({ fetchFn: emptyQueryFetch() });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const badCursor: ConnectorCursor = {
    kind: NOTION_CURSOR_KIND,
    value: "{ not valid json",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor: badCursor, config }),
    /not valid JSON/,
  );
});

test("validateConfig is enforced again on every sync pass", async () => {
  const connector = createNotionConnector({ fetchFn: emptyQueryFetch() });
  // Craft a config that looks like a ConnectorConfig (Record<string, unknown>)
  // but would fail validateNotionConfig (missing token prefix).
  const badConfig = { token: "ntn_wrong_prefix" } as unknown as import("./framework.js").ConnectorConfig;
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  await assert.rejects(
    connector.syncIncremental({ cursor, config: badConfig }),
    /secret_/,
  );
});

// ---------------------------------------------------------------------------
// Network-layer transient error
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Codex/Cursor review regressions (PR #744)
// ---------------------------------------------------------------------------

test("skipped empty pages record their revision so they aren't re-fetched on every poll", async () => {
  // Codex P2: empty/too-large branches must update page watermark.
  const page = makeSyntheticPage(PAGE_ID_1, "2026-04-26T08:00:00.000Z");
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 200,
        data: { results: [], has_more: false, next_cursor: null },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  const result = (await connector.syncIncremental({ cursor, config })) as NotionSyncResult;
  assert.equal(result.skippedEmpty, 1);
  // Page revision must be recorded so the next poll's "knownRevision >= lastEdited"
  // check skips this page as `skippedUnchanged` rather than re-fetching it.
  const payload = JSON.parse(result.nextCursor.value) as { pages: Record<string, string> };
  assert.equal(payload.pages[PAGE_ID_1], "2026-04-26T08:00:00.000Z");
});

test("incremental sync preserves prior database watermark when has_more=true with no next_cursor (defensive bail)", async () => {
  // Codex P1 / Cursor "Descending sort with page cap drops older edits":
  // when the database is NOT fully drained for this pass (cap hit, abort,
  // or a defensive bail on a malformed has_more=true response), advancing
  // databases[dbId] to the highest seen last_edited_time would cause the
  // next pass's `after` filter to skip older unprocessed pages forever.
  // Verify we leave the database watermark at its previous value.
  //
  // We exercise this via the defensive-bail path: has_more=true with
  // next_cursor=null. The connector breaks out of the page loop without
  // marking the database fully drained.
  const page = makeSyntheticPage(PAGE_ID_1, "2026-04-26T10:00:00.000Z");
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page], has_more: true, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 200,
        data: {
          results: [
            {
              id: "blk",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "body" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const priorWatermark = "2026-04-25T00:00:00.000Z";
  const cursor = makeNotionCursor({
    pages: {},
    databases: { [DB_ID_A]: priorWatermark },
  });

  const result = (await connector.syncIncremental({ cursor, config })) as NotionSyncResult;
  // The page WAS imported and per-page watermark recorded.
  assert.equal(result.newDocs.length, 1);
  const payload = JSON.parse(result.nextCursor.value) as {
    pages: Record<string, string>;
    databases: Record<string, string>;
  };
  assert.equal(payload.pages[PAGE_ID_1], "2026-04-26T10:00:00.000Z");
  // Database watermark NOT advanced because we didn't fully drain — the
  // next pass will retry the same `after` filter and pick up the older
  // pages we missed.
  assert.equal(payload.databases[DB_ID_A], priorWatermark);
});

test("incremental sync advances database watermark when fully drained", async () => {
  // Counterpart to the test above: when the database IS fully drained
  // (has_more=false), the database watermark MUST advance to the latest
  // last_edited_time we saw, otherwise we'd re-query the same window
  // forever.
  const page = makeSyntheticPage(PAGE_ID_1, "2026-04-26T10:00:00.000Z");
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`/databases/${DB_ID_A}/query`),
      respond: () => ({
        status: 200,
        data: { results: [page], has_more: false, next_cursor: null },
      }),
    },
    {
      match: (url) => url.includes("/blocks/"),
      respond: () => ({
        status: 200,
        data: {
          results: [
            {
              id: "blk",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "body" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      }),
    },
  ]);

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({
    pages: {},
    databases: { [DB_ID_A]: "2026-04-25T00:00:00.000Z" },
  });

  const result = (await connector.syncIncremental({ cursor, config })) as NotionSyncResult;
  assert.equal(result.newDocs.length, 1);
  const payload = JSON.parse(result.nextCursor.value) as { databases: Record<string, string> };
  // Drained → watermark advances.
  assert.equal(payload.databases[DB_ID_A], "2026-04-26T10:00:00.000Z");
});

test("a network ECONNRESET on database query re-throws as transient", async () => {
  const fetchFn: NotionFetchFn = async () => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };

  const connector = createNotionConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, databaseIds: [DB_ID_A] });
  const cursor = makeNotionCursor({ pages: {}, databases: {} });

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /socket hang up/,
  );
});
