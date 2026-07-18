import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LastRecallStore } from "./recall-state.js";
import type { RecallTierExplain } from "./types.js";

async function freshStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-state-"));
  const store = new LastRecallStore(dir);
  await store.load();
  return { store, dir };
}

// ── Tier-explain field is optional and absent by default ───────────────────

test("LastRecallStore.record omits tierExplain when caller did not provide it", async () => {
  const { store } = await freshStore();
  await store.record({ sessionKey: "s1", query: "q", memoryIds: [] });
  const snap = store.get("s1");
  assert.ok(snap);
  assert.equal(snap.tierExplain, undefined);
});

// ── Tier-explain is persisted and round-trips through disk ─────────────────

test("LastRecallStore.record persists tierExplain and round-trips to JSON on disk", async () => {
  const { store, dir } = await freshStore();
  const tierExplain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "trusted decisions, unambiguous, token-overlap 0.86",
    filteredBy: ["below-token-overlap-floor"],
    candidatesConsidered: 4,
    latencyMs: 12,
    sourceAnchors: [{ path: "/memory/pm.md", lineRange: [10, 14] }],
  };

  await store.record({
    sessionKey: "s1",
    query: "package manager remnic",
    memoryIds: ["pm"],
    tierExplain,
  });

  const snap = store.get("s1");
  assert.ok(snap);
  assert.deepEqual(snap.tierExplain, tierExplain);

  // Confirm disk shape matches the in-memory snapshot.
  const raw = await readFile(path.join(dir, "state", "last_recall.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { tierExplain?: RecallTierExplain }>;
  assert.deepEqual(parsed["s1"]?.tierExplain, tierExplain);
});

// ── Defensive copies isolate the stored snapshot from caller mutation ──────

test("LastRecallStore.record copies filteredBy so caller mutation does not tear the snapshot", async () => {
  const { store } = await freshStore();
  const filteredBy = ["below-importance-floor"];
  const tierExplain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "unambiguous",
    filteredBy,
    candidatesConsidered: 2,
    latencyMs: 5,
  };

  await store.record({
    sessionKey: "s1",
    query: "q",
    memoryIds: [],
    tierExplain,
  });

  // Mutate the caller's array after record() returns.
  filteredBy.push("not-trusted-zone");

  const snap = store.get("s1");
  assert.deepEqual(snap?.tierExplain?.filteredBy, ["below-importance-floor"]);
});

test("LastRecallStore.get returns a defensive copy; mutation does not tear the store", async () => {
  // Regression for PR #535 review: get() previously returned a live
  // reference to internal state, so a caller that mutated memoryIds,
  // budgetsApplied.includedSections, or tierExplain fields would
  // corrupt subsequent reads.
  const { store } = await freshStore();
  await store.record({
    sessionKey: "s1",
    query: "q",
    memoryIds: ["m-1"],
    budgetsApplied: {
      appliedTopK: 1,
      recallBudgetChars: 8000,
      maxMemoryTokens: 2000,
      includedSections: ["profile", "recent"],
    },
    tierExplain: {
      tier: "direct-answer",
      tierReason: "unambiguous",
      filteredBy: ["below-token-overlap-floor"],
      candidatesConsidered: 3,
      latencyMs: 7,
      sourceAnchors: [{ path: "/a.md", lineRange: [2, 5] }],
    },
  });

  const snap = store.get("s1");
  assert.ok(snap);
  // Mutate every mutable field on the returned copy.
  snap.memoryIds.push("leak");
  snap.budgetsApplied?.includedSections?.push("leak");
  snap.tierExplain?.filteredBy.push("leak");
  const firstAnchor = snap.tierExplain?.sourceAnchors?.[0];
  if (firstAnchor?.lineRange) firstAnchor.lineRange[0] = 999;

  const fresh = store.get("s1");
  assert.deepEqual(fresh?.memoryIds, ["m-1"]);
  assert.deepEqual(fresh?.budgetsApplied?.includedSections, ["profile", "recent"]);
  assert.deepEqual(fresh?.tierExplain?.filteredBy, ["below-token-overlap-floor"]);
  assert.deepEqual(fresh?.tierExplain?.sourceAnchors?.[0]?.lineRange, [2, 5]);
});

