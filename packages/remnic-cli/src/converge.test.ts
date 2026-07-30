import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES, parseConfig } from "@remnic/core";
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

test("remnic converge plan: validates a namespace present only in provided base state", async () => {
  const baseMap = new Map<string, ReconcileFileState[]>([
    [
      "cursor-only",
      [
        { path: "Facts/a.md", sha256: shaA },
        { path: "facts/A.md", sha256: shaB },
      ],
    ],
  ]);

  await assert.rejects(
    computeConvergePlan({ baseFilesByNamespace: baseMap }),
    /aliasing paths/,
  );
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
    assert.equal(result.cursorUpdated, true);

    const cursorPath = defaultConvergeCursorPath(tmpDir, "http://localhost:4318", "default");
    const cursor = await readConvergeCursor(cursorPath);
    assert.ok(cursor);
    assert.equal(cursor.namespace, "default");
    assert.equal(cursor.baseFiles.length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("remnic converge apply: converged dry-run does not write cursor", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-apply-test-"));
  try {
    const file: ReconcileFileState = { path: "facts/a.md", sha256: shaA };
    const localMap = new Map<string, ReconcileFileState[]>([["default", [file]]]);
    const peerMap = new Map<string, ReconcileFileState[]>([["default", [file]]]);
    const peerUrl = "http://localhost:4318";
    const cursorPath = defaultConvergeCursorPath(tmpDir, peerUrl, "default");

    const result = await executeConvergeApply({
      localFilesByNamespace: localMap,
      peerFilesByNamespace: peerMap,
      cursorDir: tmpDir,
      peerUrl,
      dryRun: true,
    });

    assert.equal(result.status, "dry_run");
    assert.equal(result.cursorUpdated, false);
    assert.equal(await readConvergeCursor(cursorPath), null);
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

test("remnic converge apply: newest-wins stops when timestamps cannot resolve a conflict", async () => {
  const localMap = new Map<string, ReconcileFileState[]>([
    ["default", [{ path: "facts/shared.md", sha256: shaA, mtimeMs: 1000 }]],
  ]);
  const peerMap = new Map<string, ReconcileFileState[]>([
    ["default", [{ path: "facts/shared.md", sha256: shaB, mtimeMs: 1000 }]],
  ]);

  const result = await executeConvergeApply({
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
    conflictPolicy: "newest-wins",
  });

  assert.equal(result.converged, false);
  assert.equal(result.status, "stopped_unresolved_conflicts");
  assert.equal(result.cursorUpdated, false);
});

test("remnic converge apply: configured newest-wins compares deletion and modification times", async () => {
  const localModificationWins = "facts/local-modification-wins.md";
  const peerDeletionWins = "facts/peer-deletion-wins.md";
  const peerModificationWins = "facts/peer-modification-wins.md";
  const localDeletionWins = "facts/local-deletion-wins.md";
  const localModified = Buffer.from("local v2");
  const peerModified = Buffer.from("peer v2");
  const localSha = createHash("sha256").update(localModified).digest("hex");
  const peerSha = createHash("sha256").update(peerModified).digest("hex");
  const baseSha = "c".repeat(64);
  const localMap = new Map<string, ReconcileFileState[]>([
    ["default", [
      { path: localModificationWins, sha256: localSha, mtimeMs: 4000 },
      { path: peerDeletionWins, sha256: localSha, mtimeMs: 2000 },
    ]],
  ]);
  const peerMap = new Map<string, ReconcileFileState[]>([
    ["default", [
      { path: peerModificationWins, sha256: peerSha, mtimeMs: 4000 },
      { path: localDeletionWins, sha256: peerSha, mtimeMs: 2000 },
    ]],
  ]);
  const baseMap = new Map<string, ReconcileFileState[]>([
    ["default", [
      { path: localModificationWins, sha256: baseSha, mtimeMs: 1000 },
      { path: peerDeletionWins, sha256: baseSha, mtimeMs: 1000 },
      { path: peerModificationWins, sha256: baseSha, mtimeMs: 1000 },
      { path: localDeletionWins, sha256: baseSha, mtimeMs: 1000 },
    ]],
  ]);
  const localBuffers = new Map<string, Map<string, Buffer>>([
    ["default", new Map([
      [localModificationWins, localModified],
      [peerDeletionWins, localModified],
    ])],
  ]);
  const peerBuffers = new Map<string, Map<string, Buffer>>([
    ["default", new Map([
      [peerModificationWins, peerModified],
      [localDeletionWins, peerModified],
    ])],
  ]);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-delete-"));

  const result = await executeConvergeApply({
    config: parseConfig({ converge: { conflictPolicy: "newest-wins" } }),
    baseFilesByNamespace: baseMap,
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
    localDeletionMtimeMsByNamespace: new Map([["default", new Map([
      [peerModificationWins, 3000],
      [localDeletionWins, 3000],
    ])]]),
    peerDeletionMtimeMsByNamespace: new Map([["default", new Map([
      [localModificationWins, 3000],
      [peerDeletionWins, 3000],
    ])]]),
    localFileBuffers: localBuffers,
    peerFileBuffers: peerBuffers,
    cursorDir: tmpDir,
    peerUrl: "buffer://peer",
  });

  assert.equal(result.status, "applied");
  assert.equal(result.transfers.conflictsResolved, 4);
  assert.equal(result.transfers.failed, 0);
  assert.equal(peerBuffers.get("default")?.get(localModificationWins), localModified);
  assert.equal(localBuffers.get("default")?.has(peerDeletionWins), false);
  assert.equal(localBuffers.get("default")?.get(peerModificationWins), peerModified);
  assert.equal(peerBuffers.get("default")?.has(localDeletionWins), false);
  const cursor = await readConvergeCursor(defaultConvergeCursorPath(tmpDir, "buffer://peer", "default"));
  assert.deepEqual(
    cursor?.baseFiles.map((file) => file.path).sort(),
    [localModificationWins, peerModificationWins].sort(),
  );
  await fs.rm(tmpDir, { recursive: true, force: true });
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

test("remnic converge apply: uses chunked offline-sync HTTP contracts for pull and push", async () => {
  const peerContent = Buffer.from("peer content");
  const localContent = Buffer.from("local content");
  const peerSha = createHash("sha256").update(peerContent).digest("hex");
  const localSha = createHash("sha256").update(localContent).digest("hex");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/remnic/v1/offline-sync/file-content")) {
      return new Response(peerContent, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "x-remnic-file-path": encodeURIComponent("facts/peer.md"),
          "x-remnic-file-sha256": peerSha,
          "x-remnic-file-bytes": String(peerContent.length),
          "x-remnic-file-mtime-ms": "2000",
          "x-remnic-chunk-offset": "0",
          "x-remnic-chunk-bytes": String(peerContent.length),
        },
      });
    }
    if (url.includes("/remnic/v1/offline-sync/apply-file-content?namespace=default")) {
      return Response.json({ done: true, applied: true, skipped: false });
    }
    return new Response(null, { status: 404 });
  };
  const localBuffers = new Map<string, Map<string, Buffer>>([
    ["default", new Map([["facts/local.md", localContent]])],
  ]);

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    localFilesByNamespace: new Map([
      ["default", [{ path: "facts/local.md", sha256: localSha, bytes: localContent.length, mtimeMs: 1000 }]],
    ]),
    peerFilesByNamespace: new Map([
      ["default", [{ path: "facts/peer.md", sha256: peerSha, bytes: peerContent.length, mtimeMs: 2000 }]],
    ]),
    localFileBuffers: localBuffers,
  });

  assert.equal(result.transfers.pulled, 1);
  assert.equal(result.transfers.pushed, 1);
  assert.equal(localBuffers.get("default")?.get("facts/peer.md")?.toString(), "peer content");
  const pullRequest = requests.find((request) => request.url.endsWith("/remnic/v1/offline-sync/file-content"));
  const pushRequest = requests.find((request) => request.url.includes("/offline-sync/apply-file-content?"));
  assert.ok(pullRequest);
  assert.ok(pushRequest);
  assert.equal(pullRequest.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(pullRequest.init?.body)), {
    namespace: "default",
    includeTranscripts: false,
    path: "facts/peer.md",
    offset: 0,
    length: OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  });
  assert.match(pushRequest.url, /offline-sync\/apply-file-content\?namespace=default$/);
  assert.equal(new Headers(pushRequest.init?.headers).get("x-remnic-file-sha256"), localSha);
  assert.equal(new Headers(pushRequest.init?.headers).get("x-remnic-file-bytes"), String(localContent.length));
});

