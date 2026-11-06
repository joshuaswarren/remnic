import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";

import { BufferDrainClaims, type AckOutcome, type DrainLease } from "./buffer-drain-claims.js";
import { BufferSessionFiles, bufferSessionFileName } from "./buffer-session-files.js";
import type { BufferEntryState } from "../types.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
/** Plain-file BufferFileIo double: claims logic is file-atomic, not crypto-aware. */
function plainIo() {
  return {
    read: async (filePath: string) => readFileSync(filePath, "utf8"),
    write: async (filePath: string, content: string) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      writeFileSync(tmp, content);
      // Write-to-temp then rename: readers never observe a partial claim.
      rmSync(filePath, { force: true });
      writeFileSync(filePath, content);
      rmSync(tmp, { force: true });
    },
  };
}


function turn(content: string, timestamp = "2026-11-01T00:00:00.000Z") {
  return { role: "user" as const, content, timestamp, sessionKey: "sess-1" };
}

function entry(turns: ReturnType<typeof turn>[]): BufferEntryState {
  return { turns, lastExtractionAt: null, extractionCount: 0 };
}

function setup() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remnic-drain-claims-"));
  const claims = new BufferDrainClaims(stateDir, plainIo());
  const sessionFile = (key: string) => path.join(stateDir, "buffer", bufferSessionFileName(key));
  const seedSession = (key: string, entryState: BufferEntryState) => {
    mkdirSync(path.dirname(sessionFile(key)), { recursive: true });
    writeFileSync(sessionFile(key), JSON.stringify({ key, ...entryState }));
  };
  return { stateDir, claims, sessionFile, seedSession, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

function makeLease(ownerId = "worker-1"): DrainLease {
  const now = new Date().toISOString();
  return { ownerId, pid: process.pid, host: hostname(), acquiredAt: now, heartbeatAt: now, leaseMs: 60_000 };
}

test("claimFromSessionFile moves a session file into the drain dir atomically", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("hello")]));
    const outcome = await s.claims.claimFromSessionFile("sess-1", makeLease());
    assert.equal(outcome, "claimed");
    assert.equal(existsSync(s.sessionFile("sess-1")), false, "session file must be gone");
    assert.equal(s.claims.isClaimed("sess-1"), true);
    const claim = await s.claims.load("sess-1");
    assert.ok(claim);
    assert.equal(claim.key, "sess-1");
    assert.equal(claim.entry.turns.length, 1);
    assert.equal(claim.entry.turns[0]?.content, "hello");
  } finally {
    s.cleanup();
  }
});

test("claimFromSessionFile reports empty for a missing or empty session and leaves no claim", async () => {
  const s = setup();
  try {
    assert.equal(await s.claims.claimFromSessionFile("missing", makeLease()), "empty");
    assert.equal(s.claims.isClaimed("missing"), false);
    s.seedSession("blank", entry([]));
    assert.equal(await s.claims.claimFromSessionFile("blank", makeLease()), "empty");
    assert.equal(s.claims.isClaimed("blank"), false);
    assert.equal(existsSync(s.sessionFile("blank")), true, "an empty live session belongs to its owner, not the drain");
  } finally {
    s.cleanup();
  }
});

test("claimFromSessionFile refuses a key that is already claimed", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease()), "claimed");
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease()), "already_claimed");
    const claim = await s.claims.load("sess-1");
    assert.equal(claim?.entry.turns.length, 1, "the losing claim must not corrupt the winner's content");
  } finally {
    s.cleanup();
  }
});

test("claimFromSessionFile cleans up an unleased orphan claim it re-claims", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.releaseLease("sess-1", "worker-1");
    // A claim file with no lease is an orphan from a killed drainer: the next
    // claim call must hand the SAME durable content to the new owner.
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease()), "already_claimed");
    const adopted = await s.claims.adopt("sess-1", { ...makeLease("worker-2") });
    assert.equal(adopted, "adopted");
    const claim = await s.claims.load("sess-1");
    assert.equal(claim?.entry.turns.length, 1, "orphaned content survives the takeover");
  } finally {
    s.cleanup();
  }
});

