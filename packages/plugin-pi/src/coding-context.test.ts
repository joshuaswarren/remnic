import assert from "node:assert/strict";
import test from "node:test";

import type { GitContext } from "@remnic/core";

import { syncSessionCodingContext, type CodingContextSyncState } from "./coding-context.js";

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
    async setCodingContext(sessionKey: string, codingContext: GitContext | null) {
      if (this.fail) throw new Error("daemon down");
      posts.push({ sessionKey, codingContext });
      return { ok: true };
    },
  };
}

test("posts the client-resolved context once, then stays quiet while unchanged", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null };
  const resolve = async () => CTX_A;
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve });
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve });
  assert.deepEqual(client.posts, [{ sessionKey: "s1", codingContext: CTX_A }]);
});

test("re-posts when the resolved root or branch changes", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null };
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => CTX_A });
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => CTX_A_BRANCH });
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/b", state, client, resolve: async () => CTX_B });
  assert.equal(client.posts.length, 3);
  assert.deepEqual(client.posts[1].codingContext, CTX_A_BRANCH);
  assert.deepEqual(client.posts[2].codingContext, CTX_B);
});

test("a cwd outside git posts nothing, and a later non-repo clears a posted context", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null };
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/scratch", state, client, resolve: async () => null });
  assert.equal(client.posts.length, 0);
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => CTX_A });
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/scratch", state, client, resolve: async () => null });
  assert.deepEqual(client.posts, [
    { sessionKey: "s1", codingContext: CTX_A },
    { sessionKey: "s1", codingContext: null },
  ]);
});

test("a failed post does not latch the signature, so the next sync retries", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null };
  client.fail = true;
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => CTX_A });
  assert.equal(state.lastCodingContextSignature, null);
  client.fail = false;
  await syncSessionCodingContext({ sessionKey: "s1", cwd: "/repo/a", state, client, resolve: async () => CTX_A });
  assert.equal(client.posts.length, 1);
});

test("a resolver error posts nothing and leaves the signature untouched", async () => {
  const client = fakeClient();
  const state: CodingContextSyncState = { lastCodingContextSignature: null };
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
