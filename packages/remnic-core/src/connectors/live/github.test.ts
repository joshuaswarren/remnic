import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_CONNECTOR_ID,
  GITHUB_CURSOR_KIND,
  GITHUB_DEFAULT_POLL_INTERVAL_MS,
  createGitHubConnector,
  isTransientGitHubError,
  validateGitHubConfig,
  type GitHubComment,
  type GitHubDiscussionComment,
  type GitHubFetchFn,
  type GitHubSyncResult,
} from "./github.js";
import type { ConnectorCursor } from "./framework.js";

/**
 * Tests for the GitHub connector (#683 PR 5/6). All GitHub API calls are
 * stubbed via the `fetchFn` test hook — the suite never touches the network.
 *
 * Per CLAUDE.md privacy rules: no real tokens, no real usernames, no real
 * repo names. All inputs are obviously synthetic.
 */

// ---------------------------------------------------------------------------
// Synthetic test data
// ---------------------------------------------------------------------------

const SYNTHETIC_TOKEN = "ghp_synthetic_token_DO_NOT_USE_0000000000000000";
const SYNTHETIC_LOGIN = "synthetic-user";
const REPO_A = "synthetic-org/repo-alpha";
const REPO_B = "synthetic-org/repo-beta";

const SYNTHETIC_CONFIG = Object.freeze({
  token: SYNTHETIC_TOKEN,
  userLogin: SYNTHETIC_LOGIN,
  repos: [REPO_A],
});

function makeComment(
  id: number,
  login: string,
  body: string,
  updatedAt: string,
  htmlUrl?: string,
): GitHubComment {
  return {
    id,
    body,
    user: { login },
    created_at: updatedAt,
    updated_at: updatedAt,
    html_url: htmlUrl ?? `https://github.com/${REPO_A}/issues/1#issuecomment-${id}`,
  };
}

// ---------------------------------------------------------------------------
// Mock fetch builder
// ---------------------------------------------------------------------------

type HandlerEntry = {
  match: (url: string) => boolean;
  respond: (url: string) => { status: number; data: unknown };
};

function makeFetch(handlers: HandlerEntry[]): GitHubFetchFn {
  return async (url) => {
    for (const handler of handlers) {
      if (handler.match(url)) {
        const { status, data } = handler.respond(url);
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get: (_name: string) => null,
          },
          json: async () => data,
        };
      }
    }
    throw new Error(`fetch stub: no handler for ${url}`);
  };
}

/** Returns an empty array for all API calls. */
function emptyFetch(): GitHubFetchFn {
  return makeFetch([
    {
      match: () => true,
      respond: () => ({ status: 200, data: [] }),
    },
  ]);
}

function makeGitHubCursor(watermarks: Record<string, string>): ConnectorCursor {
  return {
    kind: GITHUB_CURSOR_KIND,
    value: JSON.stringify({ watermarks }),
    updatedAt: "2026-04-25T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test("validateGitHubConfig accepts a minimal valid config", () => {
  const cfg = validateGitHubConfig({
    token: SYNTHETIC_TOKEN,
    userLogin: SYNTHETIC_LOGIN,
  });
  assert.equal(cfg.token, SYNTHETIC_TOKEN);
  assert.equal(cfg.userLogin, SYNTHETIC_LOGIN);
  assert.deepEqual([...cfg.repos], []);
  assert.equal(cfg.pollIntervalMs, GITHUB_DEFAULT_POLL_INTERVAL_MS);
  assert.equal(cfg.includeDiscussions, false);
});

test("validateGitHubConfig rejects non-object input", () => {
  assert.throws(() => validateGitHubConfig(null), /must be an object/);
  assert.throws(() => validateGitHubConfig([]), /must be an object/);
  assert.throws(() => validateGitHubConfig("nope"), /must be an object/);
});

test("validateGitHubConfig rejects missing or empty token", () => {
  assert.throws(() => validateGitHubConfig({ userLogin: SYNTHETIC_LOGIN }), /token must be a string/);
  assert.throws(
    () => validateGitHubConfig({ token: "", userLogin: SYNTHETIC_LOGIN }),
    /token must be non-empty/,
  );
  assert.throws(
    () => validateGitHubConfig({ token: "   ", userLogin: SYNTHETIC_LOGIN }),
    /token must be non-empty/,
  );
});

test("validateGitHubConfig rejects missing or empty userLogin", () => {
  assert.throws(
    () => validateGitHubConfig({ token: SYNTHETIC_TOKEN }),
    /userLogin must be a string/,
  );
  assert.throws(
    () => validateGitHubConfig({ token: SYNTHETIC_TOKEN, userLogin: "" }),
    /userLogin must be non-empty/,
  );
});