test("adopt takes over an expired lease and refuses a live one", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    assert.equal(await s.claims.adopt("sess-1", { ...makeLease("worker-2") }), "busy");
    // Expire the lease by backdating its heartbeat beyond leaseMs.
    const leasePath = s.claims.leasePathForTest("sess-1");
    const stale = { ...makeLease(), heartbeatAt: new Date(Date.now() - 10 * makeLease().leaseMs).toISOString() };
    writeFileSync(leasePath, JSON.stringify(stale));
    assert.equal(await s.claims.adopt("sess-1", { ...makeLease("worker-2") }), "adopted");
    assert.equal(await s.claims.heartbeat("sess-1", "worker-1", makeLease().leaseMs), "lost", "the previous owner must detect the takeover");
    assert.equal(await s.claims.heartbeat("sess-1", "worker-2", makeLease().leaseMs), "ok");
  } finally {
    s.cleanup();
  }
});

test("mergeIntoClaim appends unseen turns and dedupes turns already claimed", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a"), turn("b", "2026-11-01T00:01:00.000Z")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    // A live writer (the daemon) hands over its memory entry after the claim:
    // the same old turns PLUS a new one. Nothing may duplicate.
    await s.claims.mergeIntoClaim("sess-1", entry([turn("a"), turn("b", "2026-11-01T00:01:00.000Z"), turn("c", "2026-11-01T00:02:00.000Z")]));
    const claim = await s.claims.load("sess-1");
    assert.deepEqual(claim?.entry.turns.map((t) => t.content), ["a", "b", "c"]);
    assert.equal(await s.claims.ack("sess-1", "worker-1"), "not_empty");
  } finally {
    s.cleanup();
  }
});

test("claim merge and reload preserve duplicate occurrence counts after partial extraction", async () => {
  const s = setup();
  try {
    const same = turn("duplicate pending turn");
    s.seedSession("sess-1", entry([same, same]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const initial = await s.claims.load("sess-1");
    assert.ok(initial);

    await s.claims.writeEntry("sess-1", "worker-1", entry([same]), initial.entry);
    assert.deepEqual(await s.claims.drainedTurns("sess-1"), { turns: [same], retainedTurns: [] });
    await s.claims.mergeIntoClaim("sess-1", entry([same, same]));

    const reloaded = new BufferDrainClaims(s.stateDir, plainIo());
    assert.deepEqual((await reloaded.load("sess-1"))?.entry.turns, [same]);
    assert.deepEqual(await reloaded.drainedTurns("sess-1"), { turns: [same], retainedTurns: [] });
  } finally {
    s.cleanup();
  }
});

test("claim merge and reload retain every pending duplicate occurrence", async () => {
  const s = setup();
  try {
    const initial = turn("initial pending turn");
    const duplicate = turn("new duplicate", "2026-11-01T00:01:00.000Z");
    s.seedSession("sess-1", entry([initial]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.mergeIntoClaim("sess-1", entry([initial, duplicate, duplicate]));

    const reloaded = new BufferDrainClaims(s.stateDir, plainIo());
    assert.deepEqual((await reloaded.load("sess-1"))?.entry.turns, [initial, duplicate, duplicate]);
  } finally {
    s.cleanup();
  }
});

test("mergeIntoClaim also dedupes retainedTurns", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", { ...entry([turn("a")]), retainedTurns: [turn("kept")] });
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.mergeIntoClaim("sess-1", { ...entry([]), retainedTurns: [turn("kept"), turn("kept2")] });
    const claim = await s.claims.load("sess-1");
    assert.deepEqual(claim?.entry.retainedTurns?.map((t) => t.content), ["kept", "kept2"]);
    assert.deepEqual(claim?.entry.turns.map((t) => t.content), ["a"]);
  } finally {
    s.cleanup();
  }
});

test("mergeIntoClaim preserves retained work when the same identity drained from active turns", async () => {
  const s = setup();
  try {
    const same = turn("source identity");
    s.seedSession("sess-1", entry([same]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const claimed = await s.claims.load("sess-1");
    assert.ok(claimed);
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), claimed.entry);

    await s.claims.mergeIntoClaim("sess-1", { ...entry([]), retainedTurns: [same] });

    assert.deepEqual((await s.claims.load("sess-1"))?.entry.retainedTurns, [same]);
  } finally {
    s.cleanup();
  }
});

test("writeEntry replaces the claim content; ack keeps a tombstone the owner consumes", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a"), turn("b")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.writeEntry("sess-1", "worker-1", entry([turn("b")]));
    assert.deepEqual((await s.claims.load("sess-1"))?.entry.turns.map((t) => t.content), ["b"]);
    assert.deepEqual((await s.claims.drainedTurns("sess-1")).turns.map((t) => t.content), ["a"], "extracted turns are recorded");
    assert.equal(await s.claims.ack("sess-1", "not-the-owner"), "busy");
    assert.equal(await s.claims.ack("sess-1", "worker-1"), "not_empty");
    await s.claims.writeEntry("sess-1", "worker-1", entry([]));
    assert.equal(await s.claims.ack("sess-1", "worker-1"), "acked");
    // The claim file stays as a tombstone: a live owner with a stale copy
    // subtracts the drained turns instead of writing them back.
    assert.equal(s.claims.isClaimed("sess-1"), true);
    assert.deepEqual((await s.claims.drainedTurns("sess-1")).turns.map((t) => t.content), ["a", "b"]);
    assert.equal(existsSync(s.claims.leasePathForTest("sess-1")), false, "the lease is released");
    await s.claims.release("sess-1");
    assert.equal(s.claims.isClaimed("sess-1"), false);
  } finally {
    s.cleanup();
  }
});

