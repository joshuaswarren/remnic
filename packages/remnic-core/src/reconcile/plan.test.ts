import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ReconcilePlanInputError,
  planNamespaceReconciliation,
  planReconciliation,
  summarizeReconcilePlan,
  type ReconcileFileState,
  type ReconcilePlanEntry,
} from "./plan.js";

/** Readable labels stay in the tests; the planner sees real sha256 hex. */
function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function file(path: string, label: string, mtimeMs?: number): ReconcileFileState {
  const sha256 = digest(label);
  return mtimeMs === undefined ? { path, sha256 } : { path, sha256, mtimeMs };
}

function entryFor(entries: readonly ReconcilePlanEntry[], path: string): ReconcilePlanEntry {
  const found = entries.find((e) => e.path === path);
  assert.ok(found, `no plan entry for ${path}`);
  return found;
}

test("converged corpora produce no work and report converged", () => {
  const files = [file("facts/2026-03-01/a.md", "aaa"), file("facts/2026-03-01/b.md", "bbb")];
  const plan = planReconciliation([{ namespace: "default", local: files, peer: files }]);
  assert.equal(plan.converged, true);
  assert.deepEqual(
    plan.entries.map((e) => e.action),
    ["identical", "identical"],
  );
  assert.deepEqual(plan.byNamespace, [
    { namespace: "default", pull: 0, push: 0, identical: 2, conflict: 0, suppress: 0, unresolved: 0 },
  ]);
});

test("a bootstrap merge moves unique data both ways and deletes nothing", () => {
  // The #2150 shape: no common base, both sides hold months the other never saw.
  const plan = planReconciliation([
    {
      namespace: "default",
      local: [file("facts/2026-01-01/local-only.md", "l1"), file("facts/2026-05-01/shared.md", "s1")],
      peer: [file("facts/2026-04-01/peer-only.md", "p1"), file("facts/2026-05-01/shared.md", "s1")],
    },
  ]);
  assert.equal(plan.converged, false);
  assert.equal(entryFor(plan.entries, "facts/2026-01-01/local-only.md").action, "push");
  assert.equal(entryFor(plan.entries, "facts/2026-04-01/peer-only.md").action, "pull");
  assert.equal(entryFor(plan.entries, "facts/2026-05-01/shared.md").action, "identical");
  assert.equal(
    plan.entries.filter((e) => e.action === "conflict").length,
    0,
    "absent on one side without a base means never seen, not deleted",
  );
});

test("newest-wins is the default policy", () => {
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/a.md", "local", 2000)],
    peer: [file("facts/a.md", "peer", 1000)],
  });
  const conflict = entryFor(entries, "facts/a.md");
  assert.equal(conflict.action, "conflict");
  assert.equal(conflict.reason, "both_modified");
  assert.equal(conflict.resolution, "local-wins");
});

test("newest-wins picks the later side by mtime", () => {
  const entries = planNamespaceReconciliation(
    {
      namespace: "default",
      local: [file("facts/a.md", "local", 2000), file("facts/b.md", "local", 1000)],
      peer: [file("facts/a.md", "peer", 1000), file("facts/b.md", "peer", 2000)],
    },
    { conflictPolicy: "newest-wins" },
  );
  assert.equal(entryFor(entries, "facts/a.md").resolution, "local-wins");
  assert.equal(entryFor(entries, "facts/b.md").resolution, "peer-wins");
});

test("newest-wins degrades to keeping both when the order is not decidable", () => {
  // No timestamp on one side, and an exact tie. Either way "newest" is a coin
  // flip, and a coin flip here discards a fact the other corpus may be alone in
  // holding — the whole failure #2150 exists to prevent.
  const entries = planNamespaceReconciliation(
    {
      namespace: "default",
      local: [file("facts/untimed.md", "local"), file("facts/tied.md", "local", 5000)],
      peer: [file("facts/untimed.md", "peer", 1000), file("facts/tied.md", "peer", 5000)],
    },
    { conflictPolicy: "newest-wins" },
  );
  assert.equal(entryFor(entries, "facts/untimed.md").resolution, "supersede-link");
  assert.equal(entryFor(entries, "facts/tied.md").resolution, "supersede-link");
});


