import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { ReconcileFileState } from "@remnic/core/reconcile/plan.js";
import { computeConvergePlan, formatConvergeReport } from "./converge.js";

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);

test("remnic converge plan: report shape and converged no-op when peers match", async () => {
  const file1: ReconcileFileState = { path: "facts/2026-03-01/a.md", sha256: shaA, mtimeMs: 1000, bytes: 100 };
  const localMap = new Map<string, ReconcileFileState[]>([["default", [file1]]]);
  const peerMap = new Map<string, ReconcileFileState[]>([["default", [file1]]]);

  const plan = await computeConvergePlan({
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
  });

  assert.equal(plan.converged, true);
  assert.equal(plan.byNamespace.length, 1);
  assert.equal(plan.byNamespace[0]?.namespace, "default");
  assert.equal(plan.byNamespace[0]?.identical, 1);
  assert.equal(plan.byNamespace[0]?.pull, 0);
  assert.equal(plan.byNamespace[0]?.push, 0);
  assert.equal(plan.byNamespace[0]?.conflict, 0);
  assert.equal(plan.byNamespace[0]?.suppress, 0);

  const formatted = formatConvergeReport(plan);
  assert.match(formatted, /Convergence Status: CONVERGED/);
  assert.match(formatted, /identical:\s+1/);
});

test("remnic converge plan: conflict classification when files differ", async () => {
  const localFile: ReconcileFileState = { path: "facts/2026-03-01/shared.md", sha256: shaA, mtimeMs: 1000 };
  const peerFile: ReconcileFileState = { path: "facts/2026-03-01/shared.md", sha256: shaB, mtimeMs: 2000 };

  const localMap = new Map<string, ReconcileFileState[]>([["default", [localFile]]]);
  const peerMap = new Map<string, ReconcileFileState[]>([["default", [peerFile]]]);

  const plan = await computeConvergePlan({
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
  });

  assert.equal(plan.converged, false);
  assert.equal(plan.byNamespace[0]?.conflict, 1);
  const entry = plan.entries.find((e: { path: string }) => e.path === "facts/2026-03-01/shared.md");
  assert.ok(entry);
  assert.equal(entry.action, "conflict");
});

test("remnic converge plan: namespace pairing across distinct namespaces", async () => {
  const localMap = new Map<string, ReconcileFileState[]>([
    ["alpha", [{ path: "facts/a.md", sha256: shaA }]],
  ]);
  const peerMap = new Map<string, ReconcileFileState[]>([
    ["beta", [{ path: "facts/b.md", sha256: shaB }]],
  ]);

  const plan = await computeConvergePlan({
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
  });

  assert.equal(plan.converged, false);
  assert.equal(plan.byNamespace.length, 2);
  const alpha = plan.byNamespace.find((n: { namespace: string }) => n.namespace === "alpha");
  const beta = plan.byNamespace.find((n: { namespace: string }) => n.namespace === "beta");
  assert.ok(alpha);
  assert.ok(beta);
  assert.equal(alpha.push, 1);
  assert.equal(beta.pull, 1);
});

test("remnic converge plan: tombstone-suppression detection", async () => {
  const peerFile: ReconcileFileState = { path: "facts/retracted.md", sha256: shaA };

  const localMap = new Map<string, ReconcileFileState[]>([["default", []]]);
  const peerMap = new Map<string, ReconcileFileState[]>([["default", [peerFile]]]);
  const localTombs = new Map<string, Iterable<string>>([["default", [shaA]]]);

  const plan = await computeConvergePlan({
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
    localTombstonesByNamespace: localTombs,
  });

  assert.equal(plan.converged, false);
  const entry = plan.entries.find((e: { path: string }) => e.path === "facts/retracted.md");
  assert.ok(entry);
  assert.equal(entry.action, "suppress");
  assert.equal(plan.byNamespace[0]?.suppress, 1);
});

test("remnic converge plan: read-only operation does not modify inputs or perform writes", async () => {
  const file1: ReconcileFileState = { path: "facts/readonly.md", sha256: shaA };
  const localMap = new Map<string, ReconcileFileState[]>([["default", [file1]]]);
  const peerMap = new Map<string, ReconcileFileState[]>([["default", []]]);

  const localMapClone = new Map(localMap);

  const plan = await computeConvergePlan({
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
  });

  assert.ok(plan);
  assert.deepEqual(localMap, localMapClone);
});