test("remnic converge apply: a newer local deletion uses the guarded remote delete contract", async () => {
  const filePath = "facts/deleted-locally.md";
  const peerContent = Buffer.from("peer v2");
  const peerSha = createHash("sha256").update(peerContent).digest("hex");
  const baseSha = "d".repeat(64);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      appliedUpserts: 0,
      appliedDeletes: 1,
      skipped: 0,
      conflicts: [],
      currentFiles: [],
    });
  };

  const result = await executeConvergeApply({
    config: parseConfig({ converge: { conflictPolicy: "newest-wins" } }),
    peerUrl: "https://peer.example.test",
    fetchImpl,
    baseFilesByNamespace: new Map([["default", [{ path: filePath, sha256: baseSha }]]]),
    localFilesByNamespace: new Map([["default", []]]),
    peerFilesByNamespace: new Map([
      ["default", [{ path: filePath, sha256: peerSha, bytes: peerContent.length, mtimeMs: 2000 }]],
    ]),
    localDeletionMtimeMsByNamespace: new Map([
      ["default", new Map([[filePath, 3000]])],
    ]),
  });

  assert.equal(result.transfers.conflictsResolved, 1);
  assert.equal(result.transfers.failed, 0);
  const request = requests.find(({ url }) => url.endsWith("/remnic/v1/offline-sync/apply"));
  assert.ok(request);
  const body = JSON.parse(String(request.init?.body)) as {
    namespace: string;
    changeset: {
      format: string;
      changes: Array<{ type: string; path: string; baseSha256: string }>;
    };
  };
  assert.equal(body.namespace, "default");
  assert.equal(body.changeset.format, "remnic.offline-sync.changeset.v1");
  assert.deepEqual(body.changeset.changes, [
    { type: "delete", path: filePath, baseSha256: peerSha },
  ]);
});