test("a base turns a one-sided change back into an ordinary transfer", () => {
  const base = [file("facts/a.md", "v1"), file("facts/b.md", "v1")];
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/a.md", "v1"), file("facts/b.md", "v2-local")],
    peer: [file("facts/a.md", "v2-peer"), file("facts/b.md", "v1")],
    base,
  });
  // Only the peer moved on a.md, only we moved on b.md — neither is a conflict.
  assert.equal(entryFor(entries, "facts/a.md").action, "pull");
  assert.equal(entryFor(entries, "facts/b.md").action, "push");
  // Both censuses still hold the path, so these are NOT the bootstrap
  // "one side has never seen it" reasons.
  assert.equal(entryFor(entries, "facts/a.md").reason, "peer_changed");
  assert.equal(entryFor(entries, "facts/b.md").reason, "local_changed");
  assert.equal(entries.filter((e) => e.action === "conflict").length, 0);
});

test("a base proves a deletion, and a deletion against a live edit needs an operator", () => {
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/kept.md", "v1")],
    peer: [file("facts/dropped.md", "v1")],
    base: [file("facts/kept.md", "v1"), file("facts/dropped.md", "v1")],
  });
  // The peer no longer has kept.md and the base says it had exactly our copy:
  // that is a real deletion, not a gap. Re-pushing would resurrect it.
  const kept = entryFor(entries, "facts/kept.md");
  assert.equal(kept.action, "conflict");
  assert.equal(kept.reason, "peer_deleted");
  assert.equal(kept.resolution, "unresolved");
  const dropped = entryFor(entries, "facts/dropped.md");
  assert.equal(dropped.action, "conflict");
  assert.equal(dropped.reason, "local_deleted");
  assert.equal(dropped.resolution, "unresolved");
});

test("a locally tombstoned fact is suppressed on the peer, not pulled back", () => {
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [],
    peer: [file("facts/retracted.md", "retracted-hash"), file("facts/fresh.md", "fresh-hash")],
    tombstonedFileSha256: [digest("retracted-hash")],
  });
  const retracted = entryFor(entries, "facts/retracted.md");
  assert.equal(retracted.action, "suppress", "a retraction must survive every future reconcile");
  assert.equal(retracted.reason, "tombstoned");
  assert.equal(entryFor(entries, "facts/fresh.md").action, "pull");
});

test("a peer still serving a retracted fact is NOT converged", () => {
  // Marking it `identical` would let transport skip the whole run on
  // plan.converged, so the peer would keep serving the retracted fact forever.
  const plan = planReconciliation([
    {
      namespace: "default",
      local: [],
      peer: [file("facts/retracted.md", "retracted-hash")],
      tombstonedFileSha256: [digest("retracted-hash")],
    },
  ]);
  assert.equal(plan.converged, false, "propagating the retraction is work, not agreement");
  assert.deepEqual(plan.byNamespace, [
    { namespace: "default", pull: 0, push: 0, identical: 0, conflict: 0, suppress: 1, unresolved: 0 },
  ]);
});

test("delete-versus-modify stays a conflict in both directions", () => {
  // The surviving side edited since the base, so its hash no longer equals the
  // base. Keying on equality would emit a plain push/pull and silently
  // resurrect a deliberate deletion.
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/we-edited.md", "local-v2")],
    peer: [file("facts/peer-edited.md", "peer-v2")],
    base: [file("facts/we-edited.md", "v1"), file("facts/peer-edited.md", "v1")],
  });
  const weEdited = entryFor(entries, "facts/we-edited.md");
  assert.equal(weEdited.action, "conflict");
  assert.equal(weEdited.reason, "local_modified_peer_deleted");
  assert.equal(weEdited.resolution, "unresolved");
  const peerEdited = entryFor(entries, "facts/peer-edited.md");
  assert.equal(peerEdited.action, "conflict");
  assert.equal(peerEdited.reason, "local_deleted_peer_modified");
  assert.equal(peerEdited.resolution, "unresolved");
});

