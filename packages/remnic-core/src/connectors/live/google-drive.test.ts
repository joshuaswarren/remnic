import assert from "node:assert/strict";
import test from "node:test";

import {
  GOOGLE_DRIVE_CONNECTOR_ID,
  GOOGLE_DRIVE_CURSOR_KIND,
  createGoogleDriveConnector,
  isTransientDriveError,
  validateGoogleDriveConfig,
  type DriveChange,
  type DriveChangesPage,
  type DriveFileMetadata,
  type GoogleDriveClient,
  type GoogleDriveClientFactory,
  type GoogleDriveSyncResult,
} from "./index.js";
import type { ConnectorConfig, ConnectorCursor } from "./framework.js";

/**
 * Tests for the Google Drive connector (#683 PR 2/N). All Drive API calls
 * are stubbed via the `GoogleDriveClientFactory` test hook — the test
 * suite never imports `googleapis` and never touches the network.
 *
 * Per CLAUDE.md privacy rules: no real credentials, no real folder ids,
 * no real file ids. All inputs are obviously-synthetic strings shaped
 * roughly like the real values.
 */

const SYNTHETIC_CREDS = Object.freeze({
  clientId: "synthetic-client-id.apps.googleusercontent.com",
  clientSecret: "synthetic-client-secret-DO-NOT-USE",
  refreshToken: "synthetic-refresh-token-DO-NOT-USE",
});

function makeChange(file: Partial<DriveFileMetadata> & { id: string }): DriveChange {
  return {
    fileId: file.id,
    file: {
      name: "synthetic title",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: "2026-04-25T00:00:00.000Z",
      ...file,
    },
  };
}

function makeMockClient(opts: {
  startPageToken?: string;
  pages?: DriveChangesPage[];
  exportContent?: (fileId: string, mimeType: string) => string;
  mediaContent?: (fileId: string) => string;
  recordCalls?: { exports: Array<{ fileId: string; mimeType: string }>; media: string[] };
}): GoogleDriveClient {
  const pages = opts.pages ?? [];
  let pageIdx = 0;
  return {
    async getStartPageToken() {
      return { startPageToken: opts.startPageToken ?? "seed-token-1" };
    },
    async listChanges() {
      const page = pages[pageIdx] ?? { changes: [], newStartPageToken: "final-token" };
      pageIdx++;
      return page;
    },
    async exportFile({ fileId, mimeType }) {
      opts.recordCalls?.exports.push({ fileId, mimeType });
      return opts.exportContent ? opts.exportContent(fileId, mimeType) : `EXPORTED:${fileId}`;
    },
    async getFileMedia({ fileId }) {
      opts.recordCalls?.media.push(fileId);
      return opts.mediaContent ? opts.mediaContent(fileId) : `MEDIA:${fileId}`;
    },
  };
}

function makeFactory(client: GoogleDriveClient): GoogleDriveClientFactory {
  return async () => client;
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test("validateGoogleDriveConfig accepts a minimal valid config", () => {
  const cfg = validateGoogleDriveConfig({ ...SYNTHETIC_CREDS });
  assert.equal(cfg.clientId, SYNTHETIC_CREDS.clientId);
  assert.equal(cfg.pollIntervalMs, 300_000);
  assert.deepEqual([...cfg.folderIds], []);
});

test("validateGoogleDriveConfig rejects non-object input", () => {
  assert.throws(() => validateGoogleDriveConfig(null), /must be an object/);
  assert.throws(() => validateGoogleDriveConfig([]), /must be an object/);
  assert.throws(() => validateGoogleDriveConfig("nope"), /must be an object/);
});

test("validateGoogleDriveConfig rejects missing credentials", () => {
  assert.throws(
    () => validateGoogleDriveConfig({ clientSecret: "x", refreshToken: "y" }),
    /clientId/,
  );
  assert.throws(
    () => validateGoogleDriveConfig({ clientId: "x", refreshToken: "y" }),
    /clientSecret/,
  );
  assert.throws(
    () => validateGoogleDriveConfig({ clientId: "x", clientSecret: "y" }),
    /refreshToken/,
  );
  assert.throws(
    () => validateGoogleDriveConfig({ ...SYNTHETIC_CREDS, clientId: "   " }),
    /clientId.*non-empty/,
  );
});

test("validateGoogleDriveConfig rejects malformed pollIntervalMs", () => {
  // Non-number — should throw, never silently default. CLAUDE.md #51.
  assert.throws(
    () => validateGoogleDriveConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: "300000" }),
    /pollIntervalMs/,
  );
  // Below the floor.
  assert.throws(
    () => validateGoogleDriveConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: 50 }),
    /≥1000/,
  );
  // Above the ceiling.
  assert.throws(
    () =>
      validateGoogleDriveConfig({
        ...SYNTHETIC_CREDS,
        pollIntervalMs: 25 * 60 * 60 * 1000,
      }),
    /≤/,
  );
  // Non-integer.
  assert.throws(
    () => validateGoogleDriveConfig({ ...SYNTHETIC_CREDS, pollIntervalMs: 3000.5 }),
    /integer/,
  );
});