test("LastRecallStore.getMostRecent returns a defensive copy", async () => {
  const { store } = await freshStore();
  await store.record({
    sessionKey: "s1",
    query: "q",
    memoryIds: ["m-1"],
  });
  const snap = store.getMostRecent();
  assert.ok(snap);
  snap.memoryIds.push("leak");

  const fresh = store.getMostRecent();
  assert.deepEqual(fresh?.memoryIds, ["m-1"]);
});

test("LastRecallStore.record copies memoryIds so caller mutation does not tear the snapshot", async () => {
  const { store } = await freshStore();
  const memoryIds = ["m-1"];
  await store.record({ sessionKey: "s1", query: "q", memoryIds });
  memoryIds.push("leak");
  const snap = store.get("s1");
  assert.deepEqual(snap?.memoryIds, ["m-1"]);
});

test("LastRecallStore.annotateTierExplain attaches tierExplain to an existing snapshot", async () => {
  const { store, dir } = await freshStore();
  await store.record({ sessionKey: "s1", query: "q", memoryIds: ["m-1"] });

  const explain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "trusted decision, unambiguous",
    filteredBy: [],
    candidatesConsidered: 1,
    latencyMs: 4,
  };
  await store.annotateTierExplain("s1", explain);

  const snap = store.get("s1");
  assert.ok(snap);
  assert.deepEqual(snap.tierExplain, explain);

  // Round-trips to disk.
  const raw = await readFile(path.join(dir, "state", "last_recall.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { tierExplain?: RecallTierExplain }>;
  assert.deepEqual(parsed["s1"]?.tierExplain, explain);
});

test("LastRecallStore.annotateTierExplain is a no-op when the session has no snapshot", async () => {
  const { store } = await freshStore();
  await store.annotateTierExplain("ghost", {
    tier: "direct-answer",
    tierReason: "",
    filteredBy: [],
    candidatesConsidered: 0,
    latencyMs: 0,
  });
  assert.equal(store.get("ghost"), null);
});

test("LastRecallStore.annotateTierExplain deep-copies the caller's block", async () => {
  const { store } = await freshStore();
  await store.record({ sessionKey: "s1", query: "q", memoryIds: [] });

  const filteredBy = ["a"];
  await store.annotateTierExplain("s1", {
    tier: "direct-answer",
    tierReason: "",
    filteredBy,
    candidatesConsidered: 0,
    latencyMs: 0,
  });
  filteredBy.push("leak");

  const snap = store.get("s1");
  assert.deepEqual(snap?.tierExplain?.filteredBy, ["a"]);
});

test("LastRecallStore.record copies sourceAnchors array and lineRange tuple", async () => {
  const { store } = await freshStore();
  const anchors: RecallTierExplain["sourceAnchors"] = [
    { path: "/a.md", lineRange: [1, 2] },
  ];
  const tierExplain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "ok",
    filteredBy: [],
    candidatesConsidered: 1,
    latencyMs: 1,
    sourceAnchors: anchors,
  };

  await store.record({
    sessionKey: "s1",
    query: "q",
    memoryIds: [],
    tierExplain,
  });

  // Mutate original.
  anchors!.push({ path: "/b.md" });
  const firstAnchor = anchors![0];
  if (firstAnchor?.lineRange) firstAnchor.lineRange[0] = 99;

  const snap = store.get("s1");
  assert.equal(snap?.tierExplain?.sourceAnchors?.length, 1);
  assert.equal(snap?.tierExplain?.sourceAnchors?.[0]?.path, "/a.md");
  assert.deepEqual(snap?.tierExplain?.sourceAnchors?.[0]?.lineRange, [1, 2]);
});