test("newest-wins compares delete revision times with surviving modifications", () => {
  const entries = planNamespaceReconciliation(
    {
      namespace: "default",
      local: [
        file("facts/local-modification-wins.md", "local-v2", 4000),
        file("facts/peer-deletion-wins.md", "local-v2", 2000),
      ],
      peer: [
        file("facts/peer-modification-wins.md", "peer-v2", 4000),
        file("facts/local-deletion-wins.md", "peer-v2", 2000),
      ],
      base: [
        file("facts/local-modification-wins.md", "v1"),
        file("facts/peer-deletion-wins.md", "v1"),
        file("facts/peer-modification-wins.md", "v1"),
        file("facts/local-deletion-wins.md", "v1"),
      ],
      localDeletionMtimeMs: new Map([
        ["facts/peer-modification-wins.md", 3000],
        ["facts/local-deletion-wins.md", 3000],
      ]),
      peerDeletionMtimeMs: new Map([
        ["facts/local-modification-wins.md", 3000],
        ["facts/peer-deletion-wins.md", 3000],
      ]),
    },
    { conflictPolicy: "newest-wins" },
  );
  assert.equal(entryFor(entries, "facts/local-modification-wins.md").resolution, "local-wins");
  assert.equal(entryFor(entries, "facts/peer-deletion-wins.md").resolution, "peer-wins");
  assert.equal(entryFor(entries, "facts/peer-modification-wins.md").resolution, "peer-wins");
  assert.equal(entryFor(entries, "facts/local-deletion-wins.md").resolution, "local-wins");
});

test("namespaces are planned independently and reported separately", () => {
  const plan = planReconciliation([
    { namespace: "alpha", local: [file("facts/a.md", "x")], peer: [] },
    { namespace: "beta", local: [], peer: [file("facts/a.md", "y")] },
  ]);
  // Same path in two namespaces must not collapse into one decision.
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries.filter((e) => e.namespace === "alpha")[0]?.action, "push");
  assert.equal(plan.entries.filter((e) => e.namespace === "beta")[0]?.action, "pull");
  assert.deepEqual(plan.byNamespace.map((r) => r.namespace), ["alpha", "beta"]);
});

test("the plan is byte-stable across runs regardless of input order", () => {
  const local = [file("facts/c.md", "1"), file("facts/a.md", "2"), file("facts/b.md", "3")];
  const peer = [file("facts/b.md", "3"), file("facts/z.md", "9")];
  const first = planReconciliation([
    { namespace: "beta", local, peer },
    { namespace: "alpha", local, peer },
  ]);
  const second = planReconciliation([
    { namespace: "alpha", local: [...local].reverse(), peer: [...peer].reverse() },
    { namespace: "beta", local: [...local].reverse(), peer: [...peer].reverse() },
  ]);
  // A convergence report an operator diffs between runs is only useful if the
  // ordering is total (§12) — no incidental readdir order may leak in.
  assert.deepEqual(first.entries, second.entries);
  assert.deepEqual(
    first.entries.map((e) => `${e.namespace}:${e.path}`),
    ["alpha:facts/a.md", "alpha:facts/b.md", "alpha:facts/c.md", "alpha:facts/z.md",
      "beta:facts/a.md", "beta:facts/b.md", "beta:facts/c.md", "beta:facts/z.md"],
  );
});

test("the report counts every action and isolates the unresolved ones", () => {
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/push.md", "l"), file("facts/same.md", "s"), file("facts/clash.md", "l")],
    peer: [file("facts/pull.md", "p"), file("facts/same.md", "s"), file("facts/clash.md", "p")],
  });
  assert.deepEqual(summarizeReconcilePlan(entries), [
    { namespace: "default", pull: 1, push: 1, identical: 1, conflict: 1, suppress: 0, unresolved: 1 },
  ]);
});

test("planning an empty pair is converged, not a crash", () => {
  const plan = planReconciliation([{ namespace: "default", local: [], peer: [] }]);
  assert.equal(plan.converged, true);
  assert.deepEqual(plan.entries, []);
  assert.deepEqual(plan.byNamespace, []);
});

test("entries carry the hashes a transport needs to verify what it moved", () => {
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/a.md", "local-hash")],
    peer: [file("facts/a.md", "peer-hash"), file("facts/b.md", "peer-b")],
    base: [file("facts/a.md", "base-hash")],
  });
  const a = entryFor(entries, "facts/a.md");
  assert.equal(a.localSha256, digest("local-hash"));
  assert.equal(a.peerSha256, digest("peer-hash"));
  assert.equal(a.baseSha256, digest("base-hash"));
  const b = entryFor(entries, "facts/b.md");
  assert.equal(b.peerSha256, digest("peer-b"));
  assert.equal(b.localSha256, undefined);
});

