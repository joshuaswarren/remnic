import assert from "node:assert/strict";
import test from "node:test";

import {
  GMAIL_CONNECTOR_ID,
  GMAIL_CURSOR_KIND,
  GMAIL_DEFAULT_POLL_INTERVAL_MS,
  MAX_MESSAGES_PER_PASS,
  SEEN_IDS_MAX,
  SEEN_IDS_RETAIN,
  buildListQuery,
  createGmailConnector,
  internalDateToEpochSeconds,
  internalDateToIso,
  isTransientGmailError,
  pruneSeenIds,
  validateGmailConfig,
  type GmailFetchFn,
  type GmailMessage,
  type GmailMessageRef,
  type GmailSyncResult,
} from "./gmail.js";
import { isTransientHttpError } from "./transient-errors.js";
import type { ConnectorCursor } from "./framework.js";

/**
 * Tests for the Gmail connector (#683 PR 4/6). All Gmail API calls are
 * stubbed via the `fetchFn` test hook — the test suite never touches the
 * network.
 *
 * Per CLAUDE.md privacy rules: no real credentials, no real message ids,
 * no real email addresses. All inputs are obviously-synthetic strings.
 */

// ---------------------------------------------------------------------------

const SYNTHETIC_CREDS = Object.freeze({
  clientId: "synthetic-gmail-client-id.apps.googleusercontent.com",
  clientSecret: "synthetic-gmail-client-secret-DO-NOT-USE",
  refreshToken: "synthetic-gmail-refresh-token-DO-NOT-USE",
});

const SYNTHETIC_ACCESS_TOKEN = "synthetic-access-token-DO-NOT-USE";

/** A synthetic internalDate (epoch ms as string). */
const T1 = "1745000000000"; // ~2025-04-14
const T2 = "1745001000000"; // ~1000 s later
const T3 = "1745002000000"; // ~2000 s later

function makeMessageRef(id: string): GmailMessageRef {
  return { id, threadId: `thread-${id}` };
}

function makeMessage(
  id: string,
  internalDate: string,
  bodyText: string,
  subject?: string,
): GmailMessage {
  const headers = subject
    ? [{ name: "Subject", value: subject }]
    : [];
  return {
    id,
    threadId: `thread-${id}`,
    internalDate,
    payload: {
      mimeType: "text/plain",
      headers,
      body: {
        data: Buffer.from(bodyText, "utf-8").toString("base64url"),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

type FetchCall = { url: string; method: string };

/**
 * Build a `GmailFetchFn` stub. Handlers are matched first-to-last.
 * Each handler specifies a URL substring match and a factory that returns
 * `{ status, data }`.
 */
function makeFetch(
  handlers: Array<{
    match: (url: string, method: string) => boolean;
    respond: (url: string, body: string | undefined) => { status: number; data: unknown };
  }>,
  calls?: FetchCall[],
): GmailFetchFn {
  return async (url, init) => {
    if (calls) calls.push({ url, method: init.method });
    for (const handler of handlers) {
      if (handler.match(url, init.method)) {
        const { status, data } = handler.respond(url, init.body);
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => data,
        };
      }
    }
    throw new Error(`fetch stub: no handler for ${init.method} ${url}`);
  };
}

/** OAuth2 token exchange handler — always succeeds. */
function tokenHandler(): {
  match: (url: string, method: string) => boolean;
  respond: (url: string, body: string | undefined) => { status: number; data: unknown };
} {
  return {
    match: (url) => url.startsWith("https://oauth2.googleapis.com/"),
    respond: () => ({
      status: 200,
      data: { access_token: SYNTHETIC_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 },
    }),
  };
}

/** messages.list handler returning the given refs. */
function listHandler(
  refs: GmailMessageRef[],
  nextPageToken?: string,
): {
  match: (url: string, method: string) => boolean;
  respond: (url: string, body: string | undefined) => { status: number; data: unknown };
} {
  return {
    match: (url) => url.includes("/messages?") || url.includes("/messages&") || (url.includes("/messages") && !url.match(/\/messages\/[^?]/)),
    respond: () => ({
      status: 200,
      data: nextPageToken
        ? { messages: refs, nextPageToken }
        : { messages: refs },
    }),
  };
}

/** messages.get handler returning the given message map. */
function getHandler(
  messages: Record<string, GmailMessage>,
  statusOverride?: Record<string, number>,
): {
  match: (url: string, method: string) => boolean;
  respond: (url: string, body: string | undefined) => { status: number; data: unknown };
} {
  return {
    match: (url) => /\/messages\/[^?]+/.test(url) && url.includes("format=full"),
    respond: (url) => {
      const m = url.match(/\/messages\/([^?]+)/);
      const id = m ? decodeURIComponent(m[1]) : "";
      const statusCode = statusOverride?.[id] ?? 200;
      if (statusCode !== 200) {
        return {
          status: statusCode,
          data: { error: { message: `HTTP ${statusCode}`, code: statusCode } },
        };
      }
      const msg = messages[id];
      if (!msg) {
        return {
          status: 404,
          data: { error: { message: "not found", code: 404 } },
        };
      }
      return { status: 200, data: msg };
    },
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("validateGmailConfig accepts a minimal valid config", () => {
  const cfg = validateGmailConfig({ ...SYNTHETIC_CREDS });
  assert.equal(cfg.clientId, SYNTHETIC_CREDS.clientId);
  assert.equal(cfg.clientSecret, SYNTHETIC_CREDS.clientSecret);
  assert.equal(cfg.refreshToken, SYNTHETIC_CREDS.refreshToken);
  assert.equal(cfg.userId, "me");
  assert.equal(cfg.query, "in:inbox");
  assert.equal(cfg.pollIntervalMs, GMAIL_DEFAULT_POLL_INTERVAL_MS);
});

test("validateGmailConfig rejects non-object input", () => {
  assert.throws(() => validateGmailConfig(null), /must be an object/);
  assert.throws(() => validateGmailConfig([]), /must be an object/);
  assert.throws(() => validateGmailConfig("nope"), /must be an object/);
});

test("validateGmailConfig rejects missing or empty credentials", () => {
  assert.throws(
    () => validateGmailConfig({ clientSecret: "x", refreshToken: "y" }),
    /clientId/,
  );
  assert.throws(
    () => validateGmailConfig({ clientId: "x", refreshToken: "y" }),
    /clientSecret/,
  );
  assert.throws(
    () => validateGmailConfig({ clientId: "x", clientSecret: "y" }),
    /refreshToken/,
  );
  assert.throws(
    () => validateGmailConfig({ ...SYNTHETIC_CREDS, clientId: "   " }),
    /clientId.*non-empty/,
  );
});

test("validateGmailConfig rejects malformed pollIntervalMs", () => {
  assert.throws(
    () => validateGmailConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: "300000" }),
    /pollIntervalMs/,
  );
  assert.throws(
    () => validateGmailConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: 50 }),
    /≥1000/,
  );
  assert.throws(
    () => validateGmailConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: 25 * 60 * 60 * 1000 }),
    /≤/,
  );
  assert.throws(
    () => validateGmailConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: 3000.5 }),
    /integer/,
  );
});

