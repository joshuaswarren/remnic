import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LastRecallStore } from "./recall-state.js";
import type { RecallTierExplain } from "./types.js";
import { listContainedSpillFiles } from "./utils/path-containment.js";

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
    // CLAIM (a rename to `<uuid>.jsonl.claimed`, which needs directory write
    // permission) FAILS. Because the crash-safe fix claims each spill by rename
    // BEFORE committing its rows, a spill that cannot be claimed is skipped this
    // pass rather than appended-then-left-behind — so it can never be re-read and
    // duplicated on the next drain.
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

test("LastRecallStore.drainPendingImpressions folds an oversized pending payload in bounded chunks so the active file stays within the cap (#2033)", async () => {
  // Regression: a drained payload far larger than recallImpressionsRotateBytes
  // must be folded in bounded segments — a single append of the whole payload
  // would leave the freshly rotated active file over the cap. Every row is
  // preserved across the active file + its rotated archives; none is dropped.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-drain-bound-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    const pendingDir = `${impressionsPath}.pending.d`;
    await mkdir(pendingDir, { recursive: true });
    const cap = 200;
    // Six ~97-byte spill rows (~582 bytes total) — nearly 3x the cap — each well
    // under the cap so the bound holds strictly (no lone oversized row).
    const sessionKeys: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const key = `oversized-${i}`;
      sessionKeys.push(key);
      await writeFile(
        path.join(pendingDir, `spill-${i}.jsonl`),
        `${JSON.stringify({ sessionKey: key, writeNonce: `n-${i}`, pad: "p".repeat(40) })}\n`,
        "utf-8",
      );
    }

    const store = new LastRecallStore(dir, { impressionsRotateBytes: cap, impressionsRotateKeep: 10 });
    await store.load();
    assert.deepEqual(
      await store.drainPendingImpressions(),
      { folded: true, pendingDeferred: false },
      "oversized payload fully folded, nothing deferred",
    );

    // The active authoritative file stays within the configured cap.
    const activeSize = (await stat(impressionsPath)).size;
    assert.ok(activeSize <= cap, `active file (${activeSize}B) stays within the ${cap}B cap`);

    // Every drained row survives across the active file + its archives, exactly
    // once — the bounded fold rotates rather than dropping rows. Each archive
    // generation also respects the cap.
    let combined = await readFile(impressionsPath, "utf-8");
    for (let i = 1; i <= 10; i += 1) {
      const archive = await readFile(`${impressionsPath}.${i}`, "utf-8").catch(() => "");
      combined += archive;
      if (archive.length > 0) {
        assert.ok(
          Buffer.byteLength(archive, "utf-8") <= cap,
          `archive .${i} (${Buffer.byteLength(archive, "utf-8")}B) stays within the cap`,
        );
      }
    }
    for (const key of sessionKeys) {
      assert.equal(combined.split(key).length - 1, 1, `${key} preserved exactly once across active + archives`);
    }
    assert.deepEqual(await readdir(pendingDir), [], "pending queue drained empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore recovers an impression spill claim orphaned by a crash before commit — the row is never lost (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-crash-claim-"));
  const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
  const pendingDir = `${impressionsPath}.pending.d`;
  try {
    await mkdir(pendingDir, { recursive: true });
    // Simulate a drain that CLAIMED a spill (renamed q.jsonl -> q.jsonl.claimed)
    // and then CRASHED before appending the rows to the active file. The
    // `.claimed` file is the ONLY durable copy of the impression — the old
    // read-then-unlink ordering would already have deleted it and lost the row.
    await writeFile(
      path.join(pendingDir, "orphan.jsonl.claimed"),
      `${JSON.stringify({ sessionKey: "evt-orphan" })}\n`,
      "utf8",
    );
    // Rotation stays out of the way so both rows land in the active file.
    const store = new LastRecallStore(dir, { impressionsRotateBytes: 1_000_000, impressionsRotateKeep: 5 });
    await store.load();
    await store.record({ sessionKey: "cur", query: "q", memoryIds: [] });

    const active = await readFile(impressionsPath, "utf8");
    assert.ok(active.includes("evt-orphan"), "crash-orphaned claim recovered into the active file — not lost");
    assert.equal(active.split("evt-orphan").length - 1, 1, "orphaned impression committed exactly once");
    assert.ok(active.includes('"sessionKey":"cur"'), "current impression appended");
    assert.equal((await readdir(pendingDir)).length, 0, "recovered claim cleaned up after commit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore refuses to write an impression spill into a symlinked pending directory (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-symlink-spill-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-symlink-outside-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    await mkdir(path.dirname(impressionsPath), { recursive: true });
    // Plant a symlink AT the spill-directory path pointing at a real directory
    // outside the memory store. The write path must refuse it before any file
    // lands in the target.
    const pendingDir = `${impressionsPath}.pending.d`;
    await symlink(outside, pendingDir);

    // Force the spill branch: hold the rotation lock from a foreign owner so
    // record()'s append cannot acquire it and falls back to spilling.
    const lockPath = `${impressionsPath}.lock`;
    await writeFile(lockPath, "999999 foreign-owner 2999-01-01T00:00:00.000Z\n", "utf8");
    const store = new LastRecallStore(dir, {
      impressionsRotateBytes: 0,
      impressionsRotateKeep: 5,
      impressionsLockOptions: { maxWaitMs: 40, pollMs: 10 },
    });
    await store.load();
    // The spill refusal is swallowed as a logged append failure (record never
    // throws), but nothing may be written through the poisoned link.
    await store.record({ sessionKey: "symlink-refused", query: "q", memoryIds: [] });

    assert.equal(
      (await lstat(pendingDir)).isSymbolicLink(),
      true,
      "spill directory symlink left intact (not replaced by a real dir)",
    );
    assert.deepEqual(
      await readdir(outside),
      [],
      "no spill file leaked through the symlink into the outside directory",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("LastRecallStore writes an impression spill via a temp name then renames to *.jsonl so a drain never sees a partial spill (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-atomic-spill-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    await mkdir(path.dirname(impressionsPath), { recursive: true });
    // Force the spill branch: a foreign owner holds the rotation lock so
    // record()'s append cannot acquire it and falls back to spilling.
    const lockPath = `${impressionsPath}.lock`;
    await writeFile(lockPath, "999999 foreign-owner 2999-01-01T00:00:00.000Z\n", "utf8");
    const store = new LastRecallStore(dir, {
      impressionsRotateBytes: 0,
      impressionsRotateKeep: 5,
      impressionsLockOptions: { maxWaitMs: 40, pollMs: 10 },
    });
    await store.load();
    await store.record({ sessionKey: "atomic-spill", query: "q", memoryIds: [] });

    const pendingDir = `${impressionsPath}.pending.d`;
    const entries = await readdir(pendingDir);
    // Exactly one spill, named with the final `.jsonl` suffix — no temp artifact
    // left behind, and nothing ending in the temp `.tmp` suffix.
    assert.equal(entries.length, 1, "exactly one spill file after the rename");
    assert.ok(entries[0].endsWith(".jsonl"), "spill has the final .jsonl suffix");
    assert.ok(!entries[0].endsWith(".jsonl.tmp"), "no temp artifact left behind");

    // The drain's own lister (the exact one a concurrent lock holder runs) sees a
    // single COMPLETE spill — the temp name is invisible to it, so a drain can
    // never read/rename a partial `.jsonl`.
    const listed = await listContainedSpillFiles(pendingDir);
    assert.equal(listed.length, 1, "drain lister sees exactly the one committed spill");
    const spilled = JSON.parse(await readFile(listed[0], "utf8"));
    assert.equal(spilled.sessionKey, "atomic-spill", "spilled row is complete, parseable JSON");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore.drainPendingImpressions folds pending spills into the synced active file (#2033)", async () => {
  // Regression for the offline-sync impression-drain thread: a record() that
  // times out on the rotation lock spills to the offline-sync-EXCLUDED
  // recall_impressions.jsonl.pending.d/. drainPendingImpressions() folds those
  // rows back into the synced active file so a snapshot can capture them.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-drain-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    const pendingDir = `${impressionsPath}.pending.d`;
    await mkdir(pendingDir, { recursive: true });
    const row = `${JSON.stringify({ sessionKey: "s1", writeNonce: "n-1", memoryIds: ["m-1"] })}\n`;
    await writeFile(path.join(pendingDir, "spill-1.jsonl"), row, "utf-8");

    const store = new LastRecallStore(dir);
    await store.load();

    assert.deepEqual(
      await store.drainPendingImpressions(),
      { folded: true, pendingDeferred: false },
      "drain reports rows folded and nothing deferred",
    );
    assert.equal(await readFile(impressionsPath, "utf-8"), row, "spill folded verbatim into active file");
    assert.deepEqual(await readdir(pendingDir), [], "committed spill deleted from the pending queue");

    // Nothing pending now → fast no-op that folds nothing and defers nothing.
    assert.deepEqual(
      await store.drainPendingImpressions(),
      { folded: false, pendingDeferred: false },
      "second drain is a no-op",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore.drainPendingImpressions is a side-effect-free no-op when nothing is pending (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-drain-noop-"));
  try {
    const store = new LastRecallStore(dir);
    await store.load();
    assert.deepEqual(
      await store.drainPendingImpressions(),
      { folded: false, pendingDeferred: false },
      "no pending dir → no drain, nothing deferred",
    );
    // A no-op drain must not create the state dir or a transient lock file.
    await assert.rejects(() => readdir(path.join(dir, "state")), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore.drainPendingImpressions recovers a crash-orphaned .claimed spill (#2033)", async () => {
  // A crash between claim and commit leaves the rows as a `<uuid>.jsonl.claimed`
  // orphan — the only durable copy. The drain must recover it (rename back to
  // `.jsonl`) and fold it into the active file, never lose it.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-drain-orphan-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    const pendingDir = `${impressionsPath}.pending.d`;
    await mkdir(pendingDir, { recursive: true });
    const row = `${JSON.stringify({ sessionKey: "s1", writeNonce: "n-1", memoryIds: ["m-1"] })}\n`;
    await writeFile(path.join(pendingDir, "spill-1.jsonl.claimed"), row, "utf-8");

    const store = new LastRecallStore(dir);
    await store.load();

    assert.deepEqual(
      await store.drainPendingImpressions(),
      { folded: true, pendingDeferred: false },
      "orphaned claim recovered and folded",
    );
    assert.equal(await readFile(impressionsPath, "utf-8"), row, "recovered row appended to active file");
    assert.deepEqual(await readdir(pendingDir), [], "recovered spill finalized");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore.drainPendingImpressions reports pendingDeferred and never claims success when the rotation lock is held (#2033)", async () => {
  // Regression for the offline-sync lock-timeout thread (PRRT_kwDORJXyws6SE4Ac):
  // a pending spill exists but a PEER holds the rotation lock, so the drain
  // cannot fold it into the synced active file. The drain MUST report
  // pendingDeferred=true (a distinct deferred signal) and MUST NOT touch the
  // offline-sync-EXCLUDED spill — otherwise a snapshot taken now would silently
  // omit the recorded impression while the caller believes the drain succeeded.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-drain-locked-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    const pendingDir = `${impressionsPath}.pending.d`;
    await mkdir(pendingDir, { recursive: true });
    const row = `${JSON.stringify({ sessionKey: "s1", writeNonce: "n-1", memoryIds: ["m-1"] })}\n`;
    await writeFile(path.join(pendingDir, "spill-1.jsonl"), row, "utf-8");

    // Foreign-owner lock with a far-future timestamp so it is NOT broken as
    // stale within the acquisition budget; the drain must observe acquired=false.
    const lockPath = `${impressionsPath}.lock`;
    await writeFile(lockPath, "999999 foreign-owner 2999-01-01T00:00:00.000Z\n", "utf8");

    // Tiny maxWaitMs so acquisition times out deterministically.
    const store = new LastRecallStore(dir, {
      impressionsLockOptions: { maxWaitMs: 40, pollMs: 10 },
    });
    await store.load();

    assert.deepEqual(
      await store.drainPendingImpressions(),
      { folded: false, pendingDeferred: true },
      "lock held → drain is deferred, never reports a fold",
    );
    // The active file was NEVER written unlocked: a snapshot now would miss the
    // spilled impression, which is exactly why the caller must not treat a
    // deferred drain as a clean snapshot.
    assert.equal(
      await fileExists(impressionsPath),
      false,
      "pending spill must NOT be folded into the active file while the lock is held",
    );
    // The spill is preserved in the offline-sync-EXCLUDED queue for a later
    // lock holder (or caller retry) to fold — deferred, never dropped.
    assert.deepEqual(
      await readdir(pendingDir),
      ["spill-1.jsonl"],
      "deferred spill stays in the pending queue",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LastRecallStore.drainPendingImpressions reports pendingDeferred when a spill stays unclaimable even though the lock was acquired (#2033)", async () => {
  // Regression for finding 1: acquiring the rotation lock is NOT sufficient to
  // report a clean drain. If the fold cannot claim a spill (rename race), its
  // durable rows stay in the offline-sync-EXCLUDED queue. The drain must report
  // the fold INCOMPLETE (pendingDeferred=true) — even when it DID fold other
  // spills — so the caller retries/aborts instead of snapshotting an active file
  // that omits the leftover row.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-impressions-drain-leftover-"));
  try {
    const impressionsPath = path.join(dir, "state", "recall_impressions.jsonl");
    const pendingDir = `${impressionsPath}.pending.d`;
    await mkdir(pendingDir, { recursive: true });
    const foldable = `${JSON.stringify({ sessionKey: "foldable", writeNonce: "n-ok" })}\n`;
    const stuck = `${JSON.stringify({ sessionKey: "stuck", writeNonce: "n-stuck" })}\n`;
    await writeFile(path.join(pendingDir, "a-foldable.jsonl"), foldable, "utf-8");
    await writeFile(path.join(pendingDir, "b-stuck.jsonl"), stuck, "utf-8");
    // Block ONLY b-stuck's claim: a directory sits at its `.claimed` target, so
    // the claim rename (file -> directory) fails while a-foldable claims cleanly.
    await mkdir(path.join(pendingDir, "b-stuck.jsonl.claimed"), { recursive: true });

    const store = new LastRecallStore(dir);
    await store.load();
    assert.deepEqual(
      await store.drainPendingImpressions(),
      { folded: true, pendingDeferred: true },
      "folded the claimable spill but a leftover remains → deferred, never a clean drain",
    );
    // The claimable row reached the active file; the stuck row did not.
    const active = await readFile(impressionsPath, "utf-8");
    assert.ok(active.includes("foldable"), "claimable spill folded into the active file");
    assert.ok(!active.includes('"sessionKey":"stuck"'), "unclaimable spill NOT folded — still excluded");
    // The leftover live spill is preserved for a later pass.
    assert.ok(
      (await readdir(pendingDir)).includes("b-stuck.jsonl"),
      "leftover spill preserved in the pending queue for a retry",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