test("a duplicate path in the streamed local census does not double-count", () => {
  // The local side is consumed as a stream, so a repeated path must not emit
  // two entries or reappear as peer-only after the index entry was consumed.
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/a.md", "same"), file("facts/a.md", "same")],
    peer: [file("facts/a.md", "same")],
  });
  assert.equal(entries.filter((e) => e.path === "facts/a.md").length, 1);
  assert.equal(entries[0]?.action, "identical");
});

test("streaming the local side still reports every peer-only path exactly once", () => {
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/shared.md", "s")],
    peer: [file("facts/shared.md", "s"), file("facts/p1.md", "1"), file("facts/p2.md", "2")],
  });
  assert.deepEqual(
    entries.filter((e) => e.action === "pull").map((e) => e.path),
    ["facts/p1.md", "facts/p2.md"],
  );
});

test("a retracted digest present on BOTH sides is suppressed, not called identical", () => {
  // Same path, same digest, retracted here. Calling it identical converges the
  // plan and the peer keeps serving the retracted fact.
  const plan = planReconciliation([
    {
      namespace: "default",
      local: [file("facts/retracted.md", "gone")],
      peer: [file("facts/retracted.md", "gone")],
      tombstonedFileSha256: [digest("gone")],
    },
  ]);
  assert.equal(plan.entries[0]?.action, "suppress");
  assert.equal(plan.converged, false);
});

test("a retracted peer revision cannot win a conflict", () => {
  // Same path, different content, peer's copy is the retracted one and is
  // NEWER. Reaching the conflict ladder at all would let newest-wins resurrect
  // precisely what was retracted.
  const entries = planNamespaceReconciliation(
    {
      namespace: "default",
      local: [file("facts/a.md", "live", 1000)],
      peer: [file("facts/a.md", "retracted", 9000)],
      tombstonedFileSha256: [digest("retracted")],
    },
    { conflictPolicy: "newest-wins" },
  );
  const entry = entryFor(entries, "facts/a.md");
  assert.equal(entry.action, "suppress");
  assert.equal(entry.resolution, undefined, "a retraction is not a conflict to be won");
});

test("a malformed census record fails the plan instead of vanishing from it", () => {
  for (const side of ["local", "peer"] as const) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: side === "local" ? [{ path: "", sha256: digest("x") }] : [],
          peer: side === "peer" ? [{ path: "", sha256: digest("x") }] : [],
        }),
      ReconcilePlanInputError,
      `${side} census with an empty path must reject`,
    );
  }
});

test("a path listed twice with different digests is rejected on every census", () => {
  const dupe = [file("facts/a.md", "one"), file("facts/a.md", "two")];
  for (const side of ["local", "peer", "base"] as const) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: side === "local" ? dupe : [],
          peer: side === "peer" ? dupe : [],
          base: side === "base" ? dupe : undefined,
        }),
      /lists facts\/a\.md twice with different digests/,
      `${side} census must not silently pick a winner by arrival order`,
    );
  }
  // An exact repeat is unambiguous and stays acceptable.
  assert.doesNotThrow(() =>
    planNamespaceReconciliation({
      namespace: "default",
      local: [file("facts/a.md", "one"), file("facts/a.md", "one")],
      peer: [],
    }),
  );
});

test("an unknown conflictPolicy is rejected rather than silently treated as manual", () => {
  assert.throws(
    () =>
      planNamespaceReconciliation(
        { namespace: "default", local: [file("facts/a.md", "l")], peer: [file("facts/a.md", "p")] },
        // Deserialized config or an untyped JS caller can produce this.
        { conflictPolicy: "newest_wins" as unknown as "newest-wins" },
      ),
    ReconcilePlanInputError,
  );
});

test("a retracted LOCAL revision is suppressed, never pushed", () => {
  // Without this the suppression undoes itself: transport drops the peer copy,
  // and the next run pushes our surviving retracted copy straight back.
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/retracted.md", "gone")],
    peer: [],
    tombstonedFileSha256: [digest("gone")],
  });
  const entry = entryFor(entries, "facts/retracted.md");
  assert.equal(entry.action, "suppress");
  assert.equal(entry.peerSha256, undefined);
});

test("a retracted local revision does not win a conflict either", () => {
  const entries = planNamespaceReconciliation(
    {
      namespace: "default",
      local: [file("facts/a.md", "retracted", 9000)],
      peer: [file("facts/a.md", "live", 1000)],
      tombstonedFileSha256: [digest("retracted")],
    },
    { conflictPolicy: "newest-wins" },
  );
  assert.equal(entryFor(entries, "facts/a.md").action, "suppress");
});

