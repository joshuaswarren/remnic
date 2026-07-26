import assert from "node:assert/strict";
import test from "node:test";

import {
  planNamespaceReconciliation,
  planReconciliation,
  summarizeReconcilePlan,
  type ReconcileFileState,
  type ReconcilePlanEntry,
} from "./plan.js";

function file(path: string, sha256: string, mtimeMs?: number): ReconcileFileState {
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

test("manual is the default policy: a both-modified path is reported, never auto-picked", () => {
  const entries = planNamespaceReconciliation({
    namespace: "default",
    local: [file("facts/a.md", "local", 2000)],
    peer: [file("facts/a.md", "peer", 1000)],
  });
  const conflict = entryFor(entries, "facts/a.md");
  assert.equal(conflict.action, "conflict");
  assert.equal(conflict.reason, "both_modified");
  assert.equal(conflict.resolution, "unresolved", "equally authoritative sides must not be settled by default");
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

test("keep-both never designates a loser", () => {
  const entries = planNamespaceReconciliation(
    {
      namespace: "default",
      local: [file("facts/a.md", "local", 2000)],
      peer: [file("facts/a.md", "peer", 1000)],
    },
    { conflictPolicy: "keep-both" },
  );
  assert.equal(entryFor(entries, "facts/a.md").resolution, "supersede-link");
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
    tombstonedFileSha256: ["retracted-hash"],
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
      tombstonedFileSha256: ["retracted-hash"],
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
  assert.equal(a.localSha256, "local-hash");
  assert.equal(a.peerSha256, "peer-hash");
  assert.equal(a.baseSha256, "base-hash");
  const b = entryFor(entries, "facts/b.md");
  assert.equal(b.peerSha256, "peer-b");
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
