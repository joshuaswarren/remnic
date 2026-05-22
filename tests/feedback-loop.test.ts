import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NegativeExampleStore } from "../src/negative.ts";
import { LastRecallStore } from "../src/recall-state.ts";
import { RelevanceStore } from "../src/relevance.ts";

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met before timeout");
}

test("NegativeExampleStore records not-useful hits and applies bounded penalty", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-neg-"));

  const store = new NegativeExampleStore(dir);
  await store.load();

  await store.recordNotUseful(["fact-1", "fact-1", "fact-2"], "not relevant");

  // First hit: 1 * perHit
  assert.equal(store.penalty("fact-2", { perHit: 0.05, cap: 0.25 }), 0.05);
  // fact-1 has two hits; still bounded by cap.
  assert.equal(store.penalty("fact-1", { perHit: 0.05, cap: 0.25 }), 0.10);

  const raw = await readFile(path.join(dir, "state", "negative_examples.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { notUseful: number }>;
  assert.equal(parsed["fact-1"]?.notUseful, 2);
  assert.equal(parsed["fact-2"]?.notUseful, 1);
});

test("NegativeExampleStore drops malformed persisted entries before scoring", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-neg-corrupt-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "negative_examples.json"),
    JSON.stringify({
      "mem-1": {
        notUseful: "abc",
        lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    }),
    "utf-8",
  );

  const store = new NegativeExampleStore(dir);
  await store.load();

  assert.equal(store.penalty("mem-1", { perHit: 0.05, cap: 0.2 }), 0);

  await store.recordNotUseful(["mem-1"]);
  assert.equal(store.penalty("mem-1", { perHit: 0.05, cap: 0.2 }), 0.05);

  const raw = await readFile(path.join(stateDir, "negative_examples.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { notUseful: number }>;
  assert.equal(parsed["mem-1"]?.notUseful, 1);
});

test("NegativeExampleStore rejects prototype-poisoning memory ids", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-neg-poison-"));

  const store = new NegativeExampleStore(dir);
  await store.load();

  await store.recordNotUseful(["__proto__", "constructor", "prototype", "fact-safe"], "not useful");

  for (const memoryId of ["__proto__", "constructor", "prototype"]) {
    const penalty = store.penalty(memoryId, { perHit: 0.1, cap: 1 });
    assert.equal(Number.isFinite(penalty), true);
    assert.equal(penalty, 0);
  }
  assert.equal(store.penalty("fact-safe", { perHit: 0.1, cap: 1 }), 0.1);

  const raw = await readFile(path.join(dir, "state", "negative_examples.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { notUseful: number }>;
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "constructor"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "prototype"), false);
  assert.equal(parsed["fact-safe"]?.notUseful, 1);
});

test("LastRecallStore records snapshots without storing raw query text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-"));

  const store = new LastRecallStore(dir);
  await store.load();

  await store.record({
    sessionKey: "main",
    query: "why did you say that?",
    memoryIds: ["fact-1", "preference-2"],
  });

  const snap = store.get("main");
  assert.ok(snap);
  assert.equal(snap.sessionKey, "main");
  assert.equal(snap.memoryIds.length, 2);
  assert.equal(snap.queryHash.length, 64);
});

test("LastRecallStore serialized state writes preserve newest concurrent state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-concurrent-"));
  let firstWriteResolve: (() => void) | undefined;
  let writeCount = 0;

  const store = new LastRecallStore(dir, {
    writeStateFile: async (filePath, content) => {
      writeCount += 1;
      if (writeCount === 1) {
        await new Promise<void>((resolve) => {
          firstWriteResolve = resolve;
        });
      }
      await writeFile(filePath, content, "utf-8");
    },
  });
  await store.load();

  const first = store.record({
    sessionKey: "first",
    query: "first query",
    memoryIds: ["fact-1"],
    appendImpression: false,
  });
  await waitUntil(() => firstWriteResolve !== undefined);

  const second = store.record({
    sessionKey: "second",
    query: "second query",
    memoryIds: ["fact-2"],
    appendImpression: false,
  });
  firstWriteResolve?.();
  await Promise.all([first, second]);

  const raw = await readFile(path.join(dir, "state", "last_recall.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { memoryIds: string[] }>;
  assert.deepEqual(Object.keys(parsed).sort(), ["first", "second"]);
  assert.deepEqual(parsed.first?.memoryIds, ["fact-1"]);
  assert.deepEqual(parsed.second?.memoryIds, ["fact-2"]);
});

test("RelevanceStore serialized state writes preserve newest concurrent state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-relevance-concurrent-"));
  let firstWriteResolve: (() => void) | undefined;
  let writeCount = 0;

  const store = new RelevanceStore(dir, {
    writeStateFile: async (filePath, content) => {
      writeCount += 1;
      if (writeCount === 1) {
        await new Promise<void>((resolve) => {
          firstWriteResolve = resolve;
        });
      }
      await writeFile(filePath, content, "utf-8");
    },
  });
  await store.load();

  const first = store.record("fact-1", "up", "useful");
  await waitUntil(() => firstWriteResolve !== undefined);
  const second = store.record("fact-2", "down", "not useful");
  firstWriteResolve?.();
  await Promise.all([first, second]);

  const raw = await readFile(path.join(dir, "state", "relevance.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { up: number; down: number; notes?: string[] }>;
  assert.equal(parsed["fact-1"]?.up, 1);
  assert.deepEqual(parsed["fact-1"]?.notes, ["useful"]);
  assert.equal(parsed["fact-2"]?.down, 1);
  assert.deepEqual(parsed["fact-2"]?.notes, ["not useful"]);
});