test("a census record without a usable digest is rejected", () => {
  // Two records that both omit sha256 compare equal and would plan `identical`,
  // converging a corpus that was never actually read.
  for (const bad of [undefined, "", "not-a-digest", 42] as const) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: [{ path: "facts/a.md", sha256: bad as unknown as string }],
          peer: [],
        }),
      /64-character sha256 hex digest/,
      `digest ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("paths differing only by case are rejected across censuses", () => {
  // One file on a case-insensitive peer; planning a push AND a pull would let
  // application order pick the survivor.
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [file("Facts/A.md", "one")],
        peer: [file("facts/a.md", "two")],
      }),
    /aliasing paths/,
  );
});

test("a missing namespace or a non-iterable census is rejected", () => {
  assert.throws(
    () => planNamespaceReconciliation({ namespace: "", local: [], peer: [] }),
    ReconcilePlanInputError,
  );
  for (const side of ["local", "peer"] as const) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: side === "local" ? (undefined as unknown as ReconcileFileState[]) : [],
          peer: side === "peer" ? (undefined as unknown as ReconcileFileState[]) : [],
        }),
      /must be iterable/,
      `${side} census`,
    );
  }
});

test("digest casing is canonicalized, not compared verbatim", () => {
  const upper = digest("same").toUpperCase();
  const plan = planReconciliation([
    {
      namespace: "default",
      local: [{ path: "facts/a.md", sha256: upper }],
      peer: [file("facts/a.md", "same")],
    },
  ]);
  assert.equal(plan.entries[0]?.action, "identical", "one digest in two spellings is one digest");
  assert.equal(plan.entries[0]?.localSha256, digest("same"));
  assert.equal(plan.converged, true);
});

test("tombstone membership survives digest casing", () => {
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [],
    peer: [file("facts/r.md", "gone")],
    tombstonedFileSha256: [digest("gone").toUpperCase()],
  });
  assert.equal(entryFor(entries, "facts/r.md").action, "suppress");
});

test("suppress names the side holding the retracted revision", () => {
  const cases = [
    { tomb: "local-rev", expect: "local" },
    { tomb: "peer-rev", expect: "peer" },
  ] as const;
  for (const { tomb, expect } of cases) {
    const entries = planNamespaceReconciliation({
      namespace: "default",
      local: [file("facts/a.md", "local-rev")],
      peer: [file("facts/a.md", "peer-rev")],
      tombstonedFileSha256: [digest(tomb)],
    });
    // Without this, transport cannot tell which copy to remove and may delete
    // the live revision instead of the retracted one.
    assert.equal(entryFor(entries, "facts/a.md").suppressSide, expect);
  }
  const both = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/a.md", "gone")],
    peer: [file("facts/a.md", "gone")],
    tombstonedFileSha256: [digest("gone")],
  });
  assert.equal(entryFor(both, "facts/a.md").suppressSide, "both");
});

test("a single digest string is rejected instead of being split into characters", () => {
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [],
        peer: [file("facts/r.md", "gone")],
        // Satisfies Iterable<string>; new Set() would make 64 one-char members.
        tombstonedFileSha256: digest("gone") as unknown as string[],
      }),
    /must be a collection of digests, not a single string/,
  );
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [],
        peer: [file("facts/r.md", "gone")],
        tombstonedFileSha256: ["not-a-digest"],
      }),
    /64-character sha256 hex digest/,
  );
});

test("an unsafe census path is rejected before it becomes transfer work", () => {
  for (const bad of ["/outside.md", "../outside.md", "facts\\win.md"]) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: [],
          peer: [{ path: bad, sha256: digest("x") }],
        }),
      ReconcilePlanInputError,
      `peer census path ${bad} must be rejected`,
    );
  }
});

test("a duplicate record disagreeing only on mtime is rejected", () => {
  // newest-wins reads that timestamp, so first-arrival-wins would let input
  // order pick the winner.
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [],
        peer: [file("facts/a.md", "same", 1000), file("facts/a.md", "same", 2000)],
      }),
    /lists facts\/a\.md twice with different mtimeMs/,
  );
});

test("the base census participates in case-collision detection", () => {
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [file("facts/a.md", "one")],
        peer: [],
        base: [file("Facts/A.md", "one")],
      }),
    /aliasing paths/,
  );
});

test("the streamed local census rejects an mtime-only duplicate like the indexed ones", () => {
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [file("facts/a.md", "same", 1000), file("facts/a.md", "same", 2000)],
        peer: [],
      }),
    /local census for namespace default lists facts\/a\.md twice with different mtimeMs/,
  );
});

test("newest-wins cannot be flipped by local census ordering", () => {
  // The duplicate is rejected outright, so neither arrival order can supply
  // the timestamp that decides the winner.
  for (const order of [
    [file("facts/a.md", "local", 1000), file("facts/a.md", "local", 9000)],
    [file("facts/a.md", "local", 9000), file("facts/a.md", "local", 1000)],
  ]) {
    assert.throws(
      () =>
        planNamespaceReconciliation(
          { namespace: "default", local: order, peer: [file("facts/a.md", "peer", 5000)] },
          { conflictPolicy: "newest-wins" },
        ),
      ReconcilePlanInputError,
    );
  }
});

test("the same namespace supplied twice is rejected", () => {
  // Planned independently, one (namespace, path) could draw both push and pull,
  // and the two entries sort equal so batch order would pick the survivor.
  assert.throws(
    () =>
      planReconciliation([
        { namespace: "default", local: [file("facts/a.md", "one")], peer: [] },
        { namespace: "default", local: [], peer: [file("facts/a.md", "two")] },
      ]),
    /namespace default appears twice/,
  );
});

test("an out-of-range mtimeMs cannot decide newest-wins", () => {
  // 1.5 is deliberately absent: fs.stat reports fractional mtimes and
  // offline-sync forwards them unrounded, so they are valid input.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 8_640_000_000_000_001, "2000"]) {
    for (const side of ["local", "peer", "base"] as const) {
      const record = { path: "facts/a.md", sha256: digest("x"), mtimeMs: bad as unknown as number };
      assert.throws(
        () =>
          planNamespaceReconciliation({
            namespace: "default",
            local: side === "local" ? [record] : [],
            peer: side === "peer" ? [record] : [],
            base: side === "base" ? [record] : undefined,
          }),
        /out-of-range mtimeMs/,
        `${side} census mtimeMs ${String(bad)} must be rejected`,
      );
    }
  }
});

test("malformed public API envelopes raise ReconcilePlanInputError, not TypeError", () => {
  for (const bad of [undefined, null, "nope", 7]) {
    assert.throws(
      () => planReconciliation(bad as unknown as []),
      ReconcilePlanInputError,
      `planReconciliation(${JSON.stringify(bad)})`,
    );
    assert.throws(
      () => planNamespaceReconciliation(bad as unknown as { namespace: string; local: []; peer: [] }),
      ReconcilePlanInputError,
      `planNamespaceReconciliation(${JSON.stringify(bad)})`,
    );
  }
  assert.throws(
    () =>
      planNamespaceReconciliation(
        { namespace: "default", local: [], peer: [] },
        null as unknown as Record<string, never>,
      ),
    ReconcilePlanInputError,
  );
});

test("a fractional mtime from fs.stat is accepted", () => {
  // Node reports sub-millisecond mtimes on common filesystems; rejecting them
  // would fail every normally generated census before planning could start.
  const entries = planNamespaceReconciliation(
    {
      namespace: "default",
      local: [file("facts/a.md", "local", 1_700_000_000_123.456)],
      peer: [file("facts/a.md", "peer", 1_700_000_000_999.789)],
    },
    { conflictPolicy: "newest-wins" },
  );
  assert.equal(entryFor(entries, "facts/a.md").resolution, "peer-wins");
});

test("a non-canonical namespace is rejected so duplicates cannot slip past", () => {
  assert.throws(
    () => planNamespaceReconciliation({ namespace: " team ", local: [], peer: [] }),
    /is not canonical; pass "team"/,
  );
  // The dedup guard would otherwise see two distinct keys for one namespace.
  assert.throws(
    () =>
      planReconciliation([
        { namespace: "team", local: [file("facts/a.md", "one")], peer: [] },
        { namespace: " team ", local: [], peer: [file("facts/a.md", "two")] },
      ]),
    ReconcilePlanInputError,
  );
});

test("a null base cursor is rejected rather than read as a bootstrap", () => {
  // Silently bootstrapping would turn the peer's deletion into a push.
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [file("facts/a.md", "v1")],
        peer: [],
        base: null as unknown as undefined,
      }),
    /must be iterable/,
  );
});

test("canonically equivalent Unicode paths are treated as one file", () => {
  // macOS stores decomposed names and compares canonically, so these are the
  // same file there; planning a push AND a pull would race them.
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [file("facts/\u00e9.md", "one")],
        peer: [file("facts/e\u0301.md", "two")],
      }),
    /aliasing paths/,
  );
});

test("an array is not a valid options or input envelope", () => {
  assert.throws(
    () =>
      planNamespaceReconciliation(
        { namespace: "default", local: [], peer: [] },
        [] as unknown as Record<string, never>,
      ),
    /options must be a plain object/,
  );
  assert.throws(
    () => planNamespaceReconciliation([] as unknown as { namespace: string; local: []; peer: [] }),
    /namespace input must be a plain object/,
  );
});

test("a peer retraction suppresses our surviving copy instead of pushing it back", () => {
  // Bootstrap: the peer census simply OMITS what it retracted, so without its
  // tombstone set this is indistinguishable from "never had it" and we push
  // the file back, undoing the peer's retraction.
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/retracted-there.md", "gone"), file("facts/mine.md", "keep")],
    peer: [],
    peerTombstonedFileSha256: [digest("gone")],
  });
  const suppressed = entryFor(entries, "facts/retracted-there.md");
  assert.equal(suppressed.action, "suppress");
  assert.equal(suppressed.suppressSide, "local", "the copy to remove is ours");
  assert.equal(entryFor(entries, "facts/mine.md").action, "push", "unretracted files still push");
});

test("the peer tombstone set is validated like our own", () => {
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [],
        peer: [],
        peerTombstonedFileSha256: digest("x") as unknown as string[],
      }),
    /peerTombstonedFileSha256 for namespace default must be a collection of digests/,
  );
});

test("Win32-aliasing path segments are rejected", () => {
  // Windows strips trailing dots and spaces, so `a.md.` and `a.md` are one
  // file there while the fold key keeps them distinct.
  for (const bad of ["facts/a.md.", "facts/a.md ", "facts/dir./a.md"]) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: [{ path: bad, sha256: digest("x") }],
          peer: [],
        }),
      /dot or space/,
      `path ${JSON.stringify(bad)} must be rejected`,
    );
  }
});


test("an unorderable supersede link says so instead of picking a side", () => {
  for (const pair of [
    [file("facts/a.md", "local", 5000), file("facts/a.md", "peer", 5000)],
    [file("facts/a.md", "local"), file("facts/a.md", "peer", 5000)],
  ] as const) {
    const entries = planNamespaceReconciliation(
      { namespace: "default", local: [pair[0]], peer: [pair[1]] },
      { conflictPolicy: "newest-wins" },
    );
    const entry = entryFor(entries, "facts/a.md");
    assert.equal(entry.resolution, "supersede-link");
  }
});

test("Windows-unstorable and reserved path names are rejected", () => {
  for (const bad of ["facts/a:b.md", "facts/CON.md", "facts/com1.txt", 'facts/a"b.md', "facts/a\u0001b.md"]) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: [{ path: bad, sha256: digest("x") }],
          peer: [],
        }),
      ReconcilePlanInputError,
      `path ${JSON.stringify(bad)} must be rejected`,
    );
  }
  // A name that merely CONTAINS a reserved word is fine.
  assert.doesNotThrow(() =>
    planNamespaceReconciliation({
      namespace: "default",
      local: [file("facts/console.md", "x")],
      peer: [],
    }),
  );
});

test("a directionless supersede link is reported as unresolved", () => {
  // The policy nominally settled it, but with no orderable timestamp the link
  // direction is an operator call — reporting unresolved: 0 would hide that.
  const entries = planNamespaceReconciliation(
    {
      namespace: "default",
      local: [file("facts/a.md", "local", 5000)],
      peer: [file("facts/a.md", "peer", 5000)],
    },
    { conflictPolicy: "newest-wins" },
  );
  assert.deepEqual(summarizeReconcilePlan(entries), [
    { namespace: "default", pull: 0, push: 0, identical: 0, conflict: 1, suppress: 0, unresolved: 1 },
  ]);
});


test("superscript COM and LPT device aliases are rejected", () => {
  for (const bad of ["facts/COM\u00b9.txt", "facts/LPT\u00b2", "facts/com\u00b3.md"]) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: [{ path: bad, sha256: digest("x") }],
          peer: [],
        }),
      /reserved Windows device name/,
      `path ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("a full caseless fold catches sigma-style aliases", () => {
  // Unicode-case-insensitive filesystems treat final and medial sigma as one
  // name; a bare toLowerCase() keeps them distinct.
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [file("facts/\u03c2.md", "one")],
        peer: [file("facts/\u03c3.md", "two")],
      }),
    /aliasing paths/,
  );
});

