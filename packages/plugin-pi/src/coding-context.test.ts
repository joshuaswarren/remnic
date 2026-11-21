import assert from "node:assert/strict";
import test from "node:test";

import type { GitContext, GitContextProbeResult } from "@remnic/core/coding/git-context";

import {
  attachCodingContextSync,
  maybeSyncSessionCodingContext,
  syncSessionCodingContext,
  type CodingContextSyncState,
} from "./coding-context.js";

const CTX_A: GitContext = {
  projectId: "origin:aaaa0001",
  branch: "main",
  rootPath: "/repo/a",
  defaultBranch: "main",
};
const CTX_A_BRANCH = { ...CTX_A, branch: "feat/x" };
const CTX_B: GitContext = {
  projectId: "root:bbbb0002",
  branch: "dev",
  rootPath: "/repo/b",
  defaultBranch: null,
};

function fakeClient() {
  const posts: Array<{ sessionKey: string; codingContext: GitContext | null }> = [];
  return {
    posts,
    fail: false,
    reachable: true,
    isReachable() {
      return this.reachable;
    },
    async setCodingContext(sessionKey: string, codingContext: GitContext | null) {
      if (this.fail) throw new Error("daemon down");
      posts.push({ sessionKey, codingContext });
      return { ok: true };
    },
  };
}

test("posts the client-resolved context once, then stays quiet while unchanged", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  const resolve = async () => ({ context: CTX_A, conclusive: true });
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve });
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve });
  assert.deepEqual(client.posts, [{ sessionKey: "s1", codingContext: CTX_A }]);
});

test("re-posts when the resolved root or branch changes", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: CTX_A, conclusive: true }) });
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: CTX_A_BRANCH, conclusive: true }) });
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/b", state, client, resolve: async () => ({ context: CTX_B, conclusive: true }) });
  assert.equal(client.posts.length, 3);
  assert.deepEqual(client.posts[1].codingContext, CTX_A_BRANCH);
  assert.deepEqual(client.posts[2].codingContext, CTX_B);
});

test("a cwd outside git posts nothing, and a later non-repo clears a posted context", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/scratch", state, client, resolve: async () => ({ context: null, conclusive: true }) });
  assert.equal(client.posts.length, 0);
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: CTX_A, conclusive: true }) });
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/scratch", state, client, resolve: async () => ({ context: null, conclusive: true }) });
  assert.deepEqual(client.posts, [
    { sessionKey: "s1", codingContext: CTX_A },
    { sessionKey: "s1", codingContext: null },
  ]);
});

test("a failed post does not latch the signature, so the next sync retries", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  client.fail = true;
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: CTX_A, conclusive: true }) });
  assert.equal(state.lastCodingContextSignature, null);
  client.fail = false;
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: CTX_A, conclusive: true }) });
  assert.equal(client.posts.length, 1);
});

test("a daemon outage marks the latch untrusted, so recovery re-posts the context", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  const ctx = { session: { sessionKey: "s1", cwd: "/repo/a" }, state, client, config: { authToken: "t" } };
  const resolve = async () => ({ context: CTX_A, conclusive: true });
  await maybeSyncSessionCodingContext({ ...ctx, resolve });
  assert.equal(client.posts.length, 1);
  client.reachable = false;
  await maybeSyncSessionCodingContext({ ...ctx, resolve });
  assert.equal(state.codingContextRepostPending, true);
  client.reachable = true;
  await maybeSyncSessionCodingContext({ ...ctx, resolve });
  assert.deepEqual(client.posts, [
    { sessionKey: "s1", codingContext: CTX_A },
    { sessionKey: "s1", codingContext: CTX_A },
  ]);
  assert.equal(state.codingContextRepostPending, false);
});

test("a resolver error posts nothing and leaves the signature untouched", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  await syncSessionCodingContext({
    sessionKey: "s1",
    cwd: "/repo/a",
    state,
    client,
    resolve: async () => {
      throw new Error("git missing");
    },
  });
  assert.equal(client.posts.length, 0);
  assert.equal(state.lastCodingContextSignature, null);
});

