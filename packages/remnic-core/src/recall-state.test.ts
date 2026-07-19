import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    const files = (await readdir(stateDir))
      .filter((f) => f.startsWith("recall_impressions.jsonl"))
      .sort();
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

test("LastRecallStore serializes rotation across processes sharing memoryDir (#1910)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-crossproc-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    // Two independent stores over the SAME memoryDir stand in for two processes.
    // Each has its own in-process write chain, so only the on-disk rotation lock
    // keeps their archive shifts from interleaving and stomping each other's
    // `.1`. A large keep means nothing falls off the end, so every appended row
    // must survive somewhere.
    const makeStore = async () => {
      const s = new LastRecallStore(dir, { impressionsRotateBytes: 200, impressionsRotateKeep: 100 });
      await s.load();
      return s;
    };
    const storeA = await makeStore();
    const storeB = await makeStore();

    const total = 40;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        (i % 2 === 0 ? storeA : storeB).record({
          sessionKey: `s${i}`,
          query: `q${i}`,
          memoryIds: [`m${i}`],
        }),
      ),
    );

    const stateDir = path.dirname(impressionsPath);
    const files = (await readdir(stateDir)).filter(
      (f) => f.startsWith("recall_impressions.jsonl") && !f.endsWith(".lock"),
    );
    const keys = new Set<string>();
    let lineCount = 0;
    for (const f of files) {
      const content = await readFile(path.join(stateDir, f), "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        lineCount += 1;
        const parsed = JSON.parse(line) as { sessionKey: string };
        keys.add(parsed.sessionKey);
      }
    }
    assert.equal(lineCount, total, "no impression rows lost to a cross-process rotation race");
    assert.equal(keys.size, total, "every session key persisted exactly once across both processes");
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