test("non-plain objects are not accepted as envelopes", () => {
  // Each passes typeof === "object" and is not an array, exposes no
  // conflictPolicy, and would silently run under the default policy.
  for (const bad of [new Date(), new Map(), /re/]) {
    assert.throws(
      () =>
        planNamespaceReconciliation(
          { namespace: "default", local: [], peer: [] },
          bad as unknown as Record<string, never>,
        ),
      /options must be a plain object/,
      `options ${Object.prototype.toString.call(bad)}`,
    );
  }
  // A null-prototype record is still a record.
  assert.doesNotThrow(() =>
    planNamespaceReconciliation(
      { namespace: "default", local: [], peer: [] },
      Object.assign(Object.create(null), { conflictPolicy: "manual" }) as Record<string, never>,
    ),
  );
});

test("an empty namespace list still validates its options", () => {
  // The same call must not pass or fail depending on list length.
  for (const bad of [null, new Date(), { conflictPolicy: "nope" }]) {
    assert.throws(
      () => planReconciliation([], bad as unknown as Record<string, never>),
      ReconcilePlanInputError,
      `options ${Object.prototype.toString.call(bad)}`,
    );
  }
  assert.equal(planReconciliation([], { conflictPolicy: "manual" }).converged, true);
});

test("sharp-S aliases fold together", () => {
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [file("facts/stra\u00dfe.md", "one")],
        peer: [file("facts/stra\u1e9ee.md", "two")],
      }),
    /aliasing paths/,
  );
});

