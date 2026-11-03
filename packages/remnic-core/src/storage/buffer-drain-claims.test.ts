import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";

import { BufferDrainClaims, type DrainLease } from "./buffer-drain-claims.js";
import { bufferSessionFileName } from "./buffer-session-files.js";
import type { BufferEntryState } from "../types.js";

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

test("writeEntry replaces the claim content; ack keeps a tombstone the owner consumes", async () => {
  const s = setup();
  try {
    s.seedSession("sess-1", entry([turn("a"), turn("b")]));
    await s.claims.claimFromSessionFile("sess-1", makeLease());
    await s.claims.writeEntry("sess-1", entry([turn("b")]));
    assert.deepEqual((await s.claims.load("sess-1"))?.entry.turns.map((t) => t.content), ["b"]);
    assert.deepEqual((await s.claims.drainedTurns("sess-1")).map((t) => t.content), ["a"], "extracted turns are recorded");
    assert.equal(await s.claims.ack("sess-1", "not-the-owner"), "busy");
    assert.equal(await s.claims.ack("sess-1", "worker-1"), "not_empty");
    await s.claims.writeEntry("sess-1", entry([]));
    assert.equal(await s.claims.ack("sess-1", "worker-1"), "acked");
    // The claim file stays as a tombstone: a live owner with a stale copy
    // subtracts the drained turns instead of writing them back.
    assert.equal(s.claims.isClaimed("sess-1"), true);
    assert.deepEqual((await s.claims.drainedTurns("sess-1")).map((t) => t.content), ["a", "b"]);
    assert.equal(existsSync(s.claims.leasePathForTest("sess-1")), false, "the lease is released");
    await s.claims.release("sess-1");
    assert.equal(s.claims.isClaimed("sess-1"), false);
  } finally {
    s.cleanup();
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