test("validateGoogleDriveConfig validates and dedupes folderIds", () => {
  const cfg = validateGoogleDriveConfig({
    ...SYNTHETIC_CREDS,
    folderIds: [
      "1AbCdEfGh_synthetic_folder_aaaaa",
      "1AbCdEfGh_synthetic_folder_aaaaa", // dup
      "1AbCdEfGh_synthetic_folder_bbbbb",
    ],
  });
  assert.deepEqual([...cfg.folderIds], [
    "1AbCdEfGh_synthetic_folder_aaaaa",
    "1AbCdEfGh_synthetic_folder_bbbbb",
  ]);
});

test("validateGoogleDriveConfig rejects malformed folderIds", () => {
  assert.throws(
    () => validateGoogleDriveConfig({ ...SYNTHETIC_CREDS, folderIds: "not-an-array" }),
    /folderIds.*array/,
  );
  assert.throws(
    () => validateGoogleDriveConfig({ ...SYNTHETIC_CREDS, folderIds: [42] }),
    /folderIds.*strings/,
  );
  // Path-traversal-shaped ids must be rejected.
  assert.throws(
    () => validateGoogleDriveConfig({ ...SYNTHETIC_CREDS, folderIds: ["../etc/passwd"] }),
    /not a valid Drive folder id/,
  );
  // Too short — fewer than 8 chars.
  assert.throws(
    () => validateGoogleDriveConfig({ ...SYNTHETIC_CREDS, folderIds: ["short"] }),
    /not a valid Drive folder id/,
  );
});

// ---------------------------------------------------------------------------
// Connector identity
// ---------------------------------------------------------------------------

test("createGoogleDriveConnector exposes the documented id and display name", () => {
  const connector = createGoogleDriveConnector({
    clientFactory: makeFactory(makeMockClient({})),
  });
  assert.equal(connector.id, GOOGLE_DRIVE_CONNECTOR_ID);
  assert.equal(connector.displayName, "Google Drive");
});

// ---------------------------------------------------------------------------
// First-sync bootstrap behavior
// ---------------------------------------------------------------------------

test("first sync (cursor=null) returns no docs and seeds the cursor", async () => {
  const client = makeMockClient({ startPageToken: "seed-A" });
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });

  const result = await connector.syncIncremental({ cursor: null, config });

  assert.deepEqual(result.newDocs, []);
  assert.equal(result.nextCursor.kind, GOOGLE_DRIVE_CURSOR_KIND);
  assert.equal(result.nextCursor.value, "seed-A");
});

test("first sync rejects an empty start token from upstream", async () => {
  const client = makeMockClient({ startPageToken: "" });
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });

  await assert.rejects(
    connector.syncIncremental({ cursor: null, config }),
    /returned an empty token/,
  );
});

// ---------------------------------------------------------------------------
// Incremental sync produces expected memory-import events
// ---------------------------------------------------------------------------