test("remnic converge plan: fails closed when the peer census cannot be fetched", async () => {
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 503 });

  await assert.rejects(
    computeConvergePlan({
      peerUrl: "https://peer.example.test",
      fetchImpl,
      localFilesByNamespace: new Map([["default", []]]),
    }),
    /failed to fetch peer snapshot/i,
  );
});

test("remnic converge plan: rejects malformed peer census records", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({ files: [{ path: "facts/incomplete.md" }], tombstones: [] });

  await assert.rejects(
    computeConvergePlan({
      peerUrl: "https://peer.example.test",
      fetchImpl,
      localFilesByNamespace: new Map([["default", []]]),
    }),
    /invalid peer snapshot/i,
  );
});

test("remnic converge apply: does not count a remote apply conflict as a push", async () => {
  const content = Buffer.from("local content");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const fetchImpl: typeof fetch = async () =>
    Response.json({
      done: true,
      applied: false,
      skipped: false,
      conflict: { reason: "remote_changed_for_local_update" },
    });

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    localFilesByNamespace: new Map([
      ["default", [{ path: "facts/local.md", sha256, bytes: content.length, mtimeMs: 1000 }]],
    ]),
    peerFilesByNamespace: new Map([["default", []]]),
    localFileBuffers: new Map([["default", new Map([["facts/local.md", content]])]]),
  });

  assert.equal(result.transfers.pushed, 0);
  assert.equal(result.transfers.failed, 1);
  assert.equal(result.converged, false);
  assert.equal(result.cursorUpdated, false);
});

