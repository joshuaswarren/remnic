import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readDrainClaimTotals } from "./drain-claim-totals.js";

/** Claim body names look like `s-<64 lowercase hex>.json`; zeros are valid hex. */
function bodyName(n: number): string {
  return `s-${String(n).padStart(64, "0")}.json`;
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "remnic-drain-totals-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a claim body plus a sidecar whose identity matches the body. */
function writeClaim(
  dir: string,
  n: number,
  pending: number,
  oldestTurnAt?: string,
  opts: { sidecar?: boolean } = {},
): void {
  const body = path.join(dir, bodyName(n));
  writeFileSync(body, JSON.stringify({ key: `k${n}`, entry: { turns: [] } }));
  if (opts.sidecar === false) return;
  const identity = statSync(body);
  // JSON.stringify drops an undefined `oldestTurnAt`, which is exactly the
  // legacy (pre-#3442) sidecar shape the back-compat case needs.
  const sidecar = {
    key: `k${n}`,
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    pending,
    drained: 0,
    oldestTurnAt,
  };
  writeFileSync(`${body}.count`, JSON.stringify(sidecar));
}

/** Body mtime pinned to `mtimeMs` BEFORE the sidecar identity is captured: simulates a claim whose last write is old (all legacy sidecars on live hosts). */
function writeClaimWithMtime(dir: string, n: number, pending: number, oldestTurnAt: string | undefined, mtimeMs: number): void {
  const body = path.join(dir, bodyName(n));
  writeFileSync(body, JSON.stringify({ key: `k${n}`, entry: { turns: [] } }));
  utimesSync(body, mtimeMs / 1000, mtimeMs / 1000);
  const identity = statSync(body);
  const sidecar = {
    key: `k${n}`,
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    pending,
    drained: 0,
    oldestTurnAt,
  };
  writeFileSync(`${body}.count`, JSON.stringify(sidecar));
}

test("readDrainClaimTotals: sums pending turns and the oldest turn across verified sidecars", async () => {
  const { dir, cleanup } = setup();
  try {
    writeClaim(dir, 1, 5, "2026-11-10T00:00:00.000Z");
    writeClaim(dir, 2, 7, "2026-11-01T00:00:00.000Z");
    const totals = await readDrainClaimTotals(dir);
    assert.deepEqual(totals, {
      claimedSessions: 2,
      claimedPendingTurns: 12,
      oldestClaimedTurnAt: "2026-11-01T00:00:00.000Z",
      oldestClaimedAgeBasis: "turn",
      verifiedSidecars: 2,
      unverifiedClaims: 0,
      claimsPendingInbox: 0,
      truncated: false,
    });
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: a legacy sidecar falls back to the body mtime as a LOWER BOUND on the oldest turn", async () => {
  const { dir, cleanup } = setup();
  try {
    // Body last written 2026-11-01, no sidecar oldestTurnAt: its oldest turn
    // is AT LEAST as old as the body's last write (every body mutation is a
    // whole-file rewrite, so mtime >= newest turn >= oldest turn).
    writeClaimWithMtime(dir, 1, 9, undefined, Date.parse("2026-11-01T00:00:00.000Z"));
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.oldestClaimedTurnAt, "2026-11-01T00:00:00.000Z");
    assert.equal(totals.oldestClaimedAgeBasis, "claim-mtime-lower-bound");
    assert.equal(totals.claimedPendingTurns, 9);
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: an explicit oldestTurnAt beats a fresher body mtime (basis turn)", async () => {
  const { dir, cleanup } = setup();
  try {
    // Body freshly written (mtime ≈ now) but the sidecar knows the oldest
    // turn: the turn time wins and the basis says so.
    writeClaim(dir, 1, 4, "2026-11-01T00:00:00.000Z");
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.oldestClaimedTurnAt, "2026-11-01T00:00:00.000Z");
    assert.equal(totals.oldestClaimedAgeBasis, "turn");
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: the minimum spans mtime and turn candidates, basis from the winner", async () => {
  const { dir, cleanup } = setup();
  try {
    // Legacy mtime (11-03) is older than the other claim's turn (11-05).
    writeClaimWithMtime(dir, 1, 2, undefined, Date.parse("2026-11-03T00:00:00.000Z"));
    writeClaim(dir, 2, 3, "2026-11-05T00:00:00.000Z");
    let totals = await readDrainClaimTotals(dir);
    assert.equal(totals.oldestClaimedTurnAt, "2026-11-03T00:00:00.000Z");
    assert.equal(totals.oldestClaimedAgeBasis, "claim-mtime-lower-bound");

    // Reversed: a turn (11-02) older than the other claim's mtime (11-03).
    cleanup();
    const { dir: dir2, cleanup: cleanup2 } = setup();
    writeClaim(dir2, 1, 2, "2026-11-02T00:00:00.000Z");
    writeClaimWithMtime(dir2, 2, 3, undefined, Date.parse("2026-11-03T00:00:00.000Z"));
    totals = await readDrainClaimTotals(dir2);
    assert.equal(totals.oldestClaimedTurnAt, "2026-11-02T00:00:00.000Z");
    assert.equal(totals.oldestClaimedAgeBasis, "turn");
    cleanup2();
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: claims with pending 0 contribute no oldest candidate", async () => {
  const { dir, cleanup } = setup();
  try {
    // Fully drained tombstone with an ancient mtime must not skew the age.
    writeClaimWithMtime(dir, 1, 0, undefined, Date.parse("2020-01-01T00:00:00.000Z"));
    writeClaim(dir, 2, 1, "2026-11-10T00:00:00.000Z");
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.oldestClaimedTurnAt, "2026-11-10T00:00:00.000Z");
    assert.equal(totals.oldestClaimedAgeBasis, "turn");
    assert.equal(totals.claimedPendingTurns, 1);
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: a pending hand-in inbox counts the claim and bounds its age even when the body sidecar says pending 0", async () => {
  const { dir, cleanup } = setup();
  try {
    // Body fully drained (sidecar pending 0), but a live owner handed in new
    // turns via the inbox afterwards: those are pending and invisible to the
    // sidecar counts (CodeRabbit round-1 major on drain-claim-totals.ts).
    const body = path.join(dir, bodyName(1));
    writeFileSync(body, JSON.stringify({ key: "k1", entry: { turns: [] } }));
    const identity = statSync(body);
    writeFileSync(`${body}.count`, JSON.stringify({ key: "k1", size: identity.size, mtimeMs: identity.mtimeMs, pending: 0, drained: 2, oldestTurnAt: "2026-01-01T00:00:00.000Z" }));
    // Inbox appended 2026-11-01: every inbox turn predates its last append,
    // so the inbox mtime is a lower bound on the oldest inbox turn's age.
    const inbox = `${body}.inbox.jsonl`;
    writeFileSync(inbox, JSON.stringify({ id: "h1", entry: { turns: [{ role: "user", content: "x", timestamp: "2026-10-30T00:00:00.000Z" }] } }) + "\n");
    utimesSync(inbox, Date.parse("2026-11-01T00:00:00.000Z") / 1000, Date.parse("2026-11-01T00:00:00.000Z") / 1000);
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.claimsPendingInbox, 1);
    assert.equal(totals.oldestClaimedTurnAt, "2026-11-01T00:00:00.000Z");
    assert.equal(totals.oldestClaimedAgeBasis, "claim-mtime-lower-bound");
    assert.equal(totals.claimedPendingTurns, 0, "sidecar pending stays authoritative; inbox magnitudes are unknown");
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: an empty inbox does not count", async () => {
  const { dir, cleanup } = setup();
  try {
    writeClaim(dir, 1, 4, "2026-11-01T00:00:00.000Z");
    writeFileSync(path.join(dir, `${bodyName(1)}.inbox.jsonl`), "");
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.claimsPendingInbox, 0);
    assert.equal(totals.oldestClaimedAgeBasis, "turn");
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: the inbox mtime competes with the turn candidate and the true minimum wins", async () => {
  const { dir, cleanup } = setup();
  try {
    // Turn candidate 11-01 is older than the inbox mtime 11-05: turn wins.
    writeClaim(dir, 1, 2, "2026-11-01T00:00:00.000Z");
    const inbox = path.join(dir, `${bodyName(1)}.inbox.jsonl`);
    writeFileSync(inbox, '{"id":"h1"}\n');
    utimesSync(inbox, Date.parse("2026-11-05T00:00:00.000Z") / 1000, Date.parse("2026-11-05T00:00:00.000Z") / 1000);
    let totals = await readDrainClaimTotals(dir);
    assert.equal(totals.oldestClaimedTurnAt, "2026-11-01T00:00:00.000Z");
    assert.equal(totals.oldestClaimedAgeBasis, "turn");
    assert.equal(totals.claimsPendingInbox, 1);

    // Reversed: an ancient inbox (10-01) beats the turn candidate (11-01).
    cleanup();
    const { dir: dir2, cleanup: cleanup2 } = setup();
    writeClaim(dir2, 1, 2, "2026-11-01T00:00:00.000Z");
    const inbox2 = path.join(dir2, `${bodyName(1)}.inbox.jsonl`);
    writeFileSync(inbox2, '{"id":"h1"}\n');
    utimesSync(inbox2, Date.parse("2026-10-01T00:00:00.000Z") / 1000, Date.parse("2026-10-01T00:00:00.000Z") / 1000);
    totals = await readDrainClaimTotals(dir2);
    assert.equal(totals.oldestClaimedTurnAt, "2026-10-01T00:00:00.000Z");
    assert.equal(totals.oldestClaimedAgeBasis, "claim-mtime-lower-bound");
    cleanup2();
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: an unparsable sidecar oldestTurnAt falls back to the body mtime", async () => {
  const { dir, cleanup } = setup();
  try {
    const body = path.join(dir, bodyName(1));
    writeFileSync(body, JSON.stringify({ key: "k1", entry: { turns: [] } }));
    utimesSync(body, Date.parse("2026-11-02T00:00:00.000Z") / 1000, Date.parse("2026-11-02T00:00:00.000Z") / 1000);
    const identity = statSync(body);
    writeFileSync(`${body}.count`, JSON.stringify({ key: "k1", size: identity.size, mtimeMs: identity.mtimeMs, pending: 3, drained: 0, oldestTurnAt: "not-a-timestamp" }));
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.claimedPendingTurns, 3);
    assert.equal(totals.oldestClaimedTurnAt, new Date(identity.mtimeMs).toISOString());
    assert.equal(totals.oldestClaimedAgeBasis, "claim-mtime-lower-bound");
    assert.equal(totals.claimsPendingInbox, 0);
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: a legacy sidecar without oldestTurnAt still counts its pending turns", async () => {
  const { dir, cleanup } = setup();
  try {
    // Pre-#3442 sidecar shape: counts only, no oldest-turn timestamp.
    writeClaim(dir, 1, 9, undefined);
    writeClaim(dir, 2, 1, "2026-11-05T00:00:00.000Z");
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.claimedPendingTurns, 10);
    assert.equal(totals.oldestClaimedTurnAt, "2026-11-05T00:00:00.000Z");
    // Claim 1's mtime candidate is ≈ now, so claim 2's turn wins.
    assert.equal(totals.oldestClaimedAgeBasis, "turn");
    assert.equal(totals.verifiedSidecars, 2);
    assert.equal(totals.unverifiedClaims, 0);
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: a stale sidecar is skipped WITHOUT parsing the body or rewriting the sidecar", async () => {
  const { dir, cleanup } = setup();
  try {
    // Body holds 999 pending turns; the sidecar predates a body rewrite, so
    // its identity no longer matches. The health path must trust NEITHER: it
    // must not parse the body (999 must not be counted) and must not refresh
    // the sidecar (drain owns summary writes).
    const body = path.join(dir, bodyName(1));
    writeFileSync(body, JSON.stringify({ key: "k1", entry: { turns: Array.from({ length: 999 }, (_, i) => ({ role: "user", content: `t${i}`, timestamp: "2026-01-01T00:00:00.000Z" })) } }));
    writeFileSync(`${body}.count`, JSON.stringify({ key: "k1", size: 1, mtimeMs: 1, pending: 3, drained: 0, oldestTurnAt: "2026-02-01T00:00:00.000Z" }));
    const before = readFileSync(`${body}.count`, "utf8");
    const totals = await readDrainClaimTotals(dir);
    assert.deepEqual(
      { ...totals, oldestClaimedTurnAt: totals.oldestClaimedTurnAt },
      { claimedSessions: 1, claimedPendingTurns: 0, oldestClaimedTurnAt: null, oldestClaimedAgeBasis: null, verifiedSidecars: 0, unverifiedClaims: 1, claimsPendingInbox: 0, truncated: false },
    );
    assert.equal(readFileSync(`${body}.count`, "utf8"), before, "sidecar must not be rewritten by the health-path reader");
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: a claim body without any sidecar is unverified", async () => {
  const { dir, cleanup } = setup();
  try {
    writeClaim(dir, 1, 4, "2026-11-08T00:00:00.000Z");
    writeClaim(dir, 2, 100, "2026-11-09T00:00:00.000Z", { sidecar: false });
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.claimedSessions, 2);
    assert.equal(totals.claimedPendingTurns, 4);
    assert.equal(totals.unverifiedClaims, 1);
    assert.equal(totals.truncated, false);
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: maxClaims bounds the sidecar scan but not the session count", async () => {
  const { dir, cleanup } = setup();
  try {
    writeClaim(dir, 1, 3, "2026-11-10T00:00:00.000Z");
    writeClaim(dir, 2, 4, "2026-11-11T00:00:00.000Z");
    writeClaim(dir, 3, 5, "2026-11-12T00:00:00.000Z");
    const totals = await readDrainClaimTotals(dir, { maxClaims: 2 });
    assert.equal(totals.claimedSessions, 3);
    assert.equal(totals.claimedPendingTurns, 7, "only the bounded prefix is summed");
    assert.equal(totals.verifiedSidecars, 2);
    assert.equal(totals.truncated, true);
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: non-claim files (lease, lock, count, inbox) are not sessions", async () => {
  const { dir, cleanup } = setup();
  try {
    writeClaim(dir, 1, 2, "2026-11-10T00:00:00.000Z");
    // Suffix files around a name that has no body: none of them is a session.
    for (const suffix of [".lease.json", ".lock", ".count", ".inbox.jsonl"]) {
      writeFileSync(path.join(dir, `${bodyName(9)}${suffix}`), "{}");
    }
    writeFileSync(path.join(dir, "not-a-claim.json"), "{}");
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.claimedSessions, 1);
    assert.equal(totals.claimedPendingTurns, 2);
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: a missing claims directory reads as an empty backlog", async () => {
  const { dir, cleanup } = setup();
  try {
    const totals = await readDrainClaimTotals(path.join(dir, "buffer", "drain"));
    assert.deepEqual(totals, {
      claimedSessions: 0,
      claimedPendingTurns: 0,
      oldestClaimedTurnAt: null,
      oldestClaimedAgeBasis: null,
      verifiedSidecars: 0,
      unverifiedClaims: 0,
      claimsPendingInbox: 0,
      truncated: false,
    });
  } finally {
    cleanup();
  }
});

test("readDrainClaimTotals: an unparsable sidecar counts as unverified, not a crash", async () => {
  const { dir, cleanup } = setup();
  try {
    writeClaim(dir, 1, 2, "2026-11-10T00:00:00.000Z");
    writeFileSync(path.join(dir, `${bodyName(2)}.count`), "{not json");
    writeFileSync(path.join(dir, bodyName(2)), "{}");
    const totals = await readDrainClaimTotals(dir);
    assert.equal(totals.claimedSessions, 2);
    assert.equal(totals.unverifiedClaims, 1);
    assert.equal(totals.claimedPendingTurns, 2);
  } finally {
    cleanup();
  }
});