test("incremental sync emits ConnectorDocument entries for Google-native files", async () => {
  const recordCalls = { exports: [] as Array<{ fileId: string; mimeType: string }>, media: [] as string[] };
  const page: DriveChangesPage = {
    changes: [
      makeChange({ id: "fileid-doc-1", name: "Doc One", mimeType: "application/vnd.google-apps.document" }),
      makeChange({ id: "fileid-sheet-1", name: "Sheet One", mimeType: "application/vnd.google-apps.spreadsheet" }),
    ],
    newStartPageToken: "next-token-2",
  };
  const client = makeMockClient({
    pages: [page],
    exportContent: (id, mime) => `EXPORT:${id}:${mime}`,
    recordCalls,
  });
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "prev-token-1",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GoogleDriveSyncResult;

  assert.equal(result.newDocs.length, 2);
  assert.equal(result.newDocs[0].source.connector, GOOGLE_DRIVE_CONNECTOR_ID);
  assert.equal(result.newDocs[0].source.externalId, "fileid-doc-1");
  assert.equal(result.newDocs[0].source.externalRevision, "2026-04-25T00:00:00.000Z");
  assert.match(result.newDocs[0].content, /^EXPORT:fileid-doc-1:text\/plain$/);
  assert.match(result.newDocs[1].content, /^EXPORT:fileid-sheet-1:text\/csv$/);
  assert.equal(result.nextCursor.value, "next-token-2");
  assert.equal(recordCalls.exports.length, 2);
  assert.equal(recordCalls.media.length, 0);
});

test("incremental sync uses media download for plain-text MIME types", async () => {
  const recordCalls = { exports: [] as Array<{ fileId: string; mimeType: string }>, media: [] as string[] };
  const page: DriveChangesPage = {
    changes: [
      makeChange({ id: "fileid-readme", mimeType: "text/markdown", name: "README" }),
      makeChange({ id: "fileid-config", mimeType: "application/json", name: "config" }),
    ],
    newStartPageToken: "tok-end",
  };
  const client = makeMockClient({
    pages: [page],
    mediaContent: (id) => `MEDIA:${id}`,
    recordCalls,
  });
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "prev",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });
  assert.equal(result.newDocs.length, 2);
  assert.deepEqual(recordCalls.media.sort(), ["fileid-config", "fileid-readme"]);
  assert.equal(recordCalls.exports.length, 0);
});

test("incremental sync skips binary, trashed, removed, and oversize files", async () => {
  const page: DriveChangesPage = {
    changes: [
      // Binary — not in our text allowlist.
      makeChange({ id: "fileid-img", mimeType: "image/png" }),
      // Trashed.
      makeChange({ id: "fileid-trash", mimeType: "application/vnd.google-apps.document", trashed: true }),
      // Removed (no `file` payload).
      { removed: true, fileId: "fileid-removed" },
      // Oversize.
      makeChange({
        id: "fileid-huge",
        mimeType: "text/plain",
        size: String(50 * 1024 * 1024),
      }),
      // OK — should still come through.
      makeChange({ id: "fileid-ok", mimeType: "text/plain", size: 100 }),
    ],
    newStartPageToken: "tok-end",
  };
  const client = makeMockClient({
    pages: [page],
    mediaContent: (id) => `MEDIA:${id}`,
  });
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "p",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GoogleDriveSyncResult;
  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, "fileid-ok");
  assert.equal(result.skippedBinary, 1);
  assert.equal(result.skippedTooLarge, 1);
});

test("folder scope filters out files whose parents do not intersect", async () => {
  const inFolder = "1AbCdEfGh_synthetic_folder_in____";
  const otherFolder = "1AbCdEfGh_synthetic_folder_other_";
  const page: DriveChangesPage = {
    changes: [
      makeChange({ id: "fileid-in", mimeType: "text/plain", parents: [inFolder] }),
      makeChange({ id: "fileid-out", mimeType: "text/plain", parents: [otherFolder] }),
      makeChange({ id: "fileid-noparents", mimeType: "text/plain" }),
    ],
    newStartPageToken: "tok-end",
  };
  const client = makeMockClient({ pages: [page], mediaContent: (id) => `MEDIA:${id}` });
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({
    ...SYNTHETIC_CREDS,
    folderIds: [inFolder],
  });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "p",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GoogleDriveSyncResult;
  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, "fileid-in");
  assert.equal(result.skippedFolderScope, 2);
});