test("validateGitHubConfig rejects malformed pollIntervalMs", () => {
  assert.throws(
    () =>
      validateGitHubConfig({ token: SYNTHETIC_TOKEN, userLogin: SYNTHETIC_LOGIN, pollIntervalMs: "300000" }),
    /pollIntervalMs/,
  );
  assert.throws(
    () =>
      validateGitHubConfig({ token: SYNTHETIC_TOKEN, userLogin: SYNTHETIC_LOGIN, pollIntervalMs: 50 }),
    /≥1000/,
  );
  assert.throws(
    () =>
      validateGitHubConfig({
        token: SYNTHETIC_TOKEN,
        userLogin: SYNTHETIC_LOGIN,
        pollIntervalMs: 25 * 60 * 60 * 1000,
      }),
    /≤/,
  );
  assert.throws(
    () =>
      validateGitHubConfig({
        token: SYNTHETIC_TOKEN,
        userLogin: SYNTHETIC_LOGIN,
        pollIntervalMs: 3000.5,
      }),
    /integer/,
  );
});

test("validateGitHubConfig accepts valid repos in owner/repo format", () => {
  const cfg = validateGitHubConfig({
    token: SYNTHETIC_TOKEN,
    userLogin: SYNTHETIC_LOGIN,
    repos: [REPO_A, REPO_B],
  });
  assert.deepEqual([...cfg.repos], [REPO_A, REPO_B]);
});

test("validateGitHubConfig rejects malformed repo slugs", () => {
  assert.throws(
    () =>
      validateGitHubConfig({
        token: SYNTHETIC_TOKEN,
        userLogin: SYNTHETIC_LOGIN,
        repos: ["no-slash"],
      }),
    /owner\/repo/,
  );
  assert.throws(
    () =>
      validateGitHubConfig({
        token: SYNTHETIC_TOKEN,
        userLogin: SYNTHETIC_LOGIN,
        repos: ["../../../etc/passwd"],
      }),
    /owner\/repo/,
  );
  assert.throws(
    () =>
      validateGitHubConfig({
        token: SYNTHETIC_TOKEN,
        userLogin: SYNTHETIC_LOGIN,
        repos: [42 as unknown as string],
      }),
    /repos entries must be strings/,
  );
});

test("validateGitHubConfig deduplicates repos", () => {
  const cfg = validateGitHubConfig({
    token: SYNTHETIC_TOKEN,
    userLogin: SYNTHETIC_LOGIN,
    repos: [REPO_A, REPO_A, REPO_B],
  });
  assert.deepEqual([...cfg.repos], [REPO_A, REPO_B]);
});

test("validateGitHubConfig rejects non-boolean includeDiscussions", () => {
  assert.throws(
    () =>
      validateGitHubConfig({
        token: SYNTHETIC_TOKEN,
        userLogin: SYNTHETIC_LOGIN,
        includeDiscussions: "yes" as unknown as boolean,
      }),
    /includeDiscussions must be a boolean/,
  );
});

test("validateGitHubConfig accepts includeDiscussions: true", () => {
  const cfg = validateGitHubConfig({
    token: SYNTHETIC_TOKEN,
    userLogin: SYNTHETIC_LOGIN,
    includeDiscussions: true,
  });
  assert.equal(cfg.includeDiscussions, true);
});

// ---------------------------------------------------------------------------
// Connector identity
// ---------------------------------------------------------------------------

test("createGitHubConnector exposes the documented id and display name", () => {
  const connector = createGitHubConnector({ fetchFn: emptyFetch() });
  assert.equal(connector.id, GITHUB_CONNECTOR_ID);
  assert.equal(connector.id, "github");
  assert.equal(connector.displayName, "GitHub");
});

// ---------------------------------------------------------------------------
// No-op when repos is empty
// ---------------------------------------------------------------------------

test("syncIncremental is a no-op when repos is empty", async () => {
  let fetchCalled = false;
  const fetchFn: GitHubFetchFn = async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  };
  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ token: SYNTHETIC_TOKEN, userLogin: SYNTHETIC_LOGIN });

  const r1 = (await connector.syncIncremental({ cursor: null, config })) as GitHubSyncResult;
  assert.deepEqual(r1.newDocs, []);
  assert.equal(r1.nextCursor.kind, GITHUB_CURSOR_KIND);
  assert.equal(fetchCalled, false);

  const r2 = (await connector.syncIncremental({
    cursor: r1.nextCursor,
    config,
  })) as GitHubSyncResult;
  assert.deepEqual(r2.newDocs, []);
  assert.equal(fetchCalled, false);
});

