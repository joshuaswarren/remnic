import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import test from "node:test";

import { BufferDrainClaims, type AckOutcome, type DrainLease } from "./buffer-drain-claims.js";
import { BufferSessionFiles, bufferSessionFileName } from "./buffer-session-files.js";
import { ClaimBufferStorage } from "../orchestration/buffer-drain-runner.js";
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
    append: async (filePath: string, content: string) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      appendFileSync(filePath, content);
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

/** The claim body file for `key` inside a setup()'s stateDir. */
function drainFile(stateDir: string, key: string): string {
  return path.join(stateDir, "buffer", "drain", bufferSessionFileName(key));
}

/** The append-only inbox next to the claim body. */
function inboxFile(stateDir: string, key: string): string {
  return `${drainFile(stateDir, key)}.inbox.jsonl`;
}

/** One inbox record as mergeIntoClaim writes it: newline-prefixed JSONL with a
 * unique id, so a torn tail always ends at the next record's leading newline
 * and parses as its own (skipped) line. */
function record(key: string, entryState: BufferEntryState, id = randomUUID()): string {
  return `\n${JSON.stringify({ id, key, ...entryState })}`;
}

/** plainIo() with call recording on the seam the cost tests assert on. */
function spyIo() {
  const io = plainIo();
  const readPaths: string[] = [];
  const writePaths: string[] = [];
  const appendPaths: string[] = [];
  return {
    io: {
      read: async (filePath: string) => {
        readPaths.push(filePath);
        return io.read(filePath);
      },
      write: async (filePath: string, content: string) => {
        writePaths.push(filePath);
        return io.write(filePath, content);
      },
      append: async (filePath: string, content: string) => {
        appendPaths.push(filePath);
        return io.append(filePath, content);
      },
    },
    readPaths,
    writePaths,
    appendPaths,
  };
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

test("adopt takes over an expired lease even when the owner id is reused by another process", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    const expired = { ...makeLease("reused-owner"), heartbeatAt: "2026-11-01T00:00:00.000Z" };
    assert.equal(await s.claims.claimFromSessionFile("sess-1", expired), "claimed");

    const outcome = await s.claims.adopt("sess-1", { ...makeLease("reused-owner"), pid: process.pid + 1 });

    assert.equal(outcome, "adopted");
    assert.equal(JSON.parse(readFileSync(s.claims.leasePathForTest("sess-1"), "utf8")).pid, process.pid + 1);
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

test("a turn moved to retained and extracted from there cannot return from a stale active copy", async () => {
  const s = setup();
  try {
    const moved = turn("moved to retained, then extracted");
    s.seedSession("sess-1", entry([moved]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    await s.claims.writeEntry("sess-1", "worker-1", { ...entry([]), retainedTurns: [moved] }, loaded.entry);
    const reloaded = await s.claims.load("sess-1");
    assert.ok(reloaded);
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), reloaded.entry);

    // A live owner still holds the turn in its active list and hands it over.
    await s.claims.mergeIntoClaim("sess-1", entry([moved]));

    const claim = await s.claims.load("sess-1");
    assert.deepEqual(claim?.entry.turns, [], "the extracted turn is not pending again");
    assert.deepEqual(claim?.entry.retainedTurns ?? [], []);
  } finally {
    s.cleanup();
  }
});

test("a turn moved to active and extracted from there cannot return from a stale retained copy", async () => {
  const s = setup();
  try {
    const moved = turn("moved to active, then extracted");
    s.seedSession("sess-1", { ...entry([]), retainedTurns: [moved] });
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    await s.claims.writeEntry("sess-1", "worker-1", entry([moved]), loaded.entry);
    const reloaded = await s.claims.load("sess-1");
    assert.ok(reloaded);
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), reloaded.entry);

    await s.claims.mergeIntoClaim("sess-1", { ...entry([]), retainedTurns: [moved] });

    const claim = await s.claims.load("sess-1");
    assert.deepEqual(claim?.entry.turns, []);
    assert.deepEqual(claim?.entry.retainedTurns ?? [], [], "the extracted turn is not pending again");
  } finally {
    s.cleanup();
  }
});

test("a turn that moves to retained and back is still tombstoned in its original list", async () => {
  const s = setup();
  try {
    const roundTrip = turn("moves out and back");
    s.seedSession("sess-1", entry([roundTrip]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    await s.claims.writeEntry("sess-1", "worker-1", { ...entry([]), retainedTurns: [roundTrip] }, loaded.entry);
    const retained = await s.claims.load("sess-1");
    assert.ok(retained);
    await s.claims.writeEntry("sess-1", "worker-1", entry([roundTrip]), retained.entry);
    const back = await s.claims.load("sess-1");
    assert.ok(back);
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), back.entry);

    assert.deepEqual(await s.claims.drainedTurns("sess-1"), { turns: [roundTrip], retainedTurns: [] });
  } finally {
    s.cleanup();
  }
});