test("concurrent syncs serialize so the newest resolution posts last", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  const ctx = { session: { sessionKey: "s1", cwd: "/repo/a" }, state, client, config: { authToken: "t" } };
  let releaseFirst: (v: GitContextProbeResult) => void = () => {};
  const firstResolve = new Promise<GitContextProbeResult>((res) => { releaseFirst = res; });
  const secondResolve = async () => ({ context: CTX_B, conclusive: true });
  const first = maybeSyncSessionCodingContext({ ...ctx, resolve: () => firstResolve });
  const second = maybeSyncSessionCodingContext({ ...ctx, resolve: secondResolve });
  releaseFirst({ context: CTX_A, conclusive: true });
  await Promise.all([first, second]);
  assert.deepEqual(client.posts, [
    { sessionKey: "s1", codingContext: CTX_A },
    { sessionKey: "s1", codingContext: CTX_B },
  ]);
});

test("an inconclusive probe retains the posted binding — only a confirmed non-repo clears", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: CTX_A, conclusive: true }) });
  assert.equal(client.posts.length, 1);
  // A transient probe failure (timeout/spawn) must not clear the valid binding.
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: null, conclusive: false }) });
  assert.equal(client.posts.length, 1, "inconclusive probe must not post a clear");
  // A partially resolved probe (root found, origin timed out → degraded
  // context) is still inconclusive and must not overwrite the binding either.
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: CTX_B, conclusive: false }) });
  assert.equal(client.posts.length, 1, "degraded inconclusive context must not replace the binding");
  assert.notEqual(state.lastCodingContextSignature, null, "signature stays latched for retry");
  // A confirmed non-repo still clears.
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/scratch", state, client, resolve: async () => ({ context: null, conclusive: true }) });
  assert.equal(client.posts.at(-1)?.codingContext, null);
});

test("recovery after an outage posts a clear even when nothing was latched", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  const ctx = { session: { sessionKey: "s1", cwd: "/repo/a" }, state, client, config: { authToken: "t" } };
  // Daemon goes away while a binding may exist server-side.
  client.reachable = false;
  await maybeSyncSessionCodingContext({ ...ctx, resolve: async () => ({ context: CTX_A, conclusive: true }) });
  client.reachable = true;
  // cwd left the repo during the outage: signature null === latch null, but the
  // daemon may still hold the stale binding — the clear MUST be posted.
  await maybeSyncSessionCodingContext({ ...ctx, session: { sessionKey: "s1", cwd: "/scratch" }, resolve: async () => ({ context: null, conclusive: true }) });
  assert.deepEqual(client.posts, [{ sessionKey: "s1", codingContext: null }]);
});

test("a post that may have landed before failing is retried even on the same signature", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null, codingContextRepostPending: false };
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: CTX_A, conclusive: true }) });
  // The daemon applies B but the response is lost: the latch stays A while the
  // binding may be B, so returning to A must repost, not skip.
  let applied: GitContext | null = null;
  const normal = client.setCodingContext.bind(client);
  client.setCodingContext = async (sessionKey: string, codingContext: GitContext | null) => {
    client.setCodingContext = normal; // one-shot: only this post loses its response
    applied = codingContext;
    throw new Error("response lost");
  };
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/b", state, client, resolve: async () => ({ context: CTX_B, conclusive: true }) });
  assert.equal(applied, CTX_B);
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => ({ context: CTX_A, conclusive: true }) });
  assert.equal(client.posts.at(-1)?.codingContext, CTX_A, "matching signature must repost while the binding is unknown");
  assert.equal(state.codingContextMustPost, false);
});

test("a queued startup sync is superseded by a newer observation, not posted last", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState & { startupEpoch?: number } = {
    lastCodingContextSignature: null,
    codingContextRepostPending: false,
    startupEpoch: 1,
  };
  const ctx = { session: { sessionKey: "s1", cwd: "/repo/a" }, state, client, config: { authToken: "t" } };
  let releaseStartup: () => void = () => {};
  const probe = new Promise<void>((res) => { releaseStartup = res; });
  const staleSync = attachCodingContextSync(probe, { ...ctx, epoch: 1, resolve: async () => ({ context: CTX_A, conclusive: true }) });
  // A newer observation (cwd B) runs and posts before the startup probe lands.
  await maybeSyncSessionCodingContext({ ...ctx, session: { sessionKey: "s1", cwd: "/repo/b" }, resolve: async () => ({ context: CTX_B, conclusive: true }) });
  releaseStartup();
  await staleSync;
  assert.deepEqual(client.posts, [{ sessionKey: "s1", codingContext: CTX_B }], "stale startup resolution must not post last");
});