test("a malformed tombstone collection raises the planner's error, not a TypeError", () => {
  for (const bad of [null, 42, { a: 1 }]) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: [],
          peer: [],
          tombstonedFileSha256: bad as unknown as string[],
        }),
      ReconcilePlanInputError,
      `tombstonedFileSha256 ${JSON.stringify(bad)}`,
    );
  }
});

test("an unpaired surrogate path is rejected", () => {
  // Node encodes it as U+FFFD, so it and a literal U+FFFD path are one file on
  // disk while comparing as two.
  for (const bad of ["facts/\ud800.md", "facts/\udc00.md"]) {
    assert.throws(
      () =>
        planNamespaceReconciliation({
          namespace: "default",
          local: [{ path: bad, sha256: digest("x") }],
          peer: [],
        }),
      /unpaired surrogate/,
    );
  }
  // A well-formed pair is fine.
  assert.doesNotThrow(() =>
    planNamespaceReconciliation({
      namespace: "default",
      local: [file("facts/\ud83d\ude00.md", "x")],
      peer: [],
    }),
  );
});

test("the base cursor is validated with the same rules as the other censuses", () => {
  assert.throws(
    () =>
      planNamespaceReconciliation({
        namespace: "default",
        local: [],
        peer: [],
        base: [file("facts/a.md", "one"), file("facts/a.md", "two")],
      }),
    /base census for namespace default lists facts\/a\.md twice with different digests/,
  );
  // And it still drives the one-sided-change decision it exists for.
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/a.md", "v1")],
    peer: [file("facts/a.md", "v2")],
    base: [file("facts/a.md", "v1")],
  });
  assert.equal(entryFor(entries, "facts/a.md").action, "pull");
  assert.equal(entryFor(entries, "facts/a.md").baseSha256, digest("v1"));
});

test("a namespace with an unpaired surrogate is rejected", () => {
  // namespaceIdentityToken() encodes through TextEncoder, so this and a
  // literal U+FFFD namespace are one directory on disk.
  assert.throws(
    () => planNamespaceReconciliation({ namespace: "\ud800", local: [], peer: [] }),
    /unpaired surrogate/,
  );
});