test("a single 404 in fetchDocument does not poison the whole pass", async () => {
  const page: DriveChangesPage = {
    changes: [
      makeChange({ id: "fileid-good", mimeType: "text/plain" }),
      makeChange({ id: "fileid-404", mimeType: "text/plain" }),
      makeChange({ id: "fileid-also-good", mimeType: "text/plain" }),
    ],
    newStartPageToken: "tok-end",
  };
  const client: GoogleDriveClient = {
    async getStartPageToken() {
      return { startPageToken: "seed" };
    },
    async listChanges() {
      return page;
    },
    async exportFile() {
      throw new Error("unexpected export call");
    },
    async getFileMedia({ fileId }) {
      if (fileId === "fileid-404") throw Object.assign(new Error("not found"), { status: 404 });
      return `MEDIA:${fileId}`;
    },
  };
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "p",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });
  assert.equal(result.newDocs.length, 2);
  assert.deepEqual(
    result.newDocs.map((d) => d.source.externalId).sort(),
    ["fileid-also-good", "fileid-good"],
  );
});

test("a 403 permission-denied is treated as terminal (skip-and-continue, cursor advances)", async () => {
  // 403 mirrors 404: the file is inaccessible and won't become accessible
  // by retrying. Skip-and-log is the right call. Cursor advance is fine.
  const page: DriveChangesPage = {
    changes: [
      makeChange({ id: "fileid-good", mimeType: "text/plain" }),
      makeChange({ id: "fileid-403", mimeType: "text/plain" }),
    ],
    newStartPageToken: "tok-end",
  };
  const client: GoogleDriveClient = {
    async getStartPageToken() {
      return { startPageToken: "seed" };
    },
    async listChanges() {
      return page;
    },
    async exportFile() {
      throw new Error("unexpected export call");
    },
    async getFileMedia({ fileId }) {
      if (fileId === "fileid-403") {
        throw Object.assign(new Error("permission denied"), {
          response: { status: 403 },
        });
      }
      return `MEDIA:${fileId}`;
    },
  };
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "p",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  const result = await connector.syncIncremental({ cursor, config });
  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, "fileid-good");
  // Cursor MUST advance for terminal errors — there's nothing to retry.
  assert.equal(result.nextCursor.value, "tok-end");
});

test("a transient 429 re-throws and the cursor does NOT advance", async () => {
  // CLAUDE.md gotcha: silently swallowing transient errors permanently
  // loses imports during outages. 429 must surface so the connector
  // framework can back off and retry on the next poll using the
  // pre-existing cursor.
  const page: DriveChangesPage = {
    changes: [
      makeChange({ id: "fileid-good", mimeType: "text/plain" }),
      makeChange({ id: "fileid-429", mimeType: "text/plain" }),
      makeChange({ id: "fileid-never-tried", mimeType: "text/plain" }),
    ],
    newStartPageToken: "tok-end",
  };
  const client: GoogleDriveClient = {
    async getStartPageToken() {
      return { startPageToken: "seed" };
    },
    async listChanges() {
      return page;
    },
    async exportFile() {
      throw new Error("unexpected export call");
    },
    async getFileMedia({ fileId }) {
      if (fileId === "fileid-429") {
        throw Object.assign(new Error("rate limit exceeded"), {
          response: { status: 429 },
          code: 429,
        });
      }
      return `MEDIA:${fileId}`;
    },
  };
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "prev-token",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /rate limit/,
  );
  // The cursor is NEVER persisted by the connector itself — the framework
  // only writes nextCursor on a successful return. By throwing, we ensure
  // the framework keeps `prev-token` as the persisted cursor and retries
  // the same batch on the next poll. (We cannot directly assert "did not
  // advance" inside the connector because nextCursor is only ever returned
  // on success, but the contract is exactly that: throw → caller does not
  // see a nextCursor → cursor cannot advance.)
});

test("a transient 503 re-throws", async () => {
  const page: DriveChangesPage = {
    changes: [makeChange({ id: "fileid-503", mimeType: "text/plain" })],
    newStartPageToken: "tok-end",
  };
  const client: GoogleDriveClient = {
    async getStartPageToken() {
      return { startPageToken: "seed" };
    },
    async listChanges() {
      return page;
    },
    async exportFile() {
      throw new Error("unexpected export call");
    },
    async getFileMedia() {
      throw Object.assign(new Error("service unavailable"), {
        response: { status: 503 },
      });
    },
  };
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "p",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /service unavailable/,
  );
});