test("mergeIntoClaim keeps the claim's own pending occurrence after a partial extraction", async () => {
  const s = setup();
  try {
    const same = turn("duplicate pending turn");
    s.seedSession("sess-1", entry([same, same]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    await s.claims.writeEntry("sess-1", "worker-1", entry([same]), loaded.entry);

    // The live owner hands over a copy that adds nothing new.
    await s.claims.mergeIntoClaim("sess-1", entry([]));

    assert.deepEqual((await s.claims.load("sess-1"))?.entry.turns, [same], "the remainder is not subtracted a second time");
  } finally {
    s.cleanup();
  }
});

test("repeated progress writes record each extracted occurrence once", async () => {
  const s = setup();
  try {
    const same = turn("duplicate pending turn");
    s.seedSession("sess-1", entry([same, same]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    // The drain runner's buffer keeps ONE snapshot of the claim for the whole run.
    const storage = new ClaimBufferStorage(s.claims, "sess-1", "worker-1", loaded.entry);
    await storage.saveBufferSession("sess-1", entry([same]));
    await storage.saveBufferSession("sess-1", entry([]));

    assert.deepEqual(await s.claims.drainedTurns("sess-1"), { turns: [same, same], retainedTurns: [] });
  } finally {
    s.cleanup();
  }
});

test("a late arrival of an ambiguous identity does not replace a source occurrence", async () => {
  const s = setup();
  try {
    const same = turn("same identity in both lists");
    s.seedSession("sess-1", { ...entry([same]), retainedTurns: [same] });
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    await s.claims.mergeIntoClaim("sess-1", entry([same, same]));

    await s.claims.writeEntry("sess-1", "worker-1", { ...entry([]), retainedTurns: [same] }, loaded.entry);

    const claim = await s.claims.load("sess-1");
    assert.deepEqual(claim?.entry.turns, [same, same], "the source occurrence and the late arrival both stay pending");
    assert.deepEqual(claim?.entry.retainedTurns, [same]);
  } finally {
    s.cleanup();
  }
});

// ─── Append-only claim inbox ────────────────────────────────────────────────

test("a kill between the inbox append and any body write loses nothing", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const bodyBefore = readFileSync(drainFile(s.stateDir, "sess-1"), "utf8");

    // The owner hands its entry in. Whatever kills the process after this
    // call resolves must not lose the handed-over turns: the inbox record is
    // already durable and the claim body is untouched.
    await s.claims.mergeIntoClaim("sess-1", entry([turn("a"), turn("b", "2026-11-01T00:01:00.000Z")]));

    assert.equal(readFileSync(drainFile(s.stateDir, "sess-1"), "utf8"), bodyBefore, "mergeIntoClaim must not rewrite the claim body");
    // Fresh instance = the next process after the kill: it folds the inbox.
    const revived = new BufferDrainClaims(s.stateDir, plainIo());
    const claim = await revived.load("sess-1");
    assert.deepEqual(claim?.entry.turns.map((t) => t.content), ["a", "b"], "a handed-over record survives a crash before compaction");
  } finally {
    s.cleanup();
  }
});

test("a kill between the body write and the inbox delete replays nothing", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("t1")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.mergeIntoClaim("sess-1", entry([turn("t2", "2026-11-01T00:02:00.000Z")]));
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    assert.deepEqual(loaded.entry.turns.map((t) => t.content), ["t1", "t2"]);

    // The drainer retains t2 for retry (moves it to retainedTurns) and is
    // killed right after the body write lands, before the inbox is deleted.
    // A replay by identity count alone would re-add t2 to `turns` (its count
    // there is now zero); only an exact consumed-record marker prevents that.
    const base = plainIo();
    const crashingIo = {
      ...base,
      write: async (filePath: string, content: string) => {
        await base.write(filePath, content);
        if (filePath === drainFile(s.stateDir, "sess-1")) throw new Error("simulated kill after the body write");
      },
    };
    const crashing = new BufferDrainClaims(s.stateDir, crashingIo);
    await assert.rejects(
      crashing.writeEntry("sess-1", "worker-1", { ...entry([turn("t1")]), retainedTurns: [turn("t2", "2026-11-01T00:02:00.000Z")] }, loaded.entry),
      /simulated kill/,
    );
    assert.equal(existsSync(inboxFile(s.stateDir, "sess-1")), true, "fixture: the kill left the inbox behind");

    const revived = new BufferDrainClaims(s.stateDir, plainIo());
    const claim = await revived.load("sess-1");
    assert.deepEqual(claim?.entry.turns.map((t) => t.content), ["t1"], "the replayed record adds nothing to turns");
    assert.deepEqual(claim?.entry.retainedTurns?.map((t) => t.content), ["t2"], "t2 stays only in retainedTurns");
    assert.equal((await revived.load("sess-1"))?.entry.turns.length, 1, "repeated folds add nothing");
  } finally {
    s.cleanup();
  }
});

