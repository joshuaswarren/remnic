import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { QmdClient } from "@remnic/core/qmd";
import { LastRecallStore } from "../packages/remnic-core/src/recall-state.js";
import type { SearchDegradation } from "../packages/remnic-core/src/search/port.js";

function makeClient(): any {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};
  return client;
}

function collector(): { degradations: SearchDegradation[]; onDegradation: (d: SearchDegradation) => void } {
  const degradations: SearchDegradation[] = [];
  return { degradations, onDegradation: (d) => degradations.push(d) };
}

test("daemon timeout reports daemon_timeout; genuine empty reports nothing (#1536)", async () => {
  const client = makeClient();
  const timedOut = collector();
  client.searchViaDaemon = async () => null; // daemon timed out / errored
  const out1 = await client.search("degradation timeout probe", undefined, 3, undefined, {
    onDegradation: timedOut.onDegradation,
  });
  assert.deepEqual(out1, []);
  assert.equal(timedOut.degradations.length, 1);
  assert.equal(timedOut.degradations[0]?.backend, "qmd");
  assert.equal(timedOut.degradations[0]?.code, "daemon_timeout");

  // The crucial contrast: an EMPTY daemon result is a real answer, not a
  // degradation (rule 34 — empty vs broken must stay distinguishable).
  const empty = collector();
  client.searchViaDaemon = async () => [];
  const out2 = await client.search("degradation empty probe", undefined, 3, undefined, {
    onDegradation: empty.onDegradation,
  });
  assert.deepEqual(out2, []);
  assert.equal(empty.degradations.length, 0);
});

test("daemon loading reports daemon_loading", async () => {
  const client = makeClient();
  client.daemonAvailable = false;
  client.daemonSession = { isLoading: () => true };
  const { degradations, onDegradation } = collector();
  const out = await client.search("loading probe", undefined, 3, undefined, { onDegradation });
  assert.deepEqual(out, []);
  assert.equal(degradations.length, 1);
  assert.equal(degradations[0]?.code, "daemon_loading");
});

test("unavailable backend reports backend_unavailable", async () => {
  const client = makeClient();
  client.available = false;
  client.daemonAvailable = false;
  const { degradations, onDegradation } = collector();
  const out = await client.search("unavailable probe", undefined, 3, undefined, { onDegradation });
  assert.deepEqual(out, []);
  assert.equal(degradations.length, 1);
  assert.equal(degradations[0]?.code, "backend_unavailable");
});

test("subprocess failure reports subprocess_error with detail", async () => {
  const client = makeClient();
  client.daemonAvailable = false;
  client.daemonSession = undefined;
  client.runQmdCommand = async () => {
    throw new Error("qmd exploded: exit 3");
  };
  const { degradations, onDegradation } = collector();
  const out = await client.search("subprocess failure probe", undefined, 3, undefined, {
    onDegradation,
  });
  assert.deepEqual(out, []);
  assert.equal(degradations.length, 1);
  assert.equal(degradations[0]?.code, "subprocess_error");
  assert.match(degradations[0]?.detail ?? "", /qmd exploded/);
});