test("remnic converge apply: does not count a local apply conflict as a pull", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-conflict-test-"));
  try {
    const baseContent = Buffer.from("base content");
    const peerContent = Buffer.from("peer content");
    const changedContent = Buffer.from("changed content");
    const baseSha256 = createHash("sha256").update(baseContent).digest("hex");
    const peerSha256 = createHash("sha256").update(peerContent).digest("hex");
    await fs.mkdir(path.join(rootDir, "facts"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "facts/shared.md"), changedContent);

    const result = await executeConvergeApply({
      config: parseConfig({ memoryDir: rootDir }),
      peerUrl: "https://peer.example.test",
      baseFilesByNamespace: new Map([
        ["default", [{ path: "facts/shared.md", sha256: baseSha256 }]],
      ]),
      localFilesByNamespace: new Map([
        ["default", [{ path: "facts/shared.md", sha256: baseSha256 }]],
      ]),
      peerFilesByNamespace: new Map([
        ["default", [{ path: "facts/shared.md", sha256: peerSha256, bytes: peerContent.length, mtimeMs: 2000 }]],
      ]),
      peerFileBuffers: new Map([["default", new Map([["facts/shared.md", peerContent]])]]),
    });

    assert.equal(result.transfers.pulled, 0);
    assert.equal(result.transfers.failed, 1);
    assert.equal(result.converged, false);
    assert.equal(result.cursorUpdated, false);
    assert.equal(await fs.readFile(path.join(rootDir, "facts/shared.md"), "utf8"), "changed content");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("remnic converge apply: peer-wins guards against the planned local revision", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-peer-wins-test-"));
  try {
    const baseSha256 = createHash("sha256").update("base content").digest("hex");
    const localContent = Buffer.from("local content");
    const peerContent = Buffer.from("peer content");
    const localSha256 = createHash("sha256").update(localContent).digest("hex");
    const peerSha256 = createHash("sha256").update(peerContent).digest("hex");
    await fs.mkdir(path.join(rootDir, "facts"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "facts/shared.md"), localContent);

    const result = await executeConvergeApply({
      config: parseConfig({ memoryDir: rootDir }),
      peerUrl: "https://peer.example.test",
      conflictPolicy: "newest-wins",
      baseFilesByNamespace: new Map([
        ["default", [{ path: "facts/shared.md", sha256: baseSha256 }]],
      ]),
      localFilesByNamespace: new Map([
        ["default", [{ path: "facts/shared.md", sha256: localSha256, mtimeMs: 1000 }]],
      ]),
      peerFilesByNamespace: new Map([
        ["default", [{ path: "facts/shared.md", sha256: peerSha256, bytes: peerContent.length, mtimeMs: 2000 }]],
      ]),
      peerFileBuffers: new Map([["default", new Map([["facts/shared.md", peerContent]])]]),
    });

    assert.equal(result.transfers.conflictsResolved, 1);
    assert.equal(result.transfers.failed, 0);
    assert.equal(await fs.readFile(path.join(rootDir, "facts/shared.md"), "utf8"), "peer content");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("remnic converge apply: local-wins guards against the planned peer revision", async () => {
  const baseSha256 = createHash("sha256").update("base content").digest("hex");
  const localContent = Buffer.from("local content");
  const peerContent = Buffer.from("peer content");
  const localSha256 = createHash("sha256").update(localContent).digest("hex");
  const peerSha256 = createHash("sha256").update(peerContent).digest("hex");
  let baseHeader: string | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    baseHeader = new Headers(init?.headers).get("x-remnic-base-sha256");
    return Response.json({ done: true, applied: true, skipped: false });
  };

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    conflictPolicy: "newest-wins",
    baseFilesByNamespace: new Map([
      ["default", [{ path: "facts/shared.md", sha256: baseSha256 }]],
    ]),
    localFilesByNamespace: new Map([
      ["default", [{ path: "facts/shared.md", sha256: localSha256, bytes: localContent.length, mtimeMs: 2000 }]],
    ]),
    peerFilesByNamespace: new Map([
      ["default", [{ path: "facts/shared.md", sha256: peerSha256, bytes: peerContent.length, mtimeMs: 1000 }]],
    ]),
    localFileBuffers: new Map([["default", new Map([["facts/shared.md", localContent]])]]),
  });

  assert.equal(result.transfers.conflictsResolved, 1);
  assert.equal(result.transfers.failed, 0);
  assert.equal(baseHeader, peerSha256);
});

test("remnic converge plan: config selects the policy and a CLI option overrides it", async () => {
  const localFilesByNamespace = new Map<string, ReconcileFileState[]>([
    ["default", [{ path: "facts/shared.md", sha256: shaA, mtimeMs: 1000 }]],
  ]);
  const peerFilesByNamespace = new Map<string, ReconcileFileState[]>([
    ["default", [{ path: "facts/shared.md", sha256: shaB, mtimeMs: 2000 }]],
  ]);
  const config = parseConfig({ converge: { conflictPolicy: "manual" } });

  const configured = await computeConvergePlan({
    config,
    localFilesByNamespace,
    peerFilesByNamespace,
  });
  assert.equal(configured.entries[0]?.resolution, "unresolved");

  const overridden = await computeConvergePlan({
    config,
    conflictPolicy: "newest-wins",
    localFilesByNamespace,
    peerFilesByNamespace,
  });
  assert.equal(overridden.entries[0]?.resolution, "peer-wins");
});

test("remnic converge CLI rejects removed and unknown conflict-policy overrides", async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (const conflictPolicy of ["keep-both", "invalid"]) {
      await assert.rejects(
        () => cmdConverge("plan", ["--conflict-policy", conflictPolicy], true, parseConfig({})),
        /--conflict-policy must be one of newest-wins, manual/,
      );
    }
  } finally {
    console.log = originalLog;
  }
});