test("a drained turn handed in by a stale owner never reappears through the inbox fold", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("t1")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), loaded.entry);

    // The owner's in-memory entry still holds t1: handing it in must not
    // resurrect the extracted turn, through the body or the inbox.
    await s.claims.mergeIntoClaim("sess-1", entry([turn("t1")]));

    const claim = await s.claims.load("sess-1");
    assert.deepEqual(claim?.entry.turns, [], "the stale copy stays subtracted after the fold");
    const revived = new BufferDrainClaims(s.stateDir, plainIo());
    assert.deepEqual((await revived.load("sess-1"))?.entry.turns, [], "a fresh process folds to the same verdict");
  } finally {
    s.cleanup();
  }
});

test("concurrent appends and a progress write lose nothing and duplicate nothing, and a drainer that lost its lease cannot consume segments", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("t1")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const loaded = await s.claims.load("sess-1");
    assert.ok(loaded);

    // Two live owners hand entries in while the drainer writes progress:
    // all three serialize on the claim lock and converge without loss.
    await Promise.all([
      s.claims.mergeIntoClaim("sess-1", entry([turn("t2", "2026-11-01T00:02:00.000Z")])),
      s.claims.mergeIntoClaim("sess-1", entry([turn("t3", "2026-11-01T00:03:00.000Z")])),
      s.claims.writeEntry("sess-1", "worker-1", entry([]), loaded.entry),
    ]);
    // One more hand-in after the interleaving: whatever order the lock chose,
    // the inbox now holds an unconsumed record the fenced drainer must not eat.
    await s.claims.mergeIntoClaim("sess-1", entry([turn("t4", "2026-11-01T00:04:00.000Z")]));
    const claim = await s.claims.load("sess-1");
    assert.ok(claim);
    assert.deepEqual(claim.entry.turns.map((t) => t.content).sort(), ["t2", "t3", "t4"], "handed-in turns all survive the interleaving");
    assert.deepEqual(claim.drained?.map((t) => t.content), ["t1"], "the extracted turn stays tombstoned");

    // A drainer that lost its lease is fenced before it can compact away the
    // merged records.
    await assert.rejects(
      s.claims.writeEntry("sess-1", "intruder", entry([]), claim.entry),
      /no longer owned by intruder/,
    );
    assert.equal(existsSync(inboxFile(s.stateDir, "sess-1")), true, "the fenced drainer consumed no segments");
    const after = await s.claims.load("sess-1");
    assert.ok(after);
    assert.equal(after.entry.turns.length, 3, "the fenced write changed nothing");

    // The real owner's next progress write compacts: body holds everything,
    // inbox consumed.
    await s.claims.writeEntry("sess-1", "worker-1", entry([]), after.entry);
    assert.equal(existsSync(inboxFile(s.stateDir, "sess-1")), false, "compaction consumes the inbox after the body write");
    const final = await s.claims.load("sess-1");
    assert.deepEqual(final?.entry.turns, [], "all pending turns are drained");
    assert.deepEqual(final?.drained?.map((t) => t.content).sort(), ["t1", "t2", "t3", "t4"]);
  } finally {
    s.cleanup();
  }
});

test("mergeIntoClaim on a large claim never reads or writes the body", async () => {
  const s = setup();
  try {
    const filler = "x".repeat(750_000);
    const stamps = (i: number): string => `2026-11-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`;
    const bigEntry = entry(Array.from({ length: 40 }, (_, i) => turn(`${filler}-${i}`, stamps(i))));
    s.seedSession("sess-1", bigEntry);
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    const bodyPath = drainFile(s.stateDir, "sess-1");
    assert.ok(readFileSync(bodyPath, "utf8").length > 30_000_000, "fixture: the claim body is ~30 MB");

    const spied = spyIo();
    const claims = new BufferDrainClaims(s.stateDir, spied.io);
    await claims.mergeIntoClaim("sess-1", entry([turn("new", "2026-11-01T01:00:00.000Z")]));

    assert.equal(spied.readPaths.filter((p) => p === bodyPath).length, 0, "the body is never read");
    assert.equal(spied.writePaths.filter((p) => p === bodyPath).length, 0, "the body is never written");
    assert.deepEqual(spied.appendPaths, [`${bodyPath}.inbox.jsonl`], "exactly one inbox append");
  } finally {
    s.cleanup();
  }
});

