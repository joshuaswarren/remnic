import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { XRefreshChainBrokenError, XTokenStore } from "./token-store.js";

const FAR_FUTURE = Date.now() + 3_600_000;

async function newTokenFile(extras: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-tokens-"));
  const file = path.join(dir, "x-tokens.json");
  await writeFile(
    file,
    JSON.stringify({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: FAR_FUTURE,
      ...extras,
    }),
    { mode: 0o600 }
  );
  return file;
}

function makeStore(file: string, overrides: Partial<ConstructorParameters<typeof XTokenStore>[0]> = {}) {
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  const store = new XTokenStore({
    tokenFile: file,
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl: (async () => {
      calls.push({ url: "stub", auth: "stub", body: "stub" });
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
          token_type: "bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch,
    now: () => Date.now(),
    sleep: async () => {},
    lockWaitMs: 5_000,
    ...overrides,
  });
  return { store, calls };
}

test("valid cached token is returned without any network call", async () => {
  const file = await newTokenFile();
  const { store, calls } = makeStore(file);
  assert.equal(await store.getAccessToken(), "old-access");
  assert.equal(calls.length, 0);
});

test("expired token refreshes under the lock and rotates the file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-rot-"));
  const file = path.join(dir, "x-tokens.json");
  await writeFile(
    file,
    JSON.stringify({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: Date.now() - 1_000,
      note_from_other_tool: "keep me",
    })
  );
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const store = new XTokenStore({
    tokenFile: file,
    clientId: "cid",
    clientSecret: "csecret",
    fetchImpl: (async (_input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      seen.push({
        url: "https://api.x.com/2/oauth2/token",
        headers: init?.headers ?? {},
        body: init?.body ?? "",
      });
      return new Response(
        JSON.stringify({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 7200 }),
        { status: 200 }
      );
    }) as typeof fetch,
    now: () => Date.now(),
    sleep: async () => {},
  });
  assert.equal(await store.getAccessToken(), "rotated");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.Authorization, `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
  assert.match(seen[0].body, /grant_type=refresh_token/);
  assert.match(seen[0].body, /refresh_token=old-refresh/);
  const persisted = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.access_token, "rotated");
  assert.equal(persisted.refresh_token, "rotated-refresh");
  assert.equal(persisted.note_from_other_tool, "keep me");
  // Lock released after refresh.
  await assert.rejects(readFile(`${file}.lock`));
});

test("concurrent owner: waits and adopts the rotated pair instead of double-refreshing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-lock-"));
  const file = path.join(dir, "x-tokens.json");
  await writeFile(
    file,
    JSON.stringify({ access_token: "expired", refresh_token: "chain", expires_at: Date.now() - 1 })
  );
  // Simulate the other owner's lock: fresh mtime, removed after a few polls.
  const lockPath = `${file}.lock`;
  await writeFile(lockPath, "other-pid\n");
  let polls = 0;
  let clock = Date.now();
  const store = new XTokenStore({
    tokenFile: file,
    clientId: "cid",
    clientSecret: "csecret",
    fetchImpl: (async () => {
      throw new Error("must not refresh: another owner holds the chain");
    }) as typeof fetch,
    now: () => clock,
    sleep: async () => {
      polls += 1;
      clock += 300;
      if (polls === 3) {
        const { rm } = await import("node:fs/promises");
        await rm(lockPath);
        await writeFile(
          file,
          JSON.stringify({
            access_token: "adopted",
            refresh_token: "adopted-refresh",
            expires_at: clock + 600_000,
          })
        );
      }
    },
    lockWaitMs: 60_000,
  });
  assert.equal(await store.getAccessToken(), "adopted");
});

test("refresh 401 means the chain forked", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-broken-"));
  const file = path.join(dir, "x-tokens.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ access_token: "x", refresh_token: "forked", expires_at: Date.now() - 1 }));
  const store = new XTokenStore({
    tokenFile: file,
    clientId: "cid",
    clientSecret: "csecret",
    fetchImpl: (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
    now: () => Date.now(),
    sleep: async () => {},
  });
  await assert.rejects(store.refresh(), XRefreshChainBrokenError);
});

test("a stale lock is stolen and the refresh proceeds", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-stale-"));
  const file = path.join(dir, "x-tokens.json");
  await writeFile(file, JSON.stringify({ access_token: "x", refresh_token: "r", expires_at: Date.now() - 1 }));
  const lockPath = `${file}.lock`;
  await writeFile(lockPath, "dead-pid\n");
  // Age the lock past the stale threshold.
  const stale = new Date(Date.now() - 120_000);
  await utimes(lockPath, stale, stale);
  const { store } = makeStore(file);
  const pair = await store.refresh();
  assert.equal(pair.accessToken, "new-access");
  await assert.rejects(readFile(lockPath));
});

test("missing client credentials fail fast with setup guidance", () => {
  assert.throws(
    () =>
      new XTokenStore({
        tokenFile: "/tmp/whatever.json",
        clientId: "",
        clientSecret: "csecret",
      }),
    /clientId/
  );
});