// ── Recall-impressions rotation (issue #1910) ──────────────────────────────
async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("LastRecallStore rotates recall_impressions.jsonl once it exceeds the byte threshold", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-rotate-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    const store = new LastRecallStore(dir, { impressionsRotateBytes: 64, impressionsRotateKeep: 3 });
    await store.load();

    // First append creates the active file (below threshold, no rotation).
    await store.record({ sessionKey: "s1", query: "q1", memoryIds: [] });
    assert.equal(await fileExists(`${impressionsPath}.1`), false);

    // Grow the active file past the threshold, then append: rotation moves the
    // oversized active file to .1 and starts a fresh active file.
    await writeFile(impressionsPath, "x".repeat(128), "utf8");
    await store.record({ sessionKey: "s2", query: "q2", memoryIds: [] });

    assert.equal(await fileExists(impressionsPath), true, "active file recreated");
    assert.equal(await fileExists(`${impressionsPath}.1`), true, "archive .1 created");
    const active = await readFile(impressionsPath, "utf8");
    assert.ok(active.trim().length > 0, "active file holds the new impression");
    assert.equal(active.includes("x".repeat(128)), false, "old rows moved out of active file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore keeps at most impressionsRotateKeep archives", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-keep-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    const keep = 2;
    const store = new LastRecallStore(dir, { impressionsRotateBytes: 32, impressionsRotateKeep: keep });
    await store.load();

    // Bootstrap the state dir + active file (record() creates them).
    await store.record({ sessionKey: "seed", query: "seed", memoryIds: [] });

    // Force several rotations by growing the active file before each append.
    for (let i = 0; i < 5; i += 1) {
      await writeFile(impressionsPath, "y".repeat(64), "utf8");
      await store.record({ sessionKey: `s${i}`, query: `q${i}`, memoryIds: [] });
    }

    assert.equal(await fileExists(`${impressionsPath}.1`), true);
    assert.equal(await fileExists(`${impressionsPath}.2`), true);
    assert.equal(await fileExists(`${impressionsPath}.3`), false, "archives beyond keep are dropped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore never rotates when impressionsRotateBytes is 0 (disabled)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-off-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    const store = new LastRecallStore(dir, { impressionsRotateBytes: 0, impressionsRotateKeep: 5 });
    await store.load();

    await store.record({ sessionKey: "s1", query: "q1", memoryIds: [] });
    await writeFile(impressionsPath, "z".repeat(1024), "utf8");
    await store.record({ sessionKey: "s2", query: "q2", memoryIds: [] });

    assert.equal(await fileExists(`${impressionsPath}.1`), false, "rotation disabled leaves no archive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore serializes concurrent impression writes without losing rows (#1910)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-concurrent-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    // Small threshold forces rotations mid-flight; a large keep means no archive
    // falls off the end, so every appended row survives somewhere.
    const store = new LastRecallStore(dir, { impressionsRotateBytes: 200, impressionsRotateKeep: 100 });
    await store.load();

    const total = 24;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        store.record({ sessionKey: `s${i}`, query: `q${i}`, memoryIds: [`m${i}`] }),
      ),
    );

    // Gather every impression line across the active file and all archives.
    const stateDir = path.dirname(impressionsPath);
    const files = (await readdir(stateDir)).filter((f) => f.startsWith("recall_impressions.jsonl"));
    const lines: string[] = [];
    for (const f of files) {
      const content = await readFile(path.join(stateDir, f), "utf8");
      for (const line of content.split("\n")) {
        if (line.trim()) lines.push(line);
      }
    }
    // Serialization guarantees no interleaved/torn writes: every line parses and
    // every session key appears exactly once.
    const keys = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { sessionKey: string };
      keys.add(parsed.sessionKey);
    }
    assert.equal(lines.length, total, "no impression rows lost or duplicated under concurrency");
    assert.equal(keys.size, total, "every session key persisted exactly once");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore preserves the current impression when rotation fails (#1910)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-rotate-fail-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    await mkdir(path.dirname(impressionsPath), { recursive: true });
    // Seed an active file over the (tiny) threshold so rotation is attempted.
    await writeFile(impressionsPath, "seed-row-that-exceeds-threshold\n", "utf8");
    // Make the .1 archive target a non-empty directory so the active→.1 rename
    // fails with a non-ENOENT error, forcing rotateImpressionsIfNeeded to throw.
    await mkdir(`${impressionsPath}.1`, { recursive: true });
    await writeFile(path.join(`${impressionsPath}.1`, "blocker"), "x", "utf8");

    const store = new LastRecallStore(dir, { impressionsRotateBytes: 1, impressionsRotateKeep: 1 });
    await store.load();
    await store.record({ sessionKey: "preserved", query: "q", memoryIds: [] });

    // Rotation threw, but the current impression must still be appended.
    const active = await readFile(impressionsPath, "utf8");
    assert.ok(active.includes('"sessionKey":"preserved"'), "impression preserved despite rotation failure");
    // The blocking directory remains (rotation could not move over it).
    assert.ok((await stat(`${impressionsPath}.1`)).isDirectory(), "rotation did not clobber the blocked target");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