test("a tombstone subtracts only its original list when a stale entry has an identical retained copy", async () => {
  const s = setup();
  try {
    const same = turn("one source identity");
    s.seedSession("sess-1", entry([same]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const claim = await s.claims.load("sess-1");
    assert.ok(claim);
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), claim.entry);
    assert.equal(await s.claims.ack("sess-1", "worker-1"), "acked");

    const files = new BufferSessionFiles(s.stateDir, plainIo());
    const staleLiveEntry: BufferEntryState = {
      ...entry([same]),
      retainedTurns: [same],
    };
    const outcome = await files.save("sess-1", staleLiveEntry);
    assert.deepEqual(outcome.drainedTurns, { turns: [same], retainedTurns: [] });
    const persisted = JSON.parse(readFileSync(s.sessionFile("sess-1"), "utf8"));
    assert.deepEqual(persisted.turns, [], "the extracted active occurrence is removed");
    assert.deepEqual(persisted.retainedTurns, [same], "an identical retained occurrence is not removed by active provenance");
  } finally {
    s.cleanup();
  }
});

test("adopt rejects a reused owner id from a different process identity", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    const original = { ...makeLease("reused-owner"), pid: process.pid };
    assert.equal(await s.claims.claimFromSessionFile("sess-1", original), "claimed");

    const outcome = await s.claims.adopt("sess-1", {
      ...makeLease("reused-owner"),
      pid: process.pid + 1,
    });

    assert.equal(outcome, "busy");
    assert.equal(JSON.parse(readFileSync(s.claims.leasePathForTest("sess-1"), "utf8")).pid, process.pid);
  } finally {
    s.cleanup();
  }
});

test("reused owner IDs cannot authorize stale operations from another process", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("pending")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease("reused-owner")), "claimed");
    const claim = await s.claims.load("sess-1");
    assert.ok(claim);
    const replacement = { ...makeLease("reused-owner"), pid: process.pid + 1 };
    writeFileSync(s.claims.leasePathForTest("sess-1"), JSON.stringify(replacement));

    await assert.rejects(
      s.claims.writeEntry("sess-1", "reused-owner", entry([]), claim.entry),
      /no longer owned/,
    );
    assert.equal(await s.claims.heartbeat("sess-1", "reused-owner", 60_000), "lost");
    assert.equal(await s.claims.ack("sess-1", "reused-owner"), "busy");
    await s.claims.releaseLease("sess-1", "reused-owner");
    assert.equal(await s.claims.drainedTurnsForOwner("sess-1", "reused-owner"), null);
    assert.equal(JSON.parse(readFileSync(s.claims.leasePathForTest("sess-1"), "utf8")).pid, replacement.pid);
    assert.deepEqual((await s.claims.load("sess-1"))?.entry.turns, [turn("pending")]);
  } finally {
    s.cleanup();
  }
});

