import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ReconcileFileState } from "@remnic/core/reconcile/plan.js";
import {
  defaultConvergeCursorPath,
  readConvergeCursor,
  writeConvergeCursor,
} from "@remnic/core/reconcile/cursor.js";
import {
  cmdConverge,
  computeConvergePlan,
  executeConvergeApply,
  formatConvergeApplyReport,
  formatConvergeReport,
} from "./converge.js";

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

test("remnic converge plan: hydrates durable cursor base files when present", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-cursor-test-"));
  try {
    const peerUrl = "http://localhost:4318";
    const cursorPath = defaultConvergeCursorPath(tmpDir, peerUrl, "default");
    await writeConvergeCursor(cursorPath, {
      version: 1,
      peerUrl,
      namespace: "default",
      baseFiles: [{ path: "facts/base.md", sha256: shaA }],
    });

    const localMap = new Map<string, ReconcileFileState[]>([["default", []]]);
    const peerMap = new Map<string, ReconcileFileState[]>([["default", [{ path: "facts/base.md", sha256: shaA }]]]);

    const plan = await computeConvergePlan({
      localFilesByNamespace: localMap,
      peerFilesByNamespace: peerMap,
      cursorDir: tmpDir,
      peerUrl,
    });

    assert.ok(plan);
    const entry = plan.entries.find((e) => e.path === "facts/base.md");
    assert.ok(entry);
    assert.equal(entry.baseSha256, shaA);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("remnic converge apply: converged state returns immediate no-op and updates cursor", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-apply-test-"));
  try {
    const file1: ReconcileFileState = { path: "facts/a.md", sha256: shaA };
    const localMap = new Map<string, ReconcileFileState[]>([["default", [file1]]]);
    const peerMap = new Map<string, ReconcileFileState[]>([["default", [file1]]]);

    const result = await executeConvergeApply({
      localFilesByNamespace: localMap,
      peerFilesByNamespace: peerMap,
      cursorDir: tmpDir,
      peerUrl: "http://localhost:4318",
    });

    assert.equal(result.converged, true);
    assert.equal(result.status, "converged");
    assert.equal(result.transfers.pulled, 0);
    assert.equal(result.transfers.pushed, 0);

    const cursorPath = defaultConvergeCursorPath(tmpDir, "http://localhost:4318", "default");
    const cursor = await readConvergeCursor(cursorPath);
    assert.ok(cursor);
    assert.equal(cursor.namespace, "default");
    assert.equal(cursor.baseFiles.length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("remnic converge apply: manual conflict policy stops mutation on unresolved conflicts", async () => {
  const localFile: ReconcileFileState = { path: "facts/shared.md", sha256: shaA, mtimeMs: 1000 };
  const peerFile: ReconcileFileState = { path: "facts/shared.md", sha256: shaB, mtimeMs: 2000 };

  const localMap = new Map<string, ReconcileFileState[]>([["default", [localFile]]]);
  const peerMap = new Map<string, ReconcileFileState[]>([["default", [peerFile]]]);

  const result = await executeConvergeApply({
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
    conflictPolicy: "manual",
  });

  assert.equal(result.converged, false);
  assert.equal(result.status, "stopped_unresolved_conflicts");
  assert.equal(result.transfers.pulled, 0);
  assert.equal(result.transfers.pushed, 0);
  assert.equal(result.transfers.conflictsResolved, 0);
});

test("remnic converge apply: dry-run mode simulates transfers without disk writes", async () => {
  const peerFile: ReconcileFileState = { path: "facts/remote.md", sha256: shaA };
  const localMap = new Map<string, ReconcileFileState[]>([["default", []]]);
  const peerMap = new Map<string, ReconcileFileState[]>([["default", [peerFile]]]);

  const result = await executeConvergeApply({
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
    dryRun: true,
  });

  assert.equal(result.converged, false);
  assert.equal(result.status, "dry_run");
  assert.equal(result.transfers.pulled, 1);
  assert.equal(result.cursorUpdated, false);
});

test("remnic converge apply: successful pull & push execution via buffer maps", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-apply-test-"));
  try {
    const localFile: ReconcileFileState = { path: "facts/local_only.md", sha256: shaA };
    const peerFile: ReconcileFileState = { path: "facts/peer_only.md", sha256: shaB };

    const localMap = new Map<string, ReconcileFileState[]>([["default", [localFile]]]);
    const peerMap = new Map<string, ReconcileFileState[]>([["default", [peerFile]]]);

    const localBufs = new Map<string, Map<string, Buffer>>([
      ["default", new Map([["facts/local_only.md", Buffer.from("local content")]])],
    ]);
    const peerBufs = new Map<string, Map<string, Buffer>>([
      ["default", new Map([["facts/peer_only.md", Buffer.from("peer content")]])],
    ]);

    const result = await executeConvergeApply({
      localFilesByNamespace: localMap,
      peerFilesByNamespace: peerMap,
      localFileBuffers: localBufs,
      peerFileBuffers: peerBufs,
      cursorDir: tmpDir,
      peerUrl: "http://localhost:4318",
    });

    assert.equal(result.status, "applied");
    assert.equal(result.transfers.pulled, 1);
    assert.equal(result.transfers.pushed, 1);
    assert.equal(result.transfers.failed, 0);

    // Verify local received pulled file and peer received pushed file
    assert.equal(localBufs.get("default")?.get("facts/peer_only.md")?.toString(), "peer content");
    assert.equal(peerBufs.get("default")?.get("facts/local_only.md")?.toString(), "local content");

    const formatted = formatConvergeApplyReport(result);
    assert.match(formatted, /Convergence Execution Status: APPLIED/);
    assert.match(formatted, /pulled:\s+1/);
    assert.match(formatted, /pushed:\s+1/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