test("subprocess detail redacts path-like tokens before serialization", async () => {
  const client = makeClient();
  client.daemonAvailable = false;
  client.daemonSession = undefined;
  client.runQmdCommand = async () => {
    throw new Error("ENOENT: no such file, open '/Users/someone/secret/memo.md' (~/fallback too)");
  };
  const { degradations, onDegradation } = collector();
  await client.search("path redaction probe", undefined, 3, undefined, { onDegradation });
  const detail = degradations[0]?.detail ?? "";
  assert.match(detail, /<path>/);
  assert.doesNotMatch(detail, /\/Users\//);
  assert.doesNotMatch(detail, /secret/);
  assert.ok(detail.length <= 160);
});

test("subprocess detail redacts the raw recall query (#1544 codex P1)", async () => {
  const client = makeClient();
  client.daemonAvailable = false;
  client.daemonSession = undefined;
  const query = "my private medical question about diagnosis";
  client.runQmdCommand = async () => {
    // Mirrors runQmdCommand's real failure label, which embeds the argv.
    throw new Error(`qmd query ${query} -c openclaw-engram timed out after 30000ms`);
  };
  const { degradations, onDegradation } = collector();
  await client.search(query, undefined, 3, undefined, { onDegradation });
  const detail = degradations[0]?.detail ?? "";
  assert.match(detail, /<query>/);
  assert.doesNotMatch(detail, /medical|diagnosis/);
});

test("multi-line queries cannot leak a first-line prefix into detail (#1544 round 6)", async () => {
  const client = makeClient();
  client.daemonAvailable = false;
  client.daemonSession = undefined;
  const query = "my private first line secret\nand a second private line";
  client.runQmdCommand = async () => {
    throw new Error(`qmd query ${query} -c openclaw-engram timed out after 30000ms`);
  };
  const { degradations, onDegradation } = collector();
  await client.search(query, undefined, 3, undefined, { onDegradation });
  const detail = degradations[0]?.detail ?? "";
  assert.match(detail, /<query>/);
  assert.doesNotMatch(detail, /private|secret/);
});

test("degradation codes are uniform across bm25/vector/global paths (rule 39)", async () => {
  const client = makeClient();
  client.bm25SearchViaDaemon = async () => null;
  client.vsearchViaDaemon = async () => null;
  client.searchViaDaemon = async () => null;

  const bm25 = collector();
  await client.bm25Search("bm25 timeout", undefined, 3, { onDegradation: bm25.onDegradation });
  assert.equal(bm25.degradations[0]?.code, "daemon_timeout");

  const vector = collector();
  await client.vectorSearch("vector timeout", undefined, 3, { onDegradation: vector.onDegradation });
  assert.equal(vector.degradations[0]?.code, "daemon_timeout");

  const global = collector();
  await client.searchGlobal("global timeout", 3, { onDegradation: global.onDegradation });
  assert.equal(global.degradations[0]?.code, "daemon_timeout");
});

test("hybridSearch forwards the observer to both legs", async () => {
  const client = makeClient();
  client.bm25SearchViaDaemon = async () => null;
  client.vsearchViaDaemon = async () => null;
  const { degradations, onDegradation } = collector();
  const out = await client.hybridSearch("hybrid timeout", undefined, 3, { onDegradation });
  assert.deepEqual(out, []);
  // Both the bm25 and vector legs timed out — two reports.
  assert.equal(degradations.length, 2);
  assert.ok(degradations.every((d) => d.code === "daemon_timeout"));
});

test("a throwing observer never breaks the search (#1536 safety contract)", async () => {
  const client = makeClient();
  client.searchViaDaemon = async () => null;
  const out = await client.search("observer throw probe", undefined, 3, undefined, {
    onDegradation: () => {
      throw new Error("observer bug");
    },
  });
  assert.deepEqual(out, []);
});

test("degraded subprocess results are never cached (#1544 codex)", async () => {
  const client = makeClient();
  client.daemonAvailable = false;
  client.daemonSession = undefined;
  let failNext = true;
  client.runQmdCommand = async () => {
    if (failNext) throw new Error("transient qmd failure");
    return { stdout: JSON.stringify([{ docid: "d1", file: "/tmp/d1.md", snippet: "hit", score: 0.9 }]), stderr: "" };
  };

  const first = collector();
  const out1 = await client.search("degraded cache probe", undefined, 3, undefined, {
    onDegradation: first.onDegradation,
  });
  assert.deepEqual(out1, []);
  assert.equal(first.degradations[0]?.code, "subprocess_error");

  // Backend recovers within the cache TTL: the degraded [] must NOT be
  // served from cache as a genuine no-matches.
  failNext = false;
  const second = collector();
  const out2 = await client.search("degraded cache probe", undefined, 3, undefined, {
    onDegradation: second.onDegradation,
  });
  assert.equal(out2.length, 1);
  assert.equal(second.degradations.length, 0);
});

test("record() publishes the snapshot born-annotated with degradations (#1536)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-degradation-"));
  try {
    const store = new LastRecallStore(dir);
    const degradations: SearchDegradation[] = [
      { backend: "qmd", code: "daemon_timeout" },
      { backend: "qmd", code: "subprocess_error", detail: "exit 3" },
    ];
    await store.record({
      sessionKey: "s1",
      query: "q",
      memoryIds: [],
      backendDegradations: degradations,
    });
    const snapshot = store.get("s1");
    assert.equal(snapshot?.backendDegradations?.length, 2);
    assert.equal(snapshot?.backendDegradations?.[0]?.code, "daemon_timeout");
    // The stored snapshot is a deep copy — later caller mutations don't leak in.
    degradations[0]!.code = "daemon_loading";
    assert.equal(store.get("s1")?.backendDegradations?.[0]?.code, "daemon_timeout");

    // No degradations → the field is omitted, not an empty array.
    await store.record({ sessionKey: "s2", query: "q", memoryIds: [], backendDegradations: [] });
    assert.equal(store.get("s2")?.backendDegradations, undefined);
    await store.record({ sessionKey: "s3", query: "q", memoryIds: [] });
    assert.equal(store.get("s3")?.backendDegradations, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