test("releaseLease preserves a replacement lease acquired under the claim lock", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remnic-drain-release-race-"));
  const claims = new BufferDrainClaims(stateDir, plainIo());
  const key = "sess-1";
  const sessionPath = path.join(stateDir, "buffer", bufferSessionFileName(key));
  const claimPath = path.join(stateDir, "buffer", "drain", bufferSessionFileName(key));
  let release: Promise<void> | undefined;
  try {
    mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, JSON.stringify({ key, ...entry([turn("a")]) }));
    assert.equal(await claims.claimFromSessionFile(key, makeLease("owner-one")), "claimed");

    await withHeldFileLock(`${claimPath}.lock`, { staleMs: 5_000 }, async (acquired) => {
      assert.equal(acquired, true);
      release = claims.releaseLease(key, "owner-one");
      writeFileSync(claims.leasePathForTest(key), JSON.stringify(makeLease("owner-two")));
    });
    await release;

    assert.equal(JSON.parse(readFileSync(claims.leasePathForTest(key), "utf8")).ownerId, "owner-two");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("ack preserves a replacement lease acquired under the claim lock", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remnic-drain-ack-race-"));
  const claims = new BufferDrainClaims(stateDir, plainIo());
  const key = "sess-1";
  const sessionPath = path.join(stateDir, "buffer", bufferSessionFileName(key));
  const claimPath = path.join(stateDir, "buffer", "drain", bufferSessionFileName(key));
  let ack: Promise<AckOutcome> | undefined;
  try {
    mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, JSON.stringify({ key, ...entry([turn("a")]) }));
    assert.equal(await claims.claimFromSessionFile(key, makeLease("owner-one")), "claimed");
    const claimed = await claims.load(key);
    assert.ok(claimed);
    await claims.writeEntry(key, "owner-one", entry([]), claimed.entry);

    await withHeldFileLock(`${claimPath}.lock`, { staleMs: 5_000 }, async (acquired) => {
      assert.equal(acquired, true);
      ack = claims.ack(key, "owner-one");
      writeFileSync(claims.leasePathForTest(key), JSON.stringify(makeLease("owner-two")));
    });
    await ack;

    assert.equal(JSON.parse(readFileSync(claims.leasePathForTest(key), "utf8")).ownerId, "owner-two");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("releaseLease keeps the claim content so a later run resumes it", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.releaseLease("sess-1", "worker-1");
    assert.equal(s.claims.isClaimed("sess-1"), true, "content must survive the lease release");
    assert.equal(existsSync(s.claims.leasePathForTest("sess-1")), false);
    const listed = await s.claims.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.key, "sess-1");
    assert.equal(listed[0]?.leased, false);
  } finally {
    s.cleanup();
  }
});

test("list reports lease liveness and expiry", async () => {
  const s = setup();
  try {
    s.seedSession("a", entry([turn("1")]));
    s.seedSession("b", entry([turn("2")]));
    await s.claims.claimFromSessionFile("a", makeLease());
    await s.claims.claimFromSessionFile("b", { ...makeLease("worker-2") });
    const stale = { ...makeLease(), heartbeatAt: new Date(Date.now() - 10 * makeLease().leaseMs).toISOString() };
    writeFileSync(s.claims.leasePathForTest("b"), JSON.stringify(stale));
    const listed = await s.claims.list();
    assert.deepEqual(listed.map((c) => c.key).sort(), ["a", "b"]);
    const a = listed.find((c) => c.key === "a");
    const b = listed.find((c) => c.key === "b");
    assert.equal(a?.leased, true);
    assert.equal(a?.leaseExpired, false);
    assert.equal(b?.leased, true);
    assert.equal(b?.leaseExpired, true);
  } finally {
    s.cleanup();
  }
});

test("claims live in their own directory and never collide with session files", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const bufferDir = path.join(s.stateDir, "buffer");
    const topLevel = readdirSync(bufferDir, { withFileTypes: true }).filter((d) => d.isFile());
    // Only the drain subdirectory plus nothing else: the loader's isFile scan
    // must never see claim content as a session.
    assert.deepEqual(topLevel.map((d) => d.name), []);
  } finally {
    s.cleanup();
  }
});