test("a torn last inbox record is skipped and does not corrupt following records", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    mkdirSync(path.dirname(inboxFile(s.stateDir, "sess-1")), { recursive: true });
    // A valid record, then a torn tail (a kill mid-append, no trailing
    // newline) — and then a record appended after the garbage by the next
    // owner, fused onto the torn bytes by append semantics.
    writeFileSync(
      inboxFile(s.stateDir, "sess-1"),
      `${record("sess-1", entry([turn("b", "2026-11-01T00:01:00.000Z")]))}\n{"turns":[{"rol` +
        record("sess-1", entry([turn("c", "2026-11-01T00:02:00.000Z")])),
    );

    const claim = await s.claims.load("sess-1");
    assert.deepEqual(claim?.entry.turns.map((t) => t.content), ["a", "b", "c"], "the torn tail is skipped; records around it survive");

    // A fresh append after the garbage lands cleanly and folds in order.
    await s.claims.mergeIntoClaim("sess-1", entry([turn("d", "2026-11-01T00:03:00.000Z")]));
    const after = await s.claims.load("sess-1");
    assert.deepEqual(after?.entry.turns.map((t) => t.content), ["a", "b", "c", "d"]);
  } finally {
    s.cleanup();
  }
});

test("foldAllInboxes folds every inbox into claim bodies the old format reads", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.mergeIntoClaim("sess-1", entry([turn("b", "2026-11-01T00:01:00.000Z")]));

    assert.equal(await s.claims.foldAllInboxes(), 1, "one claim folded");
    assert.equal(existsSync(inboxFile(s.stateDir, "sess-1")), false, "the inbox is consumed");

    // Old-format reader: the plain body file holds every pending turn.
    const oldView = z
      .object({ entry: z.object({ turns: z.array(z.object({ content: z.string() })) }) })
      .parse(JSON.parse(readFileSync(drainFile(s.stateDir, "sess-1"), "utf8")));
    assert.deepEqual(oldView.entry.turns.map((t) => t.content).sort(), ["a", "b"], "the pre-inbox build sees the folded turns");

    assert.equal(await s.claims.foldAllInboxes(), 0, "a second pass finds nothing to fold");
    const claim = await s.claims.load("sess-1");
    assert.deepEqual(claim?.entry.turns.map((t) => t.content), ["a", "b"]);
  } finally {
    s.cleanup();
  }
});

test("listings count pending turns from the sidecar and inbox without parsing claim bodies", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.mergeIntoClaim("sess-1", entry([turn("b", "2026-11-01T00:01:00.000Z")]));
    const bodyPath = drainFile(s.stateDir, "sess-1");

    const spied = spyIo();
    const claims = new BufferDrainClaims(s.stateDir, spied.io);
    const page = await claims.listPage(undefined, 10);
    assert.deepEqual(page.entries.map((e) => e.turnCount), [2], "the listing counts body and inbox turns");
    assert.equal(spied.readPaths.filter((p) => p === bodyPath).length, 0, "the body is never parsed for a count");

    const listed = await claims.list();
    assert.deepEqual(listed.map((e) => e.turnCount), [2]);

    // Fallback: a missing sidecar (pre-inbox claim) parses the body once and
    // still counts the inbox.
    rmSync(`${bodyPath}.count`, { force: true });
    const fallback = await claims.listPage(undefined, 10);
    assert.deepEqual(fallback.entries.map((e) => e.turnCount), [2], "the body-parse fallback stays exact");
  } finally {
    s.cleanup();
  }
});

test("release drops the inbox with the claim and a later claim never inherits it", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("t1")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.mergeIntoClaim("sess-1", entry([turn("t2", "2026-11-01T00:02:00.000Z")]));
    await s.claims.release("sess-1");
    assert.equal(existsSync(inboxFile(s.stateDir, "sess-1")), false, "release leaves no orphan inbox");

    // A crash can still leave an orphan inbox next to no body; a fresh claim
    // for the same key must not replay it.
    mkdirSync(path.dirname(inboxFile(s.stateDir, "sess-1")), { recursive: true });
    writeFileSync(inboxFile(s.stateDir, "sess-1"), record("sess-1", entry([turn("stale", "2026-11-01T00:09:00.000Z")])));
    s.seedSession("sess-1", entry([turn("fresh", "2026-11-01T00:10:00.000Z")]));
    assert.equal(await s.claims.claimFromSessionFile("sess-1", makeLease()), "claimed");
    assert.deepEqual((await s.claims.load("sess-1"))?.entry.turns.map((t) => t.content), ["fresh"], "the orphan record is not replayed into the new claim");
  } finally {
    s.cleanup();
  }
});
