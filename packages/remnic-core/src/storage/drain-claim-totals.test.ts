import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readDrainClaimTotals } from "./drain-claim-totals.js";

/** Claim body names look like `s-<64 lowercase hex>.json`; zeros are valid hex. */
function bodyName(n: number): string {
  return `s-${String(n).padStart(64, "0")}.json`;
}

function setup(): { dir: string; cleanup: () => void } {
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
  const sidecar: Record<string, unknown> = {
    key: `k${n}`,
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    pending,
    drained: 0,
  };
  if (oldestTurnAt !== undefined) sidecar.oldestTurnAt = oldestTurnAt;
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
      verifiedSidecars: 2,
      unverifiedClaims: 0,
      truncated: false,
    });
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
      { claimedSessions: 1, claimedPendingTurns: 0, oldestClaimedTurnAt: null, verifiedSidecars: 0, unverifiedClaims: 1, truncated: false },
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
    for (const suffix of [".lease.json", ".lock", ".count", ".inbox.jsonl"]) {
      writeFileSync(path.join(dir, `${bodyName(1)}${suffix}`), "{}");
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
      verifiedSidecars: 0,
      unverifiedClaims: 0,
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