test("LastRecallStore spills an impression to the durable pending queue on rotation-lock timeout, never writing the active file unlocked (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-lock-timeout-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    await mkdir(path.dirname(impressionsPath), { recursive: true });
    // Seed the active file over the threshold so rotation WOULD be attempted.
    const seeded = `${"x".repeat(256)}\n`;
    await writeFile(impressionsPath, seeded, "utf8");
    // Hold the cross-process rotation lock from a foreign owner with a fresh
    // mtime so it is not broken as stale within the acquisition budget. Our
    // record() must then observe acquired=false.
    const lockPath = `${impressionsPath}.lock`;
    await writeFile(lockPath, "999999 foreign-owner 2999-01-01T00:00:00.000Z\n", "utf8");

    // Tiny maxWaitMs so the acquisition times out deterministically instead of
    // blocking for the default multi-second budget.
    const store = new LastRecallStore(dir, {
      impressionsRotateBytes: 128,
      impressionsRotateKeep: 5,
      impressionsLockOptions: { maxWaitMs: 40, pollMs: 10 },
    });
    await store.load();
    await store.record({ sessionKey: "spilled-append", query: "q", memoryIds: [] });

    // Rotation was refused because the lock could not be acquired: no archive
    // shift ran, so an unlocked rename never raced a peer's rotation.
    assert.equal(
      await fileExists(`${impressionsPath}.1`),
      false,
      "rotation must be skipped when the cross-process lock is not acquired",
    );
    // The impression is NEVER written to the active file unlocked — that could
    // land it in the inode a peer renames to `.1`. The active file is untouched.
    assert.equal(
      await readFile(impressionsPath, "utf8"),
      seeded,
      "active file must not be written while the rotation lock is held elsewhere",
    );
    // It is durably queued in the pending spill instead, not dropped.
    const pendingDir = `${impressionsPath}.pending.d`;
    const spillNames = await readdir(pendingDir);
    assert.equal(spillNames.length, 1, "exactly one impression spilled to the pending queue");
    assert.ok(
      (await readFile(path.join(pendingDir, spillNames[0]!), "utf8")).includes('"sessionKey":"spilled-append"'),
      "spilled impression durably queued",
    );

    // Release the lock; the next record() DOES acquire it and folds the spill
    // back into the active file (after rotation) before appending its own row.
    await rm(lockPath, { force: true });
    await store.record({ sessionKey: "drained-append", query: "q2", memoryIds: [] });
    const active = await readFile(`${impressionsPath}.1`, "utf8").catch(() => "")
      + await readFile(impressionsPath, "utf8");
    assert.ok(active.includes('"sessionKey":"spilled-append"'), "spilled impression folded back in");
    assert.ok(active.includes('"sessionKey":"drained-append"'), "current impression appended");
    assert.equal(
      (await readdir(pendingDir)).length,
      0,
      "pending spill drained empty after a successful locked append",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore takes the shared rotation lock for active-file appends even when local rotation is disabled, spilling on a peer lock/rename race (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-off-lock-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    await mkdir(path.dirname(impressionsPath), { recursive: true });
    // This writer disables its OWN rotation (bytes=0), but a peer writer with
    // rotation enabled shares the same on-disk lock and may rename the active
    // inode to `.1` at any moment. An unlocked append here could land in that
    // offline-sync-excluded archive and be silently dropped (#2033).
    const seeded = "seed-row\n";
    await writeFile(impressionsPath, seeded, "utf8");
    // A peer holds the cross-process rotation lock (fresh mtime, not stale
    // within the budget), standing in for a peer mid-rotation.
    const lockPath = `${impressionsPath}.lock`;
    await writeFile(lockPath, "999999 foreign-owner 2999-01-01T00:00:00.000Z\n", "utf8");

    const store = new LastRecallStore(dir, {
      impressionsRotateBytes: 0, // local rotation disabled
      impressionsRotateKeep: 5,
      impressionsLockOptions: { maxWaitMs: 40, pollMs: 10 },
    });
    await store.load();
    await store.record({ sessionKey: "off-spilled", query: "q", memoryIds: [] });

    // Even with local rotation disabled, the append took the shared lock, could
    // not acquire it, and spilled rather than writing the active file the peer
    // may rename to `.1`.
    assert.equal(
      await readFile(impressionsPath, "utf8"),
      seeded,
      "active file untouched while a peer holds the rotation lock, even with local rotation disabled",
    );
    const pendingDir = `${impressionsPath}.pending.d`;
    const spillNames = await readdir(pendingDir);
    assert.equal(spillNames.length, 1, "impression spilled to the durable pending queue");
    assert.ok(
      (await readFile(path.join(pendingDir, spillNames[0]!), "utf8")).includes('"sessionKey":"off-spilled"'),
      "spilled impression durably queued",
    );

    // Release the lock; the next append acquires it and folds the spill back into
    // the active file. Local rotation stays disabled, so no archive is created.
    await rm(lockPath, { force: true });
    await store.record({ sessionKey: "off-drained", query: "q2", memoryIds: [] });
    const active = await readFile(impressionsPath, "utf8");
    assert.ok(active.includes('"sessionKey":"off-spilled"'), "spilled impression folded back in");
    assert.ok(active.includes('"sessionKey":"off-drained"'), "current impression appended");
    assert.equal(await fileExists(`${impressionsPath}.1`), false, "local rotation stays disabled (no archive)");
    assert.equal((await readdir(pendingDir)).length, 0, "pending spill drained empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore never re-appends a drained impression when its spill unlink fails (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-drain-dup-"));
  const pendingDir = path.join(dir, "state", "recall_impressions.jsonl.pending.d");
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    await mkdir(pendingDir, { recursive: true });
    // A durable spill left by a prior lock-timed-out append.
    await writeFile(
      path.join(pendingDir, "spill.jsonl"),
      `${JSON.stringify({ sessionKey: "evt-spill" })}\n`,
      "utf8",
    );
    // Rotation stays out of the way: threshold far above anything written here.
    const store = new LastRecallStore(dir, { impressionsRotateBytes: 1_000_000, impressionsRotateKeep: 5 });
    await store.load();

    // Make the pending dir non-writable so the drain can READ the spill but its
    // unlink (which needs directory write permission) FAILS. Because the fix
    // claims (unlinks) each spill BEFORE committing its rows, a spill that cannot
    // be claimed is skipped this pass rather than appended-then-left-behind — so
    // it can never be re-read and duplicated on the next drain.
    await chmod(pendingDir, 0o555);
    await store.record({ sessionKey: "cur1", query: "q1", memoryIds: [] });

    let active = await readFile(impressionsPath, "utf8");
    assert.ok(active.includes("cur1"), "current impression appended");
    assert.ok(
      !active.includes("evt-spill"),
      "unclaimable spill must NOT be appended (would otherwise duplicate on the next drain)",
    );
    assert.equal((await readdir(pendingDir)).length, 1, "unclaimed spill remains for a later pass");

    // Restore write permission; the next drain claims the spill and folds it in
    // exactly once.
    await chmod(pendingDir, 0o755);
    await store.record({ sessionKey: "cur2", query: "q2", memoryIds: [] });
    active = await readFile(impressionsPath, "utf8");
    const spillOccurrences = active.split("evt-spill").length - 1;
    assert.equal(spillOccurrences, 1, "drained impression folded in exactly once — no duplicate");
    assert.ok(active.includes("cur2"), "later impression appended");
    assert.equal((await readdir(pendingDir)).length, 0, "pending spill drained empty");
  } finally {
    await chmod(pendingDir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore rotates against the full drained batch so a large spill drain cannot overfill the active file (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-drain-bound-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    await mkdir(path.dirname(impressionsPath), { recursive: true });
    // Prior active content that is UNDER the rotate threshold on its own, so the
    // pre-fix rotation check (which ignored the drained payload) would not rotate.
    const seed = `${"SEED".padEnd(150, "s")}\n`;
    await writeFile(impressionsPath, seed, "utf8");
    // A durable pending spill big enough that seed + spill + row crosses the cap.
    const pendingDir = `${impressionsPath}.pending.d`;
    await mkdir(pendingDir, { recursive: true });
    await writeFile(
      path.join(pendingDir, "a.jsonl"),
      `${JSON.stringify({ sessionKey: "batch-spill", pad: "p".repeat(60) })}\n`,
      "utf8",
    );

    const store = new LastRecallStore(dir, { impressionsRotateBytes: 200, impressionsRotateKeep: 5 });
    await store.load();
    await store.record({ sessionKey: "cur", query: "q", memoryIds: [] });

    // The drained payload was accounted for in the rotation decision, so the
    // oversized prior content was archived to .1 instead of piling onto the
    // active file.
    assert.equal(await fileExists(`${impressionsPath}.1`), true, "prior active content rotated to .1");
    const active = await readFile(impressionsPath, "utf8");
    assert.ok(!active.includes("SEED"), "pre-existing rows moved out of the active file");
    assert.ok(active.includes("batch-spill"), "drained spill folded into the fresh active file");
    assert.ok(active.includes("cur"), "current impression appended");
    assert.ok((await readFile(`${impressionsPath}.1`, "utf8")).includes("SEED"), "prior content preserved in .1");
    assert.equal((await readdir(pendingDir)).length, 0, "pending spill drained empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