test("an AbortError raised mid-fetch re-throws", async () => {
  const page: DriveChangesPage = {
    changes: [makeChange({ id: "fileid-aborted", mimeType: "text/plain" })],
    newStartPageToken: "tok-end",
  };
  const client: GoogleDriveClient = {
    async getStartPageToken() {
      return { startPageToken: "seed" };
    },
    async listChanges() {
      return page;
    },
    async exportFile() {
      throw new Error("unexpected export call");
    },
    async getFileMedia() {
      throw Object.assign(new Error("request aborted"), { name: "AbortError" });
    },
  };
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "p",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /aborted/,
  );
});

test("a network-layer ECONNRESET re-throws as transient", async () => {
  const page: DriveChangesPage = {
    changes: [makeChange({ id: "fileid-network", mimeType: "text/plain" })],
    newStartPageToken: "tok-end",
  };
  const client: GoogleDriveClient = {
    async getStartPageToken() {
      return { startPageToken: "seed" };
    },
    async listChanges() {
      return page;
    },
    async exportFile() {
      throw new Error("unexpected export call");
    },
    async getFileMedia() {
      // No HTTP status — pure network error.
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    },
  };
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "p",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /socket hang up/,
  );
});

test("isTransientDriveError classifies common error shapes", () => {
  // Terminal — skip-and-continue.
  assert.equal(isTransientDriveError({ status: 404 }), false);
  assert.equal(isTransientDriveError({ response: { status: 403 } }), false);
  assert.equal(isTransientDriveError({ response: { status: 400 } }), false);
  assert.equal(isTransientDriveError({ response: { status: 410 } }), false);
  // Transient — re-throw.
  assert.equal(isTransientDriveError({ response: { status: 429 } }), true);
  assert.equal(isTransientDriveError({ response: { status: 500 } }), true);
  assert.equal(isTransientDriveError({ response: { status: 503 } }), true);
  assert.equal(isTransientDriveError({ status: 504 }), true);
  // GaxiosError-style string code.
  assert.equal(isTransientDriveError({ code: "429" }), true);
  assert.equal(isTransientDriveError({ code: "503" }), true);
  // Network errors.
  assert.equal(isTransientDriveError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientDriveError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientDriveError({ code: "ENOTFOUND" }), true);
  assert.equal(isTransientDriveError({ code: "EAI_AGAIN" }), true);
  // AbortError.
  assert.equal(isTransientDriveError({ name: "AbortError" }), true);
  // Bare Error with no metadata — conservatively transient.
  assert.equal(isTransientDriveError(new Error("unknown")), true);
  // Non-objects.
  assert.equal(isTransientDriveError(null), false);
  assert.equal(isTransientDriveError(undefined), false);
  assert.equal(isTransientDriveError("oops"), false);
});

test("syncIncremental honors abortSignal between pages", async () => {
  const controller = new AbortController();
  const page1: DriveChangesPage = {
    changes: [makeChange({ id: "fileid-a", mimeType: "text/plain" })],
    nextPageToken: "pg-2",
  };
  const page2: DriveChangesPage = {
    changes: [makeChange({ id: "fileid-b", mimeType: "text/plain" })],
    newStartPageToken: "tok-end",
  };
  let pageIdx = 0;
  const client: GoogleDriveClient = {
    async getStartPageToken() {
      return { startPageToken: "seed" };
    },
    async listChanges() {
      const page = pageIdx === 0 ? page1 : page2;
      pageIdx++;
      // Abort after page 1.
      if (pageIdx === 1) controller.abort();
      return page;
    },
    async exportFile() {
      return "x";
    },
    async getFileMedia({ fileId }) {
      return `MEDIA:${fileId}`;
    },
  };
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  const config = connector.validateConfig({ ...SYNTHETIC_CREDS });
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "p",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor, config, abortSignal: controller.signal }),
    /aborted/,
  );
});

test("syncIncremental rejects a cursor of an unexpected kind", async () => {
  const client = makeMockClient({});
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
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
  const client = makeMockClient({});
  const connector = createGoogleDriveConnector({ clientFactory: makeFactory(client) });
  // Bypass the boundary by passing a raw config that wouldn't survive
  // validation. The framework persists the validated config but we want
  // to make sure a JS caller cannot smuggle bad state into a sync.
  const badConfig = { clientId: "ok", clientSecret: "ok", refreshToken: "" } as unknown as ConnectorConfig;
  const cursor: ConnectorCursor = {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value: "p",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };
  await assert.rejects(
    connector.syncIncremental({ cursor, config: badConfig }),
    /refreshToken/,
  );
});