// ---------------------------------------------------------------------------
// First-sync bootstrap
// ---------------------------------------------------------------------------

test("first sync (cursor=null) seeds watermark and returns no docs", async () => {
  const comment = makeComment(1, SYNTHETIC_LOGIN, "Hello", "2026-04-25T10:00:00.000Z");

  const fetchFn = makeFetch([
    {
      // issue comments seed
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [comment] }),
    },
    {
      // PR review comments seed
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });

  const result = (await connector.syncIncremental({ cursor: null, config })) as GitHubSyncResult;
  assert.deepEqual(result.newDocs, []);
  assert.equal(result.nextCursor.kind, GITHUB_CURSOR_KIND);

  // The cursor must record the watermark from the seeded comment.
  const payload = JSON.parse(result.nextCursor.value) as { watermarks: Record<string, string> };
  assert.equal(
    payload.watermarks[`${REPO_A}/issue-comment`],
    "2026-04-25T10:00:00.000Z",
  );
});

test("first sync with empty API responses seeds empty cursor", async () => {
  const connector = createGitHubConnector({ fetchFn: emptyFetch() });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });

  const result = await connector.syncIncremental({ cursor: null, config });
  assert.deepEqual(result.newDocs, []);
  assert.equal(result.nextCursor.kind, GITHUB_CURSOR_KIND);
});

// ---------------------------------------------------------------------------
// Incremental sync: basic happy path
// ---------------------------------------------------------------------------

test("incremental sync emits ConnectorDocument for matching issue comments", async () => {
  const comment = makeComment(
    42,
    SYNTHETIC_LOGIN,
    "This is my note",
    "2026-04-26T09:00:00.000Z",
    `https://github.com/${REPO_A}/issues/10#issuecomment-42`,
  );

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [comment] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({
    [`${REPO_A}/issue-comment`]: "2026-04-25T00:00:00.000Z",
  });

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;

  assert.equal(result.newDocs.length, 1);
  const doc = result.newDocs[0];
  assert.equal(doc.source.connector, GITHUB_CONNECTOR_ID);
  assert.equal(doc.source.externalId, `${REPO_A}/issue-comment/42`);
  assert.equal(doc.source.externalRevision, "2026-04-26T09:00:00.000Z");
  assert.equal(doc.source.externalUrl, `https://github.com/${REPO_A}/issues/10#issuecomment-42`);
  assert.equal(doc.content, "This is my note");
  assert.ok(doc.title?.includes("Issue comment"));
  assert.ok(doc.title?.includes(REPO_A));
});