test("claimFromSessionFile never replaces an existing claim", async () => {
  const s = setup();
  try {
    // First drainer claims the session; then a session file reappears beside
    // the claim (an owner TOCTOU write, or a crash between the tombstone
    // consume and its release). The next claim attempt must keep the claim
    // and its lease exactly as they are.
    s.seedSession("sess-1", entry([turn("claim content")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease("worker-original")), "claimed");
    s.seedSession("sess-1", entry([turn("fresh owner copy")]));
    const outcome = await s.claims.claimFromSessionFile("sess-1", makeLease("worker-two"));
    assert.equal(outcome, "already_claimed");
    const claim = await s.claims.load("sess-1");
    assert.ok(claim);
    assert.deepEqual(
      claim.entry.turns.map((t) => t.content),
      ["claim content"],
      "the existing claim content survives the second claim attempt",
    );
        // SAFETY: the lease body is written by this test / the claims module with an ownerId field.
const lease = JSON.parse(readFileSync(s.claims.leasePathForTest("sess-1"), "utf8")) as { ownerId: string };
    assert.equal(lease.ownerId, "worker-original", "the original lease is untouched");
  } finally {
    s.cleanup();
  }
});

test("adopt takes over a dead owner's claim in one call and keeps a lease", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("hello")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease("worker-dead")), "claimed");
    // Simulate the killed worker: its lease is unexpired but its pid is gone.
    const deadLease = { ...makeLease("worker-dead"), pid: 4_500_000 };
    writeFileSync(s.claims.leasePathForTest("sess-1"), JSON.stringify(deadLease));
    const outcome = await s.claims.adopt("sess-1", makeLease("worker-new"));
    assert.equal(outcome, "adopted", "a dead owner's claim is adoptable without waiting for expiry");
        // SAFETY: the lease body is written by this test / the claims module with an ownerId field.
const lease = JSON.parse(readFileSync(s.claims.leasePathForTest("sess-1"), "utf8")) as { ownerId: string };
    assert.equal(lease.ownerId, "worker-new", "the takeover leaves a lease behind");
  } finally {
    s.cleanup();
  }
});

test("concurrent adopters of an expired lease resolve to exactly one winner", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("hello")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease("worker-first")), "claimed");
    const expired = { ...makeLease("worker-first"), heartbeatAt: new Date(Date.now() - 10 * makeLease().leaseMs).toISOString() };
    writeFileSync(s.claims.leasePathForTest("sess-1"), JSON.stringify(expired));
    const outcomes = await Promise.all([
      s.claims.adopt("sess-1", makeLease("worker-a")),
      s.claims.adopt("sess-1", makeLease("worker-b")),
      s.claims.adopt("sess-1", makeLease("worker-c")),
    ]);
    assert.equal(outcomes.filter((o) => o === "adopted").length, 1, "exactly one adopter wins");
        // SAFETY: the lease body is written by this test / the claims module with an ownerId field.
const lease = JSON.parse(readFileSync(s.claims.leasePathForTest("sess-1"), "utf8")) as { ownerId: string };
    const winner = ["worker-a", "worker-b", "worker-c"][outcomes.indexOf("adopted")];
    assert.equal(lease.ownerId, winner, "the surviving lease belongs to the winner");
  } finally {
    s.cleanup();
  }
});

test("writeEntry keeps turns merged into the claim after the drainer loaded it", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("t1")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease()), "claimed");
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded, "the drainer loaded the claim");
    // The daemon appends t2 while the drainer works; the drainer then reports
    // its snapshot fully extracted.
    await s.claims.mergeIntoClaim("sess-1", entry([turn("t2")]));
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), loaded.entry);
    const claim = await s.claims.load("sess-1");
    assert.ok(claim);
    assert.deepEqual(
      claim.entry.turns.map((t) => t.content),
      ["t2"],
      "the late-merged turn stays pending instead of being marked drained",
    );
    assert.deepEqual(
      (claim.drained ?? []).map((t) => t.content),
      ["t1"],
      "only the turn the drainer actually saw is recorded as drained",
    );
  } finally {
    s.cleanup();
  }
});

test("mergeIntoClaim does not resurrect turns the drain already extracted", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("t1")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease()), "claimed");
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), loaded.entry); // t1 extracted
    // The owner still holds a stale in-memory copy of t1 plus a genuinely new
    // t2: merging must keep t1 out of the pending entry.
    await s.claims.mergeIntoClaim("sess-1", entry([turn("t1"), turn("t2")]));
    const claim = await s.claims.load("sess-1");
    assert.ok(claim);
    assert.deepEqual(
      claim.entry.turns.map((t) => t.content),
      ["t2"],
      "the extracted turn never re-enters the pending entry",
    );
    assert.deepEqual((claim.drained ?? []).map((t) => t.content), ["t1"]);
  } finally {
    s.cleanup();
  }
});