test("validateGmailConfig accepts custom userId, query, and pollIntervalMs", () => {
  const cfg = validateGmailConfig({
    ...SYNTHETIC_CREDS,
    userId: "user@example.com",
    query: "label:work",
    pollIntervalMs: 60_000,
  });
  assert.equal(cfg.userId, "user@example.com");
  assert.equal(cfg.query, "label:work");
  assert.equal(cfg.pollIntervalMs, 60_000);
});

test("validateGmailConfig rejects empty userId string", () => {
  assert.throws(
    () => validateGmailConfig({ ...SYNTHETIC_CREDS, userId: "   " }),
    /userId.*non-empty/,
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("createGmailConnector exposes the documented id and display name", () => {
  const connector = createGmailConnector({
    fetchFn: makeFetch([tokenHandler()]),
  });
  assert.equal(connector.id, GMAIL_CONNECTOR_ID);
  assert.equal(connector.displayName, "Gmail");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("first sync (cursor=null) returns no docs and seeds the cursor with now", async () => {
  const before = Date.now();
  const connector = createGmailConnector({
    fetchFn: makeFetch([tokenHandler()]),
  });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });

  const result = await connector.syncIncremental({ cursor: null, config });

  const after = Date.now();
  assert.deepEqual(result.newDocs, []);
  assert.equal(result.nextCursor.kind, GMAIL_CURSOR_KIND);

  const payload = JSON.parse(result.nextCursor.value) as { watermarkMs: string; watermarkIso?: string };
  assert.ok(typeof payload.watermarkMs === "string", "cursor must have watermarkMs");
  assert.equal(payload.watermarkIso, undefined, "cursor must NOT have watermarkIso (use watermarkMs)");
  const watermarkMs = Number(payload.watermarkMs);
  assert.ok(watermarkMs >= before, "watermark should be >= before");
  assert.ok(watermarkMs <= after + 100, "watermark should be <= after");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("incremental sync emits ConnectorDocument entries for new messages", async () => {
  const msg1 = makeMessage("msg-id-001", T1, "Hello world from message 001", "Subject One");
  const msg2 = makeMessage("msg-id-002", T2, "Hello world from message 002", "Subject Two");

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-id-001"), makeMessageRef("msg-id-002")]),
    getHandler({ "msg-id-001": msg1, "msg-id-002": msg2 }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: String(Number(T1) - 1000), skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;

  assert.equal(result.newDocs.length, 2);
  assert.equal(result.newDocs[0].source.connector, GMAIL_CONNECTOR_ID);
  assert.equal(result.newDocs[0].source.externalId, "msg-id-001");
  assert.equal(result.newDocs[0].source.externalRevision, T1);
  assert.equal(result.newDocs[0].title, "Subject One");
  assert.ok(result.newDocs[0].content.includes("Hello world from message 001"));
  assert.equal(result.newDocs[1].source.externalId, "msg-id-002");
});

test("watermark advances to the highest internalDate of successfully processed messages", async () => {
  const msg1 = makeMessage("msg-id-a1", T1, "message a");
  const msg2 = makeMessage("msg-id-a2", T3, "message b"); // highest

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-id-a1"), makeMessageRef("msg-id-a2")]),
    getHandler({ "msg-id-a1": msg1, "msg-id-a2": msg2 }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });

  const payload = JSON.parse(result.nextCursor.value) as { watermarkMs: string };
  assert.ok(typeof payload.watermarkMs === "string", "cursor must use watermarkMs");
  assert.equal(Number(payload.watermarkMs), Number(T3));
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("watermark does NOT advance when nextPageToken present (partial drain)", async () => {
  const initialWatermark = new Date(Number(T1)).toISOString();
  const msg1 = makeMessage("msg-partial-1", T2, "partial drain message");

  let listCallCount = 0;
  const partialDrainFetch = makeFetch([
    tokenHandler(),
    {
      match: (url) => url.startsWith("https://gmail.googleapis.com/") && url.includes("/messages") && !url.includes("format=full"),
      respond: () => {
        listCallCount++;
        if (listCallCount === 1) {
          return {
            status: 200,
            data: { messages: [{ id: "msg-partial-1" }], nextPageToken: "pg2" },
          };
        }
        return {
          status: 503,
          data: { error: { message: "service unavailable", code: 503 } },
        };
      },
    },
    getHandler({ "msg-partial-1": msg1 }),
  ]);

  const connector = createGmailConnector({ fetchFn: partialDrainFetch });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: String(new Date(initialWatermark).getTime()), skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /service unavailable/,
  );
});

test("watermark advances when list is fully drained (no nextPageToken)", async () => {
  const msg1 = makeMessage("msg-full-1", T1, "message 1");
  const msg2 = makeMessage("msg-full-2", T3, "message 2");

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-full-1"), makeMessageRef("msg-full-2")]),
    getHandler({ "msg-full-1": msg1, "msg-full-2": msg2 }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const initialWatermark = new Date(Number(T1) - 1000).toISOString();
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: String(new Date(initialWatermark).getTime()), skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });

  const payload = JSON.parse(result.nextCursor.value) as { watermarkMs: string };
  assert.equal(Number(payload.watermarkMs), Number(T3));
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("watermark does NOT advance when all messages are inaccessible (404)", async () => {
  const initialWatermark = new Date(Number(T1)).toISOString();
  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-404"), makeMessageRef("msg-also-404")]),
    getHandler({}, { "msg-404": 404, "msg-also-404": 404 }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: String(new Date(initialWatermark).getTime()), skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;

  assert.equal(result.newDocs.length, 0);
  assert.equal(result.skippedInaccessible, 2);
  const payload = JSON.parse(result.nextCursor.value) as { watermarkMs: string };
  assert.equal(Number(payload.watermarkMs), Number(T1));
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("a 404 on a single message skips it without stopping the pass", async () => {
  const msgGood = makeMessage("msg-good-1", T2, "good message body");

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-404"), makeMessageRef("msg-good-1")]),
    getHandler({ "msg-good-1": msgGood }, { "msg-404": 404 }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;

  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, "msg-good-1");
  assert.equal(result.skippedInaccessible, 1);
});

test("a 403 permission-denied is terminal (skip-and-continue)", async () => {
  const msgGood = makeMessage("msg-good-2", T2, "good message body 2");

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-403"), makeMessageRef("msg-good-2")]),
    getHandler({ "msg-good-2": msgGood }, { "msg-403": 403 }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;

  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, "msg-good-2");
  assert.equal(result.skippedInaccessible, 1);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("a transient 429 re-throws and the cursor does NOT advance", async () => {
  let callCount = 0;
  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-429")]),
    {
      match: (url) => url.includes("format=full"),
      respond: () => {
        callCount++;
        return {
          status: 429,
          data: { error: { message: "rate limit exceeded", code: 429 } },
        };
      },
    },
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /rate limit/,
  );
  assert.equal(callCount, 1);
});

test("a transient 503 re-throws", async () => {
  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-503")]),
    {
      match: (url) => url.includes("format=full"),
      respond: () => ({
        status: 503,
        data: { error: { message: "service unavailable", code: 503 } },
      }),
    },
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /service unavailable/,
  );
});

test("an AbortError raised mid-fetch re-throws", async () => {
  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-abort")]),
    {
      match: (url) => url.includes("format=full"),
      respond: () => {
        throw Object.assign(new Error("request aborted"), { name: "AbortError" });
      },
    },
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /aborted/,
  );
});

test("a network-layer ECONNRESET re-throws as transient", async () => {
  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-econnreset")]),
    {
      match: (url) => url.includes("format=full"),
      respond: () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    },
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /socket hang up/,
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("syncIncremental honors abortSignal between messages", async () => {
  const controller = new AbortController();
  let messageGetCount = 0;

  const msg1 = makeMessage("msg-sig-1", T1, "first message");
  const msg2 = makeMessage("msg-sig-2", T2, "second message");

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-sig-1"), makeMessageRef("msg-sig-2")]),
    {
      match: (url) => url.includes("format=full"),
      respond: (url) => {
        messageGetCount++;
        if (messageGetCount === 1) {
          controller.abort();
        }
        const id = (url.match(/\/messages\/([^?]+)/) ?? [])[1] ?? "";
        const msg = id === "msg-sig-1" ? msg1 : msg2;
        return { status: 200, data: msg };
      },
    },
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config, abortSignal: controller.signal }),
    /aborted/,
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("messages with empty body are skipped (skippedEmpty)", async () => {
  const emptyMsg: GmailMessage = {
    id: "msg-empty",
    internalDate: T1,
    payload: { mimeType: "text/plain", body: { data: "" } },
  };
  const goodMsg = makeMessage("msg-good-3", T2, "good content here");

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-empty"), makeMessageRef("msg-good-3")]),
    getHandler({ "msg-empty": emptyMsg, "msg-good-3": goodMsg }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;

  assert.equal(result.skippedEmpty, 1);
  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, "msg-good-3");
});

test("watermark advances past empty messages on full drain (immutable skip)", async () => {
  const emptyMsg: GmailMessage = {
    id: "msg-empty-adv",
    internalDate: T3, // highest internalDate in the batch
    payload: { mimeType: "text/plain", body: { data: "" } },
  };
  const goodMsg = makeMessage("msg-good-adv", T2, "good content");

  const fetchFn = makeFetch([
    tokenHandler(),
    // No nextPageToken — fully drained.
    listHandler([makeMessageRef("msg-good-adv"), makeMessageRef("msg-empty-adv")]),
    getHandler({ "msg-good-adv": goodMsg, "msg-empty-adv": emptyMsg }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const initialWatermark = new Date(Number(T1)).toISOString();
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: String(new Date(initialWatermark).getTime()), skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;

  assert.equal(result.skippedEmpty, 1);
  assert.equal(result.newDocs.length, 1);
  const payload = JSON.parse(result.nextCursor.value) as { watermarkMs: string };
  assert.equal(Number(payload.watermarkMs), Number(T3), "watermark must advance past immutable empty message");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("isTransientGmailError classifies common error shapes", () => {
  assert.equal(isTransientGmailError({ status: 404 }), false);
  assert.equal(isTransientGmailError({ response: { status: 403 } }), false);
  assert.equal(isTransientGmailError({ response: { status: 400 } }), false);
  assert.equal(isTransientGmailError({ response: { status: 410 } }), false);
  assert.equal(isTransientGmailError({ response: { status: 429 } }), true);
  assert.equal(isTransientGmailError({ response: { status: 500 } }), true);
  assert.equal(isTransientGmailError({ response: { status: 503 } }), true);
  assert.equal(isTransientGmailError({ gmailStatus: 429 }), true);
  assert.equal(isTransientGmailError({ gmailStatus: 503 }), true);
  assert.equal(isTransientGmailError({ status: 504 }), true);
  assert.equal(isTransientGmailError({ code: "429" }), true);
  assert.equal(isTransientGmailError({ code: "503" }), true);
  assert.equal(isTransientGmailError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientGmailError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientGmailError({ code: "ENOTFOUND" }), true);
  assert.equal(isTransientGmailError({ code: "EAI_AGAIN" }), true);
  assert.equal(isTransientGmailError({ name: "AbortError" }), true);
  assert.equal(isTransientGmailError(new Error("unknown")), true);
  assert.equal(isTransientGmailError(null), false);
  assert.equal(isTransientGmailError(undefined), false);
  assert.equal(isTransientGmailError("oops"), false);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("syncIncremental rejects a cursor of an unexpected kind", async () => {
  const connector = createGmailConnector({
    fetchFn: makeFetch([tokenHandler()]),
  });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: "wrong-kind",
    value: "x",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /unexpected cursor kind/,
  );
});

test("validateConfig is enforced again on every sync pass", async () => {
  const connector = createGmailConnector({
    fetchFn: makeFetch([tokenHandler()]),
  });
  const badConfig = { clientId: "ok", clientSecret: "ok", refreshToken: "" } as unknown as import("./framework.js").ConnectorConfig;
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config: badConfig }),
    /refreshToken/,
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("internalDateToEpochSeconds converts epoch-ms string correctly", () => {
  assert.equal(internalDateToEpochSeconds("1745000000000"), 1745000000);
  assert.equal(internalDateToEpochSeconds("0"), 0);
  assert.equal(internalDateToEpochSeconds(""), 0);
  assert.equal(internalDateToEpochSeconds("not-a-number"), 0);
});

test("internalDateToIso converts epoch-ms string to ISO 8601", () => {
  const iso = internalDateToIso("1745000000000");
  assert.ok(iso.startsWith("2025"), `expected 2025 date, got ${iso}`);
  assert.equal(internalDateToIso(""), "");
  assert.equal(internalDateToIso("not-a-number"), "");
});

test("buildListQuery combines watermark and user query correctly", () => {
  assert.equal(buildListQuery(1745000000, "in:inbox"), "after:1745000000 in:inbox");
  assert.equal(buildListQuery(0, "in:inbox"), "in:inbox");
  assert.equal(buildListQuery(1745000000, ""), "after:1745000000");
  assert.equal(buildListQuery(0, ""), "");
  assert.equal(buildListQuery(1745000000, "  label:work  "), "after:1745000000 label:work");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("incremental sync extracts text/plain from multipart/alternative messages", async () => {
  const multipartMsg: GmailMessage = {
    id: "msg-multipart",
    internalDate: T1,
    payload: {
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: Buffer.from("Plain text body here", "utf-8").toString("base64url"),
          },
        },
        {
          mimeType: "text/html",
          body: {
            data: Buffer.from("<html><body>HTML body here</body></html>", "utf-8").toString("base64url"),
          },
        },
      ],
    },
  };

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-multipart")]),
    getHandler({ "msg-multipart": multipartMsg }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });

  assert.equal(result.newDocs.length, 1);
  assert.ok(result.newDocs[0].content.includes("Plain text body here"), "should use plain text part");
  assert.ok(!result.newDocs[0].content.includes("HTML body"), "should not include HTML part");
});

test("incremental sync extracts plain text from HTML when no text/plain part exists", async () => {
  const htmlOnlyMsg: GmailMessage = {
    id: "msg-html-only",
    internalDate: T1,
    payload: {
      mimeType: "text/html",
      body: {
        data: Buffer.from("<p>Hello <strong>World</strong></p>", "utf-8").toString("base64url"),
      },
    },
  };

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-html-only")]),
    getHandler({ "msg-html-only": htmlOnlyMsg }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });

  assert.equal(result.newDocs.length, 1);
  assert.ok(result.newDocs[0].content.includes("Hello"), "should have stripped HTML content");
  assert.ok(!result.newDocs[0].content.includes("<p>"), "should not contain raw HTML tags");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("OAuth2 token exchange failure propagates as transient error", async () => {
  const failFetch = makeFetch([
    {
      match: (url) => url.startsWith("https://oauth2.googleapis.com/"),
      respond: () => ({
        status: 503,
        data: { error: "service_unavailable", error_description: "try again" },
      }),
    },
  ]);
  const connector = createGmailConnector({ fetchFn: failFetch });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /OAuth2 token exchange failed/,
  );
});

test("OAuth2 token exchange 401 failure (invalid credentials) also throws", async () => {
  const failFetch = makeFetch([
    {
      match: (url) => url.startsWith("https://oauth2.googleapis.com/"),
      respond: () => ({
        status: 401,
        data: { error: "invalid_client", error_description: "bad credentials" },
      }),
    },
  ]);
  const connector = createGmailConnector({ fetchFn: failFetch });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /OAuth2 token exchange failed/,
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("cursor stores watermarkMs as epoch-ms string, not ISO (Thread 1 precision)", async () => {
  const preciseMs = "1745000000500"; // epoch ms ending in 500 ms
  const msg = makeMessage("msg-precise-1", preciseMs, "precise message");

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-precise-1")]),
    getHandler({ "msg-precise-1": msg }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: String(Number(preciseMs) - 1000), skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });

  const payload = JSON.parse(result.nextCursor.value) as Record<string, unknown>;
  assert.ok(typeof payload.watermarkMs === "string", "cursor must use watermarkMs");
  assert.equal(payload.watermarkIso, undefined, "cursor must NOT use watermarkIso");
  assert.equal(
    Number(payload.watermarkMs as string),
    Number(preciseMs),
    "watermark must preserve sub-second precision (not truncated to second)",
  );
});

test("sub-second messages in seenIds are not re-imported on the next poll (Thread 1)", async () => {
  const msA = "1745000000200";
  const msB = "1745000000800"; // highest — becomes watermark after poll 1
  const msgA = makeMessage("msg-subsec-a", msA, "sub-second message A");
  const msgB = makeMessage("msg-subsec-b", msB, "sub-second message B");

  const fetchFn1 = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-subsec-a"), makeMessageRef("msg-subsec-b")]),
    getHandler({ "msg-subsec-a": msgA, "msg-subsec-b": msgB }),
  ]);
  const connector1 = createGmailConnector({ fetchFn: fetchFn1 });
  const config = connector1.validateConfig({ ...SYNTHETIC_CREDS });
  const initialWatermarkMs = String(Number(msA) - 50); // 1745000000150, floor=1745000000
  const startCursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: initialWatermarkMs, skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result1 = await connector1.syncIncremental({ cursor: startCursor, config });
  assert.equal(result1.newDocs.length, 2, "poll 1 should import both messages");

  const cursor1Payload = JSON.parse(result1.nextCursor.value) as {
    watermarkMs: string;
    seenIds: Record<string, string>;
  };
  assert.equal(Number(cursor1Payload.watermarkMs), Number(msB), "watermark after poll 1 must be msB");
  assert.equal(
    Math.floor(Number(initialWatermarkMs) / 1000),
    Math.floor(Number(msB) / 1000),
    "test invariant: initial watermark and msB must be in the same second",
  );
  assert.ok(
    cursor1Payload.seenIds["msg-subsec-a"] !== undefined,
    "seenIds must include msg-subsec-a for sub-second dedup",
  );
  assert.ok(
    cursor1Payload.seenIds["msg-subsec-b"] !== undefined,
    "seenIds must include msg-subsec-b for sub-second dedup",
  );

  let getCallCount = 0;
  const fetchFn2 = makeFetch([
    tokenHandler(),
    // Gmail re-returns the same two messages because after:floor(msB/1000) includes them.
    listHandler([makeMessageRef("msg-subsec-a"), makeMessageRef("msg-subsec-b")]),
    {
      match: (url) => url.includes("format=full"),
      respond: () => {
        getCallCount++;
        return { status: 200, data: msgA };
      },
    },
  ]);
  const connector2 = createGmailConnector({ fetchFn: fetchFn2 });
  const result2 = await connector2.syncIncremental({ cursor: result1.nextCursor, config });

  assert.equal(result2.newDocs.length, 0, "poll 2 must not re-import same-second messages");
  assert.equal(getCallCount, 0, "poll 2 must not call messages.get for seenIds messages");
});

test("backward-compat: old watermarkIso cursor is migrated to watermarkMs (Thread 1)", async () => {
  const isoWatermark = new Date(Number(T1)).toISOString();
  const msg = makeMessage("msg-compat-1", T2, "compat migration test");

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-compat-1")]),
    getHandler({ "msg-compat-1": msg }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const legacyCursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkIso: isoWatermark }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor: legacyCursor, config });

  assert.equal(result.newDocs.length, 1, "should still import messages from legacy cursor");
  const nextPayload = JSON.parse(result.nextCursor.value) as Record<string, unknown>;
  assert.ok(typeof nextPayload.watermarkMs === "string", "next cursor must use watermarkMs");
  assert.equal(nextPayload.watermarkIso, undefined, "next cursor must not use watermarkIso");
  assert.equal(Number(nextPayload.watermarkMs as string), Number(T2), "watermark must advance to T2");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("empty message id is recorded in skippedIds (Thread 2)", async () => {
  const emptyMsg: GmailMessage = {
    id: "msg-empty-skip",
    internalDate: T1,
    payload: { mimeType: "text/plain", body: { data: "" } },
  };

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-empty-skip")]),
    getHandler({ "msg-empty-skip": emptyMsg }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;
  assert.equal(result.skippedEmpty, 1);

  const nextPayload = JSON.parse(result.nextCursor.value) as { skippedIds: Record<string, unknown> };
  assert.ok(
    typeof nextPayload.skippedIds["msg-empty-skip"] === "string" &&
      nextPayload.skippedIds["msg-empty-skip"].length > 0,
    "empty message id must be in skippedIds with an internalDate string",
  );
});

test("too-large message id is recorded in skippedIds (Thread 2)", async () => {
  const largeBody = "x".repeat(2 * 1024 * 1024 + 1);
  const largeMsg: GmailMessage = {
    id: "msg-toolarge-skip",
    internalDate: T1,
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from(largeBody, "utf-8").toString("base64url") },
    },
  };

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-toolarge-skip")]),
    getHandler({ "msg-toolarge-skip": largeMsg }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;
  assert.equal(result.skippedTooLarge, 1);

  const nextPayload = JSON.parse(result.nextCursor.value) as { skippedIds: Record<string, unknown> };
  assert.ok(
    typeof nextPayload.skippedIds["msg-toolarge-skip"] === "string" &&
      nextPayload.skippedIds["msg-toolarge-skip"].length > 0,
    "too-large message id must be in skippedIds with an internalDate string",
  );
});

test("inaccessible (404) message id is recorded in skippedIds (Thread 2)", async () => {
  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-404-skip")]),
    getHandler({}, { "msg-404-skip": 404 }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: "0", skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;
  assert.equal(result.skippedInaccessible, 1);

  const nextPayload = JSON.parse(result.nextCursor.value) as { skippedIds: Record<string, unknown> };
  assert.ok(
    typeof nextPayload.skippedIds["msg-404-skip"] === "string" &&
      nextPayload.skippedIds["msg-404-skip"].length > 0,
    "inaccessible message id must be in skippedIds with a date string",
  );
});

test("skippedIds messages are not re-fetched on subsequent polls (Thread 2 stall fix)", async () => {
  const goodMsg = makeMessage("msg-good-skip-bypass", T2, "good content for next poll");

  let getCallsForSkipped = 0;
  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([
      makeMessageRef("msg-empty-already-skipped"),
      makeMessageRef("msg-good-skip-bypass"),
    ]),
    {
      match: (url) => url.includes("format=full"),
      respond: (url) => {
        if (url.includes("msg-empty-already-skipped")) {
          getCallsForSkipped++;
        }
        return { status: 200, data: goodMsg };
      },
    },
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({
      watermarkMs: String(Number(T1) - 1000),
      skippedIds: { "msg-empty-already-skipped": true },
      seenIds: {},
    }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GmailSyncResult;

  assert.equal(result.newDocs.length, 1, "only the new good message should be imported");
  assert.equal(result.newDocs[0].source.externalId, "msg-good-skip-bypass");
  assert.equal(result.skippedEmpty, 0, "skipped-id messages must not count toward skippedEmpty again");
  assert.equal(getCallsForSkipped, 0, "messages.get must NOT be called for ids in skippedIds");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("after: query uses floor(watermarkMs/1000) — inclusive of the watermark second (Codex P1 PRRT_kwDORJXyws59sh5H)", async () => {
  //
  const subSecondWatermark = "1745000000500";

  let capturedAfterValue = "";
  const fetchFn = makeFetch([
    tokenHandler(),
    {
      match: (url) => url.includes("/messages") && !url.includes("format=full"),
      respond: (url) => {
        const qMatch = url.match(/[?&]q=([^&]+)/);
        if (qMatch) {
          const q = decodeURIComponent(qMatch[1]);
          const afterMatch = q.match(/after:(\d+)/);
          if (afterMatch) capturedAfterValue = afterMatch[1];
        }
        return { status: 200, data: { messages: [] } };
      },
    },
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: subSecondWatermark, skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await connector.syncIncremental({ cursor, config });

  assert.equal(
    capturedAfterValue,
    "1745000000",
    "after: must use Math.floor so messages at the watermark second boundary are not missed",
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("cursor persists pageToken when cap is hit mid-page with more pages remaining (Thread 2 Codex P1)", async () => {
  //


  //

  let listRequestUrls: string[] = [];
  const fetchFn = makeFetch([
    tokenHandler(),
    {
      match: (url) => url.includes("/messages") && !url.includes("format=full"),
      respond: (url) => {
        listRequestUrls.push(url);
        return { status: 200, data: {} };
      },
    },
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });

  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({
      watermarkMs: String(Number(T1)),
      skippedIds: {},
      seenIds: {},
      pageToken: "synthetic-page2-token-from-prev-pass",
    }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await connector.syncIncremental({ cursor, config });

  assert.ok(listRequestUrls.length > 0, "at least one list request was made");
  assert.ok(
    listRequestUrls[0].includes("pageToken=synthetic-page2-token-from-prev-pass"),
    `list request must include the persisted pageToken; got: ${listRequestUrls[0]}`,
  );
});

test("cursor's pageToken is cleared when the after: window is fully drained (Thread 2)", async () => {
  const msg1 = makeMessage("msg-drain-1", T2, "drain test message");

  const fetchFn = makeFetch([
    tokenHandler(),
    listHandler([makeMessageRef("msg-drain-1")]),
    getHandler({ "msg-drain-1": msg1 }),
  ]);
  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });

  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({
      watermarkMs: String(Number(T1) - 1000),
      skippedIds: {},
      seenIds: {},
      pageToken: "stale-page-token-to-be-cleared",
    }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });

  assert.equal(result.newDocs.length, 1);

  const payload = JSON.parse(result.nextCursor.value) as {
    pageToken?: string;
    watermarkMs: string;
  };
  assert.equal(
    payload.pageToken,
    undefined,
    "pageToken must be cleared from cursor when the after: window is fully drained",
  );
  assert.equal(Number(payload.watermarkMs), Number(T2));
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("isTransientHttpError classifies transient and terminal HTTP errors (Thread 3)", () => {
  // Transient — re-throw.
  assert.equal(isTransientHttpError({ status: 429 }), true);
  assert.equal(isTransientHttpError({ status: 500 }), true);
  assert.equal(isTransientHttpError({ status: 503 }), true);
  assert.equal(isTransientHttpError({ response: { status: 429 } }), true);
  assert.equal(isTransientHttpError({ response: { status: 502 } }), true);
  assert.equal(isTransientHttpError({ name: "AbortError" }), true);
  assert.equal(isTransientHttpError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientHttpError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientHttpError({ code: "ENOTFOUND" }), true);
  assert.equal(isTransientHttpError({ code: "EAI_AGAIN" }), true);
  assert.equal(isTransientHttpError(new Error("plain network error")), true);

  // Terminal — skip-and-continue.
  assert.equal(isTransientHttpError({ status: 404 }), false);
  assert.equal(isTransientHttpError({ response: { status: 403 } }), false);
  assert.equal(isTransientHttpError({ response: { status: 400 } }), false);
  assert.equal(isTransientHttpError({ response: { status: 410 } }), false);

  // Non-objects.
  assert.equal(isTransientHttpError(null), false);
  assert.equal(isTransientHttpError(undefined), false);
  assert.equal(isTransientHttpError("error string"), false);
  assert.equal(isTransientHttpError(42), false);
});

test("isTransientHttpError resolves connector-specific statusProps (Thread 3)", () => {
  assert.equal(isTransientHttpError({ gmailStatus: 429 }, ["gmailStatus"]), true);
  assert.equal(isTransientHttpError({ gmailStatus: 503 }, ["gmailStatus"]), true);
  assert.equal(isTransientHttpError({ gmailStatus: 404 }, ["gmailStatus"]), false);

  assert.equal(isTransientHttpError({ notionStatus: 429 }, ["notionStatus"]), true);
  assert.equal(isTransientHttpError({ notionStatus: 500 }, ["notionStatus"]), true);
  assert.equal(isTransientHttpError({ notionStatus: 403 }, ["notionStatus"]), false);

  assert.equal(isTransientHttpError({ status: 200, customStatus: 503 }, ["customStatus"]), true);
});

test("isTransientGmailError delegates to isTransientHttpError with gmailStatus (Thread 3)", () => {
  const cases: Array<[unknown, boolean]> = [
    [{ gmailStatus: 429 }, true],
    [{ gmailStatus: 503 }, true],
    [{ gmailStatus: 404 }, false],
    [{ response: { status: 429 } }, true],
    [{ code: "ECONNRESET" }, true],
    [{ name: "AbortError" }, true],
    [null, false],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      isTransientGmailError(input),
      expected,
      `isTransientGmailError(${JSON.stringify(input)}) should be ${expected}`,
    );
    assert.equal(
      isTransientHttpError(input, ["gmailStatus"]),
      expected,
      `isTransientHttpError(${JSON.stringify(input)}, ["gmailStatus"]) should be ${expected}`,
    );
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("pruneSeenIds removes entries that cannot be returned by after:floor(watermarkMs/1000)", () => {
  const seenIds: Record<string, string> = {
    "msg-at-floor":  "1745000000000", // exactly at floor boundary → pruned (not strictly above)
    "msg-above-1":   "1745000000100", // strictly above floor boundary → retained
    "msg-above-2":   "1745000000300", // retained
    "msg-at-wmark":  "1745000000500", // at watermark → retained
    "msg-new-1":     "1745000000600", // retained
    "msg-new-2":     "1745000000900", // retained
  };
  const result = pruneSeenIds(seenIds, 1745000000500);
  assert.equal(result["msg-at-floor"], undefined, "entry at floor boundary must be pruned (not strictly above it)");
  assert.equal(result["msg-above-1"], "1745000000100", "entry above floor boundary must be retained");
  assert.equal(result["msg-above-2"], "1745000000300", "entry above floor boundary must be retained");
  assert.equal(result["msg-at-wmark"], "1745000000500", "entry at watermark must be retained");
  assert.equal(result["msg-new-1"], "1745000000600", "entry above watermark must be retained");
  assert.equal(result["msg-new-2"], "1745000000900", "entry above watermark must be retained");
  assert.equal(Object.keys(result).length, 5);
});

test("pruneSeenIds prunes entries from a previous second (different second boundary)", () => {
  const seenIds: Record<string, string> = {
    "msg-prev-sec": "1745000001500", // second 1745000001 → pruned (< floor boundary)
    "msg-at-sec2":  "1745000002000", // exactly at floor boundary → pruned
    "msg-in-sec2":  "1745000002300", // in second 2, above floor → retained
    "msg-at-wmark": "1745000002500", // at watermark → retained
  };
  const result = pruneSeenIds(seenIds, 1745000002500);
  assert.equal(result["msg-prev-sec"], undefined, "message from previous second must be pruned");
  assert.equal(result["msg-at-sec2"], undefined, "message exactly at floor boundary must be pruned");
  assert.equal(result["msg-in-sec2"], "1745000002300", "message in current second above floor must be retained");
  assert.equal(result["msg-at-wmark"], "1745000002500", "message at watermark must be retained");
});

test("pruneSeenIds with empty seenIds returns empty map", () => {
  assert.deepEqual(pruneSeenIds({}, 1745000000000), {});
});

test("pruneSeenIds retains all entries when all are in the same floor-second as watermark", () => {
  const seenIds: Record<string, string> = {
    "msg-a": "1745000000100",
    "msg-b": "1745000000900",
  };
  assert.deepEqual(pruneSeenIds(seenIds, 1745000000500), seenIds);
});

test("pruneSeenIds enforces hard cap: evicts to SEEN_IDS_RETAIN when count exceeds SEEN_IDS_MAX", () => {
  const seenIds: Record<string, string> = {};
  for (let i = 0; i < SEEN_IDS_MAX + 10; i++) {
    seenIds[`msg-cap-${i}`] = String(1_000_000 + i); // all >= watermark=0
  }
  const result = pruneSeenIds(seenIds, 0);
  assert.equal(
    Object.keys(result).length,
    SEEN_IDS_RETAIN,
    `after cap eviction, count must equal SEEN_IDS_RETAIN (${SEEN_IDS_RETAIN})`,
  );
});

test("pruneSeenIds cap eviction retains the most recent entries (highest internalDate)", () => {
  const seenIds: Record<string, string> = {};
  const totalEntries = SEEN_IDS_MAX + 50;
  for (let i = 0; i < totalEntries; i++) {
    seenIds[`msg-cap-${i}`] = String(2_000_000 + i);
  }
  const result = pruneSeenIds(seenIds, 0);
  assert.equal(Object.keys(result).length, SEEN_IDS_RETAIN);
  const lowestRetained = 2_000_000 + (totalEntries - SEEN_IDS_RETAIN);
  for (const [, dateMs] of Object.entries(result)) {
    assert.ok(Number(dateMs) >= lowestRetained, `retained entry ${dateMs} must be >= ${lowestRetained}`);
  }
});

test("pruneSeenIds does not evict when below cap", () => {
  const seenIds: Record<string, string> = {};
  const count = SEEN_IDS_MAX - 1;
  for (let i = 0; i < count; i++) {
    seenIds[`msg-small-${i}`] = String(1_000_000 + i);
  }
  const result = pruneSeenIds(seenIds, 0);
  assert.equal(Object.keys(result).length, count, "no eviction when below cap");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("cursor saves the CURRENT page token when cap is hit mid-page (not next page token)", async () => {
  const baseMs = Number(T1);
  const msgRefs: GmailMessageRef[] = [];
  const msgMap: Record<string, GmailMessage> = {};
  for (let i = 0; i < MAX_MESSAGES_PER_PASS; i++) {
    const id = `msg-cpt-${i}`;
    msgRefs.push({ id });
    msgMap[id] = makeMessage(id, String(baseMs + i), `body ${i}`);
  }
  msgRefs.push({ id: "msg-cpt-extra" });
  msgMap["msg-cpt-extra"] = makeMessage("msg-cpt-extra", String(baseMs + MAX_MESSAGES_PER_PASS), "extra");

  const fetchFn = makeFetch([
    tokenHandler(),
    {
      match: (url) => url.includes("/messages") && !url.includes("format=full"),
      respond: () => ({
        status: 200,
        data: { messages: msgRefs, nextPageToken: "next-page" },
      }),
    },
    getHandler(msgMap),
  ]);

  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({
      watermarkMs: String(Number(T1) - 1000),
      skippedIds: {},
      seenIds: {},
      pageToken: "current-page-token",
    }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });
  assert.equal(result.newDocs.length, MAX_MESSAGES_PER_PASS, "must process exactly MAX_MESSAGES_PER_PASS messages");

  const payload = JSON.parse(result.nextCursor.value) as { pageToken?: string };
  assert.equal(
    payload.pageToken,
    "current-page-token",
    "when cap hits mid-page, cursor must save the CURRENT page token so next poll re-fetches this page",
  );
});

test("cursor saves undefined pageToken when cap is hit on page 1 (no prior pageToken)", async () => {
  const baseMs = Number(T1);
  const msgRefs: GmailMessageRef[] = [];
  const msgMap: Record<string, GmailMessage> = {};
  for (let i = 0; i < MAX_MESSAGES_PER_PASS; i++) {
    const id = `msg-p1cap-${i}`;
    msgRefs.push({ id });
    msgMap[id] = makeMessage(id, String(baseMs + i), `body ${i}`);
  }
  msgRefs.push({ id: "msg-p1cap-extra" });
  msgMap["msg-p1cap-extra"] = makeMessage("msg-p1cap-extra", String(baseMs + MAX_MESSAGES_PER_PASS), "extra");

  const fetchFn = makeFetch([
    tokenHandler(),
    {
      match: (url) => url.includes("/messages") && !url.includes("format=full"),
      respond: () => ({
        status: 200,
        data: { messages: msgRefs, nextPageToken: "hypothetical-next" },
      }),
    },
    getHandler(msgMap),
  ]);

  const connector = createGmailConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify({ watermarkMs: String(Number(T1) - 1000), skippedIds: {}, seenIds: {} }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });
  assert.equal(result.newDocs.length, MAX_MESSAGES_PER_PASS);

  const payload = JSON.parse(result.nextCursor.value) as { pageToken?: string };
  assert.equal(
    payload.pageToken,
    undefined,
    "when cap hits on page 1, cursor pageToken must be undefined so next poll re-fetches from page 1",
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("validateGmailConfig rejects non-numeric string pollIntervalMs (Codex P2)", () => {
  assert.throws(
    () => validateGmailConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: "abc" }),
    /pollIntervalMs/,
    "non-numeric string pollIntervalMs must be rejected explicitly",
  );
});

test("validateGmailConfig rejects NaN pollIntervalMs (Codex P2)", () => {
  assert.throws(
    () => validateGmailConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: NaN }),
    /pollIntervalMs/,
    "NaN pollIntervalMs must be rejected explicitly",
  );
});

test("validateGmailConfig rejects Infinity pollIntervalMs (Codex P2)", () => {
  assert.throws(
    () => validateGmailConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: Infinity }),
    /pollIntervalMs/,
    "Infinity pollIntervalMs must be rejected explicitly",
  );
});