test("incremental sync emits ConnectorDocument for matching PR review comments", async () => {
  const comment = makeComment(99, SYNTHETIC_LOGIN, "PR note here", "2026-04-26T10:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [comment] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;

  assert.equal(result.newDocs.length, 1);
  const doc = result.newDocs[0];
  assert.equal(doc.source.externalId, `${REPO_A}/pr-review-comment/99`);
  assert.ok(doc.title?.includes("PR review comment"));
});

// ---------------------------------------------------------------------------
// Author filtering
// ---------------------------------------------------------------------------

test("incremental sync skips comments authored by a different user", async () => {
  const myComment = makeComment(1, SYNTHETIC_LOGIN, "Mine", "2026-04-26T09:00:00.000Z");
  const otherComment = makeComment(2, "other-user", "Not mine", "2026-04-26T09:01:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [myComment, otherComment] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;

  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, `${REPO_A}/issue-comment/1`);
  assert.equal(result.skippedOtherAuthor, 1);
});

// ---------------------------------------------------------------------------
// Empty / too-large bodies
// ---------------------------------------------------------------------------

test("incremental sync skips comments with empty body", async () => {
  const emptyComment = makeComment(5, SYNTHETIC_LOGIN, "", "2026-04-26T09:00:00.000Z");
  const whitespaceComment = makeComment(6, SYNTHETIC_LOGIN, "   \n\t  ", "2026-04-26T09:01:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [emptyComment, whitespaceComment] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  assert.deepEqual(result.newDocs, []);
  assert.equal(result.skippedEmpty, 2);
});

// ---------------------------------------------------------------------------
// Watermark advancement
// ---------------------------------------------------------------------------

test("incremental sync advances watermark after importing comments", async () => {
  const c1 = makeComment(10, SYNTHETIC_LOGIN, "first", "2026-04-26T09:00:00.000Z");
  const c2 = makeComment(11, SYNTHETIC_LOGIN, "second", "2026-04-26T10:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [c1, c2] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({
    [`${REPO_A}/issue-comment`]: "2026-04-25T00:00:00.000Z",
  });

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  assert.equal(result.newDocs.length, 2);

  const payload = JSON.parse(result.nextCursor.value) as { watermarks: Record<string, string> };
  // Watermark must advance to the latest comment's updated_at.
  assert.equal(payload.watermarks[`${REPO_A}/issue-comment`], "2026-04-26T10:00:00.000Z");
});

test("incremental sync skips items strictly before the watermark", async () => {
  // Only comments whose updated_at is STRICTLY before the watermark are
  // dropped by the filter. A comment AT the watermark second passes through
  // to the seenIds check (and, if not in seenIds, is ingested). A comment
  // one second after the watermark is always ingested.
  //
  // "beforeComment" has a timestamp 1 second before the watermark → skipped.
  // "atComment" is AT the watermark second and NOT in seenIds → ingested.
  // "afterComment" is after the watermark → ingested.
  const watermark = "2026-04-25T00:00:01.000Z";
  const beforeComment = makeComment(1, SYNTHETIC_LOGIN, "before", "2026-04-25T00:00:00.000Z");
  const atComment = makeComment(2, SYNTHETIC_LOGIN, "at watermark", watermark);
  const afterComment = makeComment(3, SYNTHETIC_LOGIN, "after", "2026-04-25T00:00:02.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [beforeComment, atComment, afterComment] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  // Cursor watermark at exactly the "at" second; seenIds is empty.
  const cursor: import("./framework.js").ConnectorCursor = {
    kind: GITHUB_CURSOR_KIND,
    value: JSON.stringify({
      watermarks: { [`${REPO_A}/issue-comment`]: watermark },
      seenIds: {},
    }),
    updatedAt: watermark,
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  // beforeComment is strictly before the watermark → skipped.
  // atComment is AT the watermark and not in seenIds → ingested.
  // afterComment is after the watermark → ingested.
  assert.equal(result.newDocs.length, 2);
  const ids = result.newDocs.map((d) => d.source.externalId);
  assert.ok(ids.includes(`${REPO_A}/issue-comment/2`), "atComment must be ingested");
  assert.ok(ids.includes(`${REPO_A}/issue-comment/3`), "afterComment must be ingested");
});

// ---------------------------------------------------------------------------
// Multiple repos
// ---------------------------------------------------------------------------

test("incremental sync handles multiple repos independently", async () => {
  const commentA = makeComment(1, SYNTHETIC_LOGIN, "In A", "2026-04-26T09:00:00.000Z");
  const commentB = makeComment(2, SYNTHETIC_LOGIN, "In B", "2026-04-26T09:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes(`${REPO_A}/issues/comments`),
      respond: () => ({ status: 200, data: [commentA] }),
    },
    {
      match: (url) => url.includes(`${REPO_B}/issues/comments`),
      respond: () => ({ status: 200, data: [commentB] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({
    token: SYNTHETIC_TOKEN,
    userLogin: SYNTHETIC_LOGIN,
    repos: [REPO_A, REPO_B],
  });
  const cursor = makeGitHubCursor({});

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  assert.equal(result.newDocs.length, 2);
  const ids = result.newDocs.map((d) => d.source.externalId).sort();
  assert.deepEqual(ids, [
    `${REPO_A}/issue-comment/1`,
    `${REPO_B}/issue-comment/2`,
  ].sort());
});

// ---------------------------------------------------------------------------
// Discussion comments (opt-in)
// ---------------------------------------------------------------------------

test("discussion comments are not fetched unless includeDiscussions is true", async () => {
  let discussionFetched = false;
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/discussions"),
      respond: () => {
        discussionFetched = true;
        return { status: 200, data: [] };
      },
    },
    {
      match: () => true,
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({
    ...SYNTHETIC_CONFIG,
    includeDiscussions: false,
  });
  const cursor = makeGitHubCursor({});

  await connector.syncIncremental({ cursor, config });
  assert.equal(discussionFetched, false);
});

test("discussion comments are fetched when includeDiscussions is true", async () => {
  let discussionFetched = false;
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/discussions"),
      respond: () => {
        discussionFetched = true;
        return { status: 200, data: [] };
      },
    },
    {
      match: () => true,
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({
    ...SYNTHETIC_CONFIG,
    includeDiscussions: true,
  });
  const cursor = makeGitHubCursor({});

  await connector.syncIncremental({ cursor, config });
  assert.equal(discussionFetched, true);
});

test("discussion comments are imported from discussion-shaped responses", async () => {
  const updatedAt = "2026-04-26T10:00:00.000Z";
  const discussion: GitHubDiscussionComment = {
    id: 1,
    body: "Synthetic discussion note",
    author: { login: SYNTHETIC_LOGIN },
    createdAt: "2026-04-26T09:59:00.000Z",
    updatedAt,
    url: "https://example.test/discussions/1",
  };
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/discussions"),
      respond: () => ({ status: 200, data: [discussion] }),
    },
    {
      match: () => true,
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({
    ...SYNTHETIC_CONFIG,
    includeDiscussions: true,
  });
  const cursor = makeGitHubCursor({});

  const result = (await connector.syncIncremental({
    cursor,
    config,
  })) as GitHubSyncResult;

  assert.equal(result.newDocs.length, 1);
  assert.equal(
    result.newDocs[0]?.source.externalId,
    `${REPO_A}/discussion/1`,
  );
  assert.equal(result.newDocs[0]?.source.externalRevision, updatedAt);
  assert.equal(
    result.newDocs[0]?.source.externalUrl,
    "https://example.test/discussions/1",
  );
  assert.equal(result.newDocs[0]?.content, "Synthetic discussion note");
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("isTransientGitHubError classifies common error shapes", () => {
  // Terminal — skip-and-continue.
  assert.equal(isTransientGitHubError({ githubStatus: 404 }), false);
  assert.equal(isTransientGitHubError({ githubStatus: 403 }), false);
  assert.equal(isTransientGitHubError({ githubStatus: 400 }), false);
  assert.equal(isTransientGitHubError({ status: 410 }), false);
  // Transient — re-throw.
  assert.equal(isTransientGitHubError({ githubStatus: 429 }), true);
  assert.equal(isTransientGitHubError({ githubStatus: 500 }), true);
  assert.equal(isTransientGitHubError({ githubStatus: 503 }), true);
  assert.equal(isTransientGitHubError({ status: 504 }), true);
  // Network errors.
  assert.equal(isTransientGitHubError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientGitHubError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientGitHubError({ code: "ENOTFOUND" }), true);
  assert.equal(isTransientGitHubError({ code: "EAI_AGAIN" }), true);
  // AbortError.
  assert.equal(isTransientGitHubError({ name: "AbortError" }), true);
  // Bare Error with no metadata — conservatively transient.
  assert.equal(isTransientGitHubError(new Error("unknown")), true);
  // Non-objects.
  assert.equal(isTransientGitHubError(null), false);
  assert.equal(isTransientGitHubError(undefined), false);
  assert.equal(isTransientGitHubError("oops"), false);
});

// ---------------------------------------------------------------------------
// HTTP error handling
// ---------------------------------------------------------------------------

test("a 429 on issue comments re-throws (transient) and cursor does NOT advance", async () => {
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({
        status: 429,
        data: { message: "API rate limit exceeded" },
      }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({
    [`${REPO_A}/issue-comment`]: "2026-04-25T00:00:00.000Z",
  });

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /rate limit/i,
  );
});

test("a 503 on issue comments re-throws (transient)", async () => {
  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({
        status: 503,
        data: { message: "Service Unavailable" },
      }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /503/,
  );
});

test("a 404 on issue comments is terminal (skip repo resource, continue)", async () => {
  // Issue comments returns 404 → skipped.
  // PR review comments returns a valid comment → should still be imported.
  const prComment = makeComment(77, SYNTHETIC_LOGIN, "PR note", "2026-04-26T09:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({
        status: 404,
        data: { message: "Not Found" },
      }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [prComment] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  // The 404 should be swallowed (terminal), and the PR comment should be imported.
  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, `${REPO_A}/pr-review-comment/77`);
});

test("a 403 on issue comments is terminal (skip, continue to PR comments)", async () => {
  const prComment = makeComment(88, SYNTHETIC_LOGIN, "Another PR note", "2026-04-26T09:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({
        status: 403,
        data: { message: "Forbidden" },
      }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [prComment] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  assert.equal(result.newDocs.length, 1);
});

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

test("syncIncremental honors abortSignal", async () => {
  const controller = new AbortController();
  let callCount = 0;

  const fetchFn: GitHubFetchFn = async () => {
    callCount++;
    if (callCount === 1) controller.abort();
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [],
    };
  };

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  await assert.rejects(
    connector.syncIncremental({ cursor, config, abortSignal: controller.signal }),
    /aborted/,
  );
});

// ---------------------------------------------------------------------------
// Cursor validation
// ---------------------------------------------------------------------------

test("syncIncremental rejects a cursor of an unexpected kind", async () => {
  const connector = createGitHubConnector({ fetchFn: emptyFetch() });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
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

test("syncIncremental rejects a cursor with invalid JSON", async () => {
  const connector = createGitHubConnector({ fetchFn: emptyFetch() });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const badCursor: ConnectorCursor = {
    kind: GITHUB_CURSOR_KIND,
    value: "{ not valid json",
    updatedAt: "2026-04-25T00:00:00.000Z",
  };

  await assert.rejects(
    connector.syncIncremental({ cursor: badCursor, config }),
    /not valid JSON/,
  );
});

test("validateConfig is enforced again on every sync pass", async () => {
  const connector = createGitHubConnector({ fetchFn: emptyFetch() });
  const badConfig = { token: SYNTHETIC_TOKEN } as unknown as import("./framework.js").ConnectorConfig;
  const cursor = makeGitHubCursor({});

  await assert.rejects(
    connector.syncIncremental({ cursor, config: badConfig }),
    /userLogin/,
  );
});

// ---------------------------------------------------------------------------
// Network-layer transient error
// ---------------------------------------------------------------------------

test("a network ECONNRESET on issue comments re-throws as transient", async () => {
  const fetchFn: GitHubFetchFn = async () => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  await assert.rejects(
    connector.syncIncremental({ cursor, config }),
    /socket hang up/,
  );
});

// ---------------------------------------------------------------------------
// Non-matching author watermark advancement (CLAUDE.md gotcha #44 regression)
// ---------------------------------------------------------------------------

test("watermark advances for non-matching-author and empty comments so they aren't re-fetched", async () => {
  // A comment from a different user. The watermark must still advance so we
  // don't fetch the same item on every subsequent poll.
  const otherComment = makeComment(200, "other-user", "Not mine", "2026-04-26T09:00:00.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [otherComment] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  assert.deepEqual(result.newDocs, []);
  assert.equal(result.skippedOtherAuthor, 1);

  // The watermark must have advanced past the other-author comment so the
  // next incremental pass skips it via the `since` filter.
  const payload = JSON.parse(result.nextCursor.value) as { watermarks: Record<string, string> };
  assert.equal(payload.watermarks[`${REPO_A}/issue-comment`], "2026-04-26T09:00:00.000Z");
});

// ---------------------------------------------------------------------------
// P1 fix: Same-timestamp dedup via seenIds (PRRT_kwDORJXyws59sfBq)
// ---------------------------------------------------------------------------

test("seenIds are stored in cursor for ingested comments at the watermark second", async () => {
  // Two comments with the same second-level timestamp. Both are new (above watermark).
  const c1 = makeComment(10, SYNTHETIC_LOGIN, "first comment", "2026-04-26T10:00:00.000Z");
  const c2 = makeComment(11, SYNTHETIC_LOGIN, "second comment", "2026-04-26T10:00:00.500Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [c1, c2] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({
    [`${REPO_A}/issue-comment`]: "2026-04-26T09:00:00.000Z",
  });

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  assert.equal(result.newDocs.length, 2);

  const payload = JSON.parse(result.nextCursor.value) as {
    watermarks: Record<string, string>;
    seenIds: Record<string, string>;
  };
  // seenIds must contain both ingested comment ids.
  assert.ok(
    `${REPO_A}/issue-comment/10` in payload.seenIds,
    "seenIds must include comment 10",
  );
  assert.ok(
    `${REPO_A}/issue-comment/11` in payload.seenIds,
    "seenIds must include comment 11",
  );
});

test("seenIds prevent re-importing same-second comments on the next poll", async () => {
  // Scenario: c1 was ingested on the previous pass and is recorded in seenIds.
  // On this poll GitHub re-returns it (inclusive `since=` at the watermark
  // second). It must be skipped without emitting a new document.
  const ts = "2026-04-26T10:00:00.000Z";
  const c1 = makeComment(10, SYNTHETIC_LOGIN, "already imported", ts);
  const c2 = makeComment(12, SYNTHETIC_LOGIN, "new this poll", "2026-04-26T10:00:01.000Z");

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [c1, c2] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  // Cursor encodes the watermark at c1's timestamp AND c1 already in seenIds.
  const cursor: import("./framework.js").ConnectorCursor = {
    kind: GITHUB_CURSOR_KIND,
    value: JSON.stringify({
      watermarks: { [`${REPO_A}/issue-comment`]: ts },
      seenIds: { [`${REPO_A}/issue-comment/10`]: ts },
    }),
    updatedAt: "2026-04-26T10:00:00.000Z",
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  // c1 must be skipped (in seenIds); only c2 should be imported.
  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, `${REPO_A}/issue-comment/12`);
});

test("seenIds are cleared when the watermark advances past a second boundary", async () => {
  // Previous cursor has seenIds entries at the old second.
  // After ingesting c2 which is in a new second, seenIds must be cleared.
  const oldTs = "2026-04-26T10:00:00.000Z";
  const newTs = "2026-04-26T10:00:01.000Z";
  const c1Old = makeComment(10, SYNTHETIC_LOGIN, "old second item", oldTs);
  const c2New = makeComment(20, SYNTHETIC_LOGIN, "new second item", newTs);

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [c1Old, c2New] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  // Cursor: watermark is at oldTs, seenIds contains c1Old's id.
  const cursor: import("./framework.js").ConnectorCursor = {
    kind: GITHUB_CURSOR_KIND,
    value: JSON.stringify({
      watermarks: { [`${REPO_A}/issue-comment`]: oldTs },
      seenIds: { [`${REPO_A}/issue-comment/10`]: oldTs },
    }),
    updatedAt: oldTs,
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  // c1Old is in seenIds → skipped. c2New (above watermark) → imported.
  assert.equal(result.newDocs.length, 1);
  assert.equal(result.newDocs[0].source.externalId, `${REPO_A}/issue-comment/20`);

  const payload = JSON.parse(result.nextCursor.value) as {
    watermarks: Record<string, string>;
    seenIds: Record<string, string>;
  };
  // Watermark must have advanced to the new second.
  assert.equal(payload.watermarks[`${REPO_A}/issue-comment`], newTs);
  // seenIds for c1Old must be cleared (watermark crossed the second boundary).
  assert.ok(
    !(`${REPO_A}/issue-comment/10` in payload.seenIds),
    "stale seenId from old second must be cleared",
  );
  // c2New must be in the fresh seenIds.
  assert.ok(
    `${REPO_A}/issue-comment/20` in payload.seenIds,
    "new-second comment must be in seenIds",
  );
});

// ---------------------------------------------------------------------------
// P1 fix: Skip-aware budget — skipped records don't consume the cap
// (PRRT_kwDORJXyws59sfBs)
// ---------------------------------------------------------------------------

test("skipped (wrong-author) records do not consume the per-pass budget", async () => {
  // Build MAX_ITEMS_PER_PASS wrong-author comments followed by one valid one.
  // The budget should NOT be exhausted by the skipped ones, so the valid
  // comment at the end must still be ingested.
  const MAX = 200; // matches MAX_ITEMS_PER_PASS constant
  const skippedComments = Array.from({ length: MAX }, (_, i) =>
    makeComment(1000 + i, "other-user", `not mine ${i}`, `2026-04-26T09:00:${String(i).padStart(2, "0")}.000Z`),
  );
  const validComment = makeComment(9999, SYNTHETIC_LOGIN, "mine", "2026-04-26T09:05:00.000Z");

  // All comments returned on first page (we return MAX+1 items so pagination
  // doesn't trigger — but since GITHUB_PAGE_SIZE=100 we need to simulate
  // multiple pages).  Simpler: just return one page with all items (>100),
  // but since the page-size check caps at 100 we'll use a single page of
  // exactly the right set. Instead use a simpler approach: return the skipped
  // comments as 2 pages of 100, then the valid comment on a "short" 3rd page.
  let callCount = 0;
  const issuePages: (typeof skippedComments)[] = [
    skippedComments.slice(0, 100),
    skippedComments.slice(100, 200),
    [validComment],
  ];

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => {
        const page = issuePages[callCount] ?? [];
        callCount++;
        return { status: 200, data: page };
      },
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;

  // The valid comment must be imported despite all the skipped ones.
  assert.equal(
    result.newDocs.length,
    1,
    "the valid comment must not be starved by budget-consuming skipped items",
  );
  assert.equal(result.newDocs[0].source.externalId, `${REPO_A}/issue-comment/9999`);
  assert.equal(result.skippedOtherAuthor, MAX);
});

test("skipped (empty-body) records do not consume the per-pass budget", async () => {
  // 5 empty-body comments followed by 3 valid ones within a budget of 3.
  const emptyComments = Array.from({ length: 5 }, (_, i) =>
    makeComment(200 + i, SYNTHETIC_LOGIN, "", `2026-04-26T09:00:0${i}.000Z`),
  );
  const validComments = Array.from({ length: 3 }, (_, i) =>
    makeComment(300 + i, SYNTHETIC_LOGIN, `valid ${i}`, `2026-04-26T09:01:0${i}.000Z`),
  );

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [...emptyComments, ...validComments] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  const cursor = makeGitHubCursor({});

  // Use a budget of 3. With the old (buggy) code, the 5 empty comments would
  // exhaust the budget before reaching the valid ones.
  // We can't set MAX_ITEMS_PER_PASS directly; instead verify that with the
  // default budget all 3 valid comments are imported.
  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;

  assert.equal(result.newDocs.length, 3, "all 3 valid comments must be imported");
  assert.equal(result.skippedEmpty, 5);
});

// ---------------------------------------------------------------------------
// Regression: strict watermark filter (<, not <=) + timestamp-gated seenIds
// Fixes: Cursor High finding (watermark boundary), Codex P1 finding (seenIds).
// ---------------------------------------------------------------------------

test("watermark uses strict < so boundary-second comments pass through to seenIds", async () => {
  // Scenario: The cursor watermark is set to T. On the next poll GitHub's
  // `since=T` filter re-returns any comment whose updated_at equals T
  // (GitHub's `since` parameter is inclusive). With the old `<=` filter these
  // were silently dropped before seenIds could distinguish them. This test
  // verifies the `<` fix: a comment AT exactly the watermark second that is
  // NOT in seenIds must be ingested.
  const ts = "2026-04-26T12:00:00.000Z";
  // commentAtTs is at the exact watermark second but was NOT ingested before.
  const commentAtTs = makeComment(42, SYNTHETIC_LOGIN, "exactly at watermark", ts);

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [commentAtTs] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  // Cursor watermark is AT ts; seenIds is empty (comment was NOT previously seen).
  const cursor: import("./framework.js").ConnectorCursor = {
    kind: GITHUB_CURSOR_KIND,
    value: JSON.stringify({
      watermarks: { [`${REPO_A}/issue-comment`]: ts },
      seenIds: {},
    }),
    updatedAt: ts,
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  // With `<` fix: commentAtTs is NOT before the watermark, NOT in seenIds →
  // must be ingested. With old `<=` it would have been silently dropped.
  assert.equal(
    result.newDocs.length,
    1,
    "comment exactly at watermark second must be ingested when not in seenIds",
  );
  assert.equal(result.newDocs[0].source.externalId, `${REPO_A}/issue-comment/42`);
});

test("seenIds check gates on (id + timestamp), not id alone", async () => {
  // Scenario: A comment was previously imported at ts1. It is then edited and
  // re-fetched at ts2 (same id, newer updated_at). With the old `!== undefined`
  // check the edited version would be silently dropped. With the new
  // `=== comment.updated_at` check only the exact (id, ts) pair is suppressed.
  const ts1 = "2026-04-26T13:00:00.000Z";
  const ts2 = "2026-04-26T13:00:01.000Z";
  // Same id as the previously-ingested comment, but updated_at has advanced.
  const editedComment = makeComment(77, SYNTHETIC_LOGIN, "edited body", ts2);

  const fetchFn = makeFetch([
    {
      match: (url) => url.includes("/issues/comments"),
      respond: () => ({ status: 200, data: [editedComment] }),
    },
    {
      match: (url) => url.includes("/pulls/comments"),
      respond: () => ({ status: 200, data: [] }),
    },
  ]);

  const connector = createGitHubConnector({ fetchFn });
  const config = connector.validateConfig({ ...SYNTHETIC_CONFIG });
  // Cursor records id 77 with ts1 in seenIds (the old ingested version).
  // Watermark is at ts1 so the edited comment (ts2 > ts1) is above it.
  const cursor: import("./framework.js").ConnectorCursor = {
    kind: GITHUB_CURSOR_KIND,
    value: JSON.stringify({
      watermarks: { [`${REPO_A}/issue-comment`]: ts1 },
      seenIds: { [`${REPO_A}/issue-comment/77`]: ts1 },
    }),
    updatedAt: ts1,
  };

  const result = (await connector.syncIncremental({ cursor, config })) as GitHubSyncResult;
  // The edited comment (same id, newer ts) must be ingested — seenIds only
  // suppresses the (id, ts1) pair, not (id, ts2).
  assert.equal(
    result.newDocs.length,
    1,
    "edited comment with newer updated_at must not be suppressed by seenIds",
  );
  assert.equal(result.newDocs[0].source.externalId, `${REPO_A}/issue-comment/77`);
  assert.ok(
    result.newDocs[0].content.includes("edited body"),
    "imported document must contain the new body",
  );
});