test("a claim counts as drained only when the acked tombstone is complete", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("t1"), turn("t2")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease()), "claimed");
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    // Mid-drain: t2 extracted, t1 pending, lease alive.
    await s.claims.writeEntry("sess-1", "worker-1", entry([turn("t1")]), loaded.entry);
    assert.equal(await s.claims.isDrained("sess-1"), false, "partial drained is not finished");
    // Everything extracted but the drainer still holds the lease.
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), loaded.entry);
    assert.equal(await s.claims.isDrained("sess-1"), false, "an unacked claim is not finished");
    // Ack: the drainer drops its lease and leaves the tombstone.
    await s.claims.releaseLease("sess-1", makeLease().ownerId);
    assert.equal(await s.claims.isDrained("sess-1"), true, "the acked tombstone is finished");
  } finally {
    s.cleanup();
  }
});

test("writeEntry rejects progress from a drainer that lost the lease", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("t1")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease("worker-old")), "claimed");
    // Expire worker-old's lease and let worker-two adopt the claim.
    const expired = { ...makeLease("worker-old"), heartbeatAt: new Date(Date.now() - 10 * makeLease().leaseMs).toISOString() };
    writeFileSync(s.claims.leasePathForTest("sess-1"), JSON.stringify(expired));
    assert.equal(await s.claims.adopt("sess-1", makeLease("worker-two")), "adopted");
    // The superseded drainer must not write progress: it could restore turns
    // the new owner already extracted.
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    await assert.rejects(
      () => s.claims.writeEntry("sess-1", "worker-old", entry([]), loaded.entry),
      /no longer owned/,
    );
    await s.claims.writeEntry("sess-1", "worker-two", entry([]), loaded.entry);
    assert.deepEqual((await s.claims.drainedTurns("sess-1")).turns.map((t) => t.content), ["t1"], "the new owner's progress lands");
  } finally {
    s.cleanup();
  }
});

test("a retained turn the drainer extracted is tombstoned, not dropped", async () => {
  const s = setup();
  try {
    const claimEntry: BufferEntryState = { turns: [turn("t1")], retainedTurns: [turn("r1")], lastExtractionAt: null, extractionCount: 0 };
    s.seedSession("sess-1", claimEntry);
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease()), "claimed");
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    // The drainer extracts everything, including the retained copy.
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), loaded.entry);
    const claim = await s.claims.load("sess-1");
    assert.ok(claim);
    assert.deepEqual((claim.drainedRetained ?? []).map((t) => t.content), ["r1"], "the extracted retained copy is recorded");
    assert.deepEqual((await s.claims.drainedTurns("sess-1")).retainedTurns.map((t) => t.content), ["r1"]);
    // A live owner still holding a stale retained copy cannot resurrect it.
    await s.claims.mergeIntoClaim("sess-1", { turns: [], retainedTurns: [turn("r1")], lastExtractionAt: null, extractionCount: 0 });
    const after = await s.claims.load("sess-1");
    assert.ok(after);
    assert.deepEqual(after.entry.retainedTurns ?? [], [], "the stale retained copy never re-enters the claim");
    // A retained-only tombstone counts as a finished drain.
    await s.claims.releaseLease("sess-1", "worker-1");
    assert.equal(await s.claims.isDrained("sess-1"), true, "a claim with only extracted retained turns is finished");
  } finally {
    s.cleanup();
  }
});

test("a turn the drainer retained for retry is not recorded as drained", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("t1")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease()), "claimed");
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    // The drainer moved t1 into its retained list (deferred retry): it is
    // still pending, not extracted.
    await s.claims.writeEntry("sess-1", "worker-1", { turns: [], retainedTurns: [turn("t1")], lastExtractionAt: null, extractionCount: 0 }, loaded.entry);
    const claim = await s.claims.load("sess-1");
    assert.ok(claim);
    assert.deepEqual((claim.drained ?? []).map((t) => t.content), [], "a retained-for-retry turn stays out of drained");
    assert.deepEqual((claim.entry.retainedTurns ?? []).map((t) => t.content), ["t1"], "the retained copy stays pending in the claim");
  } finally {
    s.cleanup();
  }
});
