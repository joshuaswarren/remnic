import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFLINE_SYNC_MAX_MTIME_MS,
  OFFLINE_SYNC_SNAPSHOT_FORMAT,
  normalizeOfflineSyncSnapshot,
} from "../offline-sync.js";
import {
  type ReconcilePlanEntry,
  ReconcilePlanInputError,
  compareReconcilePlanEntries,
  planNamespaceReconciliation,
  planReconciliation,
  semanticAgreementKey,
} from "./plan.js";

/**
 * Issue #2477: offline-sync and the reconcile planner validate the same peer
 * census fields, and cursor/manifest order and key plan entries the same way.
 * These tests fail the moment one surface drifts from the other, which was
 * previously a silent convergence bug.
 */

const PATH = "facts/2026-03-01/a.md";
const GOOD_SHA = "a".repeat(64);

type CensusOutcome = { accepted: boolean; digest?: string };

/** Validate one census file record through the offline-sync snapshot surface. */
function offlineSyncOutcome(overrides: Record<string, unknown>): CensusOutcome {
  try {
    const snapshot = normalizeOfflineSyncSnapshot({
      format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
      schemaVersion: 1,
      createdAt: "2026-08-17T00:00:00.000Z",
      sourceId: "peer",
      includeTranscripts: false,
      files: [{ path: PATH, bytes: 1, mtimeMs: 0, sha256: GOOD_SHA, ...overrides }],
    });
    return { accepted: true, digest: snapshot.files[0]?.sha256 };
  } catch {
    return { accepted: false };
  }
}

/** Validate the same record through the reconcile planner's census surface. */
function reconcileOutcome(overrides: Record<string, unknown>): CensusOutcome {
  try {
    const entries = planNamespaceReconciliation({
      namespace: "default",
      local: [{ path: PATH, sha256: GOOD_SHA, mtimeMs: 0, ...overrides }],
      peer: [],
    });
    return { accepted: true, digest: entries.find((e) => e.path === PATH)?.localSha256 };
  } catch (err) {
    assert.ok(err instanceof ReconcilePlanInputError, "plan census rejects must stay ReconcilePlanInputError");
    return { accepted: false };
  }
}

const SHA256_FIXTURES: unknown[] = [
  "b".repeat(64), // accepted, already canonical
  "B".repeat(64), // accepted, canonicalized to lowercase
  "b".repeat(63), // too short
  "b".repeat(65), // too long
  "z".repeat(64), // not hex
  "",
  42,
  null,
  { length: 64 },
];

const MTIME_FIXTURES: unknown[] = [
  0,
  1.25, // fractional mtimes are valid
  OFFLINE_SYNC_MAX_MTIME_MS,
  OFFLINE_SYNC_MAX_MTIME_MS + 1,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "100",
  null,
];

test("sha256 census fixtures accept and canonicalize identically on both surfaces", () => {
  const offline = SHA256_FIXTURES.map((sha256) => offlineSyncOutcome({ sha256 }));
  const reconcile = SHA256_FIXTURES.map((sha256) => reconcileOutcome({ sha256 }));
  assert.deepEqual(reconcile, offline);
  assert.deepEqual(
    offline.map((o) => o.accepted),
    [true, true, false, false, false, false, false, false, false]
  );
  assert.equal(offline[1].digest, "b".repeat(64));
});

test("mtimeMs census fixtures accept and reject identically on both surfaces", () => {
  const offline = MTIME_FIXTURES.map((mtimeMs) => offlineSyncOutcome({ mtimeMs }));
  const reconcile = MTIME_FIXTURES.map((mtimeMs) => reconcileOutcome({ mtimeMs }));
  assert.deepEqual(reconcile, offline);
  assert.deepEqual(
    offline.map((o) => o.accepted),
    [true, true, true, false, false, false, false, false, false]
  );
});

test("compareReconcilePlanEntries is the total order plan output itself uses", () => {
  const entry = (namespace: string, path: string): ReconcilePlanEntry => ({
    path,
    namespace,
    action: "identical",
    reason: "same_content",
  });
  const a = entry("alpha", "facts/a.md");
  const b = entry("beta", "facts/a.md");
  const c = entry("beta", "facts/b.md");
  const sorted = [c, { ...a }, b, a].sort(compareReconcilePlanEntries);
  assert.deepEqual(
    sorted.map((e) => [e.namespace, e.path]),
    [
      ["alpha", "facts/a.md"],
      ["alpha", "facts/a.md"],
      ["beta", "facts/a.md"],
      ["beta", "facts/b.md"],
    ]
  );
  assert.equal(compareReconcilePlanEntries(a, { ...a }), 0);

  const plan = planReconciliation([
    { namespace: "beta", local: [], peer: [] },
    { namespace: "alpha", local: [{ path: "facts/z.md", sha256: GOOD_SHA }], peer: [] },
  ]);
  assert.ok(plan.entries.length > 0);
  for (let i = 1; i < plan.entries.length; i += 1) {
    assert.ok(compareReconcilePlanEntries(plan.entries[i - 1], plan.entries[i]) <= 0);
  }
});

test("semanticAgreementKey pins the ordered path-pair identity shared by cursor and manifest", () => {
  const localFirst = semanticAgreementKey({
    local: { path: "facts/local.md", sha256: GOOD_SHA },
    peer: { path: "facts/peer.md", sha256: GOOD_SHA },
  });
  assert.equal(localFirst, "facts/local.md\0facts/peer.md");
  assert.notEqual(
    localFirst,
    semanticAgreementKey({
      local: { path: "facts/peer.md", sha256: GOOD_SHA },
      peer: { path: "facts/local.md", sha256: GOOD_SHA },
    })
  );
});
