import assert from "node:assert/strict";
import test from "node:test";

import type { GitContext, GitContextProbeResult } from "@remnic/core/coding/git-context";

import {
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
  assert.notEqual(state.lastCodingContextSignature, null, "signature stays latched for retry");
  // A confirmed non-repo still clears.
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/scratch", state, client, resolve: async () => ({ context: null, conclusive: true }) });
  assert.equal(client.posts.at(-1)?.codingContext, null);
});
