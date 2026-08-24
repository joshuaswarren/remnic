import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ContentHashIndex, OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES, parseConfig } from "@remnic/core";
import type { ReconcileFileState, ReconcilePlan } from "@remnic/core/reconcile/plan.js";
import { defaultConvergeCursorPath, readConvergeCursor, writeConvergeCursor } from "@remnic/core/reconcile/cursor.js";
import {
  cmdConverge,
  computeConvergePlan,
  executeConvergeApply,
  formatConvergeApplyReport,
  formatConvergeReport,
  type ConvergeApplyResult,
} from "./converge.js";
import { convergeWatch } from "./converge-watch.js";

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
  const localMap = new Map<string, ReconcileFileState[]>([["alpha", [{ path: "facts/a.md", sha256: shaA }]]]);
  const peerMap = new Map<string, ReconcileFileState[]>([["beta", [{ path: "facts/b.md", sha256: shaB }]]]);

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
    computeConvergePlan({
      baseFilesByNamespace: baseMap,
      localFilesByNamespace: new Map(),
    }),
    /aliasing paths/
  );
});

test("remnic converge plan: enumerates durable cursor-only namespaces before peer census", async () => {
  const cursorDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-cursor-only-"));
  const peerUrl = "https://peer.example.com/Memory";
  try {
    await writeConvergeCursor(defaultConvergeCursorPath(cursorDir, peerUrl, "archived"), {
      version: 1,
      peerUrl,
      namespace: "archived",
      baseFiles: [],
    });
    const requestedNamespaces: string[] = [];
    await computeConvergePlan({
      cursorDir,
      peerUrl,
      localFilesByNamespace: new Map([["default", []]]),
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/offline-sync/capabilities")) {
          return new Response(null, { status: 404 });
        }
        requestedNamespaces.push(url.searchParams.get("namespace") ?? "");
        return Response.json({ files: [], tombstones: [] });
      },
    });
    assert.deepEqual(requestedNamespaces.sort(), ["archived", "default"]);
  } finally {
    await fs.rm(cursorDir, { recursive: true, force: true });
  }
});

test("remnic converge plan: fails closed on malformed durable cursor state", async () => {
  const cursorDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-bad-cursor-"));
  try {
    const directory = path.join(cursorDir, ".remnic", "state", "converge-cursors");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "broken.json"), "{not-json");
    await assert.rejects(
      computeConvergePlan({
        cursorDir,
        peerUrl: "http://peer",
        localFilesByNamespace: new Map([["default", []]]),
        fetchImpl: async () => Response.json({ files: [], tombstones: [] }),
      }),
      /invalid converge cursor/
    );
  } finally {
    await fs.rm(cursorDir, { recursive: true, force: true });
  }
});

test("remnic converge plan: maps peer tombstone content hashes through the manifest file identity", async () => {
  const contentHash = "c".repeat(64);
  const memoryContent = Buffer.from(
    `---\nid: mem-1\ncategory: fact\ncontentHash: ${contentHash}\nstatus: active\n---\nRetired fact\n`
  );
  const memorySha = createHash("sha256").update(memoryContent).digest("hex");
  const tombstoneContent = Buffer.from(`${JSON.stringify({ contentHash })}\n`);
  const tombstoneSha = createHash("sha256").update(tombstoneContent).digest("hex");
  const files = [
    { path: "facts/retracted.md", sha256: memorySha, bytes: memoryContent.length, mtimeMs: 1 },
    { path: "state/tombstones.jsonl", sha256: tombstoneSha, bytes: tombstoneContent.length, mtimeMs: 1 },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/capabilities")) {
      return new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/offline-sync/snapshot")) {
      return Response.json({ files, tombstones: [] });
    }
    const request = JSON.parse(String(init?.body)) as { path: string; offset: number };
    const content = request.path === "state/tombstones.jsonl" ? tombstoneContent : memoryContent;
    const sha256 = request.path === "state/tombstones.jsonl" ? tombstoneSha : memorySha;
    return new Response(content.subarray(request.offset), {
      headers: {
        "x-remnic-chunk-offset": String(request.offset),
        "x-remnic-chunk-bytes": String(content.length - request.offset),
        "x-remnic-file-bytes": String(content.length),
        "x-remnic-file-mtime-ms": "1",
        "x-remnic-file-path": encodeURIComponent(request.path),
        "x-remnic-file-sha256": sha256,
      },
    });
  };

  const plan = await computeConvergePlan({
    peerUrl: "http://peer",
    localFilesByNamespace: new Map([["default", [files[0]!]]]),
    fetchImpl,
  });
  const suppression = plan.entries.find((entry) => entry.path === "facts/retracted.md");
  assert.equal(suppression?.action, "suppress");
  assert.equal(suppression?.suppressSide, "both");
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
    assert.equal(result.converged, true);
    assert.equal(result.cursorUpdated, false);
    assert.equal(await readConvergeCursor(cursorPath), null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("remnic converge apply: tombstone suppression deletes the retracted revision on both sides", async () => {
  const filePath = "facts/retracted.md";
  const content = Buffer.from("retracted");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const localBuffers = new Map([["default", new Map([[filePath, content]])]]);
  const peerBuffers = new Map([["default", new Map([[filePath, content]])]]);

  const result = await executeConvergeApply({
    localFilesByNamespace: new Map([["default", [{ path: filePath, sha256 }]]]),
    peerFilesByNamespace: new Map([["default", [{ path: filePath, sha256 }]]]),
    localTombstonesByNamespace: new Map([["default", [sha256]]]),
    localFileBuffers: localBuffers,
    peerFileBuffers: peerBuffers,
  });

  assert.equal(result.transfers.suppressed, 1);
  assert.equal(result.transfers.failed, 0);
  assert.equal(localBuffers.get("default")?.has(filePath), false);
  assert.equal(peerBuffers.get("default")?.has(filePath), false);
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
    [
      "default",
      [
        { path: localModificationWins, sha256: localSha, mtimeMs: 4000 },
        { path: peerDeletionWins, sha256: localSha, mtimeMs: 2000 },
      ],
    ],
  ]);
  const peerMap = new Map<string, ReconcileFileState[]>([
    [
      "default",
      [
        { path: peerModificationWins, sha256: peerSha, mtimeMs: 4000 },
        { path: localDeletionWins, sha256: peerSha, mtimeMs: 2000 },
      ],
    ],
  ]);
  const baseMap = new Map<string, ReconcileFileState[]>([
    [
      "default",
      [
        { path: localModificationWins, sha256: baseSha, mtimeMs: 1000 },
        { path: peerDeletionWins, sha256: baseSha, mtimeMs: 1000 },
        { path: peerModificationWins, sha256: baseSha, mtimeMs: 1000 },
        { path: localDeletionWins, sha256: baseSha, mtimeMs: 1000 },
      ],
    ],
  ]);
  const localBuffers = new Map<string, Map<string, Buffer>>([
    [
      "default",
      new Map([
        [localModificationWins, localModified],
        [peerDeletionWins, localModified],
      ]),
    ],
  ]);
  const peerBuffers = new Map<string, Map<string, Buffer>>([
    [
      "default",
      new Map([
        [peerModificationWins, peerModified],
        [localDeletionWins, peerModified],
      ]),
    ],
  ]);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-delete-"));

  const result = await executeConvergeApply({
    config: parseConfig({ converge: { conflictPolicy: "newest-wins" } }),
    baseFilesByNamespace: baseMap,
    localFilesByNamespace: localMap,
    peerFilesByNamespace: peerMap,
    localDeletionMtimeMsByNamespace: new Map([
      [
        "default",
        new Map([
          [peerModificationWins, 3000],
          [localDeletionWins, 3000],
        ]),
      ],
    ]),
    peerDeletionMtimeMsByNamespace: new Map([
      [
        "default",
        new Map([
          [localModificationWins, 3000],
          [peerDeletionWins, 3000],
        ]),
      ],
    ]),
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
    [localModificationWins, peerModificationWins].sort()
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
    if (url.includes("/remnic/v1/offline-sync/convergence-complete?namespace=default")) {
      return Response.json({ namespaces: ["default"], refreshed: true });
    }
    return new Response(null, { status: 404 });
  };
  const localBuffers = new Map<string, Map<string, Buffer>>([["default", new Map([["facts/local.md", localContent]])]]);

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
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/offline-sync/convergence-complete")) {
      return Response.json({ namespaces: ["default"], refreshed: true });
    }
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
    localDeletionMtimeMsByNamespace: new Map([["default", new Map([[filePath, 3000]])]]),
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
  assert.deepEqual(body.changeset.changes, [{ type: "delete", path: filePath, baseSha256: peerSha }]);
  assert.ok(requests.some(({ url }) => url.includes("/offline-sync/convergence-complete?namespace=default")));
});

test("remnic converge plan: fails closed when the peer census cannot be fetched", async () => {
  const fetchImpl: typeof fetch = async (input) =>
    String(input).includes("/offline-sync/capabilities")
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 503 });

  await assert.rejects(
    computeConvergePlan({
      peerUrl: "https://peer.example.test",
      fetchImpl,
      localFilesByNamespace: new Map([["default", []]]),
    }),
    /failed to fetch peer snapshot/i
  );
});

test("remnic converge plan: rejects malformed peer census records", async () => {
  const fetchImpl: typeof fetch = async (input) =>
    String(input).includes("/offline-sync/capabilities")
      ? new Response(null, { status: 404 })
      : Response.json({ files: [{ path: "facts/incomplete.md" }], tombstones: [] });

  await assert.rejects(
    computeConvergePlan({
      peerUrl: "https://peer.example.test",
      fetchImpl,
      localFilesByNamespace: new Map([["default", []]]),
    }),
    /invalid peer snapshot/i
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
      baseFilesByNamespace: new Map([["default", [{ path: "facts/shared.md", sha256: baseSha256 }]]]),
      localFilesByNamespace: new Map([["default", [{ path: "facts/shared.md", sha256: baseSha256 }]]]),
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
      baseFilesByNamespace: new Map([["default", [{ path: "facts/shared.md", sha256: baseSha256 }]]]),
      localFilesByNamespace: new Map([["default", [{ path: "facts/shared.md", sha256: localSha256, mtimeMs: 1000 }]]]),
      peerFilesByNamespace: new Map([
        ["default", [{ path: "facts/shared.md", sha256: peerSha256, bytes: peerContent.length, mtimeMs: 2000 }]],
      ]),
      peerFileBuffers: new Map([["default", new Map([["facts/shared.md", peerContent]])]]),
    });

    assert.equal(result.transfers.conflictsResolved, 1);
    assert.equal(result.transfers.failed, 0);
    assert.equal(await fs.readFile(path.join(rootDir, "facts/shared.md"), "utf8"), "peer content");
    const cursor = await readConvergeCursor(defaultConvergeCursorPath(rootDir, "https://peer.example.test", "default"));
    assert.equal(cursor?.baseFiles[0]?.sha256, peerSha256);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("remnic converge apply: pull advances the cursor to the peer digest", async () => {
  const cursorDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-pull-cursor-test-"));
  try {
    const filePath = "facts/shared.md";
    const localContent = Buffer.from("local content");
    const peerContent = Buffer.from("peer content");
    const localSha256 = createHash("sha256").update(localContent).digest("hex");
    const peerSha256 = createHash("sha256").update(peerContent).digest("hex");
    const peerUrl = "https://peer.example.test";

    const result = await executeConvergeApply({
      cursorDir,
      peerUrl,
      baseFilesByNamespace: new Map([["default", [{ path: filePath, sha256: localSha256 }]]]),
      localFilesByNamespace: new Map([["default", [{ path: filePath, sha256: localSha256 }]]]),
      peerFilesByNamespace: new Map([["default", [{ path: filePath, sha256: peerSha256 }]]]),
      localFileBuffers: new Map([["default", new Map([[filePath, localContent]])]]),
      peerFileBuffers: new Map([["default", new Map([[filePath, peerContent]])]]),
    });

    assert.equal(result.transfers.pulled, 1);
    const cursor = await readConvergeCursor(defaultConvergeCursorPath(cursorDir, peerUrl, "default"));
    assert.equal(cursor?.baseFiles[0]?.sha256, peerSha256);
  } finally {
    await fs.rm(cursorDir, { recursive: true, force: true });
  }
});

test("remnic converge apply: local-wins guards against the planned peer revision", async () => {
  const baseSha256 = createHash("sha256").update("base content").digest("hex");
  const localContent = Buffer.from("local content");
  const peerContent = Buffer.from("peer content");
  const localSha256 = createHash("sha256").update(localContent).digest("hex");
  const peerSha256 = createHash("sha256").update(peerContent).digest("hex");
  let baseHeader: string | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).includes("/offline-sync/convergence-complete")) {
      return Response.json({ namespaces: ["default"], refreshed: true });
    }
    baseHeader = new Headers(init?.headers).get("x-remnic-base-sha256");
    return Response.json({ done: true, applied: true, skipped: false });
  };

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    conflictPolicy: "newest-wins",
    baseFilesByNamespace: new Map([["default", [{ path: "facts/shared.md", sha256: baseSha256 }]]]),
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
        /--conflict-policy must be one of newest-wins, manual/
      );
    }
  } finally {
    console.log = originalLog;
  }
});

test("remnic converge retains per-side semantic state across a later metadata edit", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-manifest-"));
  const cursorDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-cursor-"));
  try {
    const body = "same active fact";
    const semanticHash = ContentHashIndex.computeHash(body);
    const memory = (id: string, updated: string): string =>
      [
        "---",
        `id: ${id}`,
        "category: fact",
        "created: 2026-01-01T00:00:00.000Z",
        `updated: ${updated}`,
        `contentHash: ${semanticHash}`,
        "status: active",
        "---",
        body,
      ].join("\n");
    let localContent = memory("local-id", "2026-01-01T00:00:00.000Z");
    const peerContent = memory("peer-id", "2026-01-02T00:00:00.000Z");
    const localSha = createHash("sha256").update(localContent).digest("hex");
    const peerSha = createHash("sha256").update(peerContent).digest("hex");
    await fs.mkdir(path.join(rootDir, "facts"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "facts/local-id.md"), localContent);

    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/offline-sync/snapshot")) {
        return Response.json({
          files:
            url.searchParams.get("namespace") === "default"
              ? [{ path: "facts/peer-id.md", sha256: peerSha, bytes: peerContent.length, mtimeMs: 2000 }]
              : [],
          tombstones: [],
        });
      }
      if (url.pathname.endsWith("/offline-sync/file-content")) {
        return new Response(peerContent, {
          headers: {
            "x-remnic-file-path": encodeURIComponent("facts/peer-id.md"),
            "x-remnic-file-sha256": peerSha,
            "x-remnic-file-bytes": String(peerContent.length),
            "x-remnic-file-mtime-ms": "2000",
            "x-remnic-chunk-offset": "0",
            "x-remnic-chunk-bytes": String(peerContent.length),
          },
        });
      }
      return new Response(null, { status: 404 });
    };

    const peerUrl = "https://peer.example.test";
    const options = {
      config: parseConfig({ memoryDir: rootDir }),
      cursorDir,
      peerUrl,
      fetchImpl,
    };
    const plan = await computeConvergePlan(options);

    assert.notEqual(localSha, peerSha);
    assert.equal(plan.converged, true, JSON.stringify(plan));
    assert.deepEqual(plan.entries[0]?.semanticAgreement, {
      local: { path: "facts/local-id.md", sha256: localSha },
      peer: { path: "facts/peer-id.md", sha256: peerSha },
    });
    assert.equal(plan.entries[0]?.semanticChange, "unchanged");

    const result = await executeConvergeApply(options);
    assert.equal(result.converged, true);
    const cursorPath = defaultConvergeCursorPath(cursorDir, peerUrl, "default");
    const cursor = await readConvergeCursor(cursorPath);
    assert.deepEqual(cursor?.baseFiles, []);
    assert.deepEqual(cursor?.semanticAgreements, [
      {
        local: { path: "facts/local-id.md", sha256: localSha },
        peer: { path: "facts/peer-id.md", sha256: peerSha },
      },
    ]);

    localContent = memory("local-id", "2026-01-03T00:00:00.000Z");
    const editedLocalSha = createHash("sha256").update(localContent).digest("hex");
    await fs.writeFile(path.join(rootDir, "facts/local-id.md"), localContent);
    const explicitPlan = await computeConvergePlan({
      ...options,
      semanticAgreementsByNamespace: new Map([
        [
          "default",
          [
            {
              local: { path: "facts/local-id.md", sha256: editedLocalSha },
              peer: { path: "facts/peer-id.md", sha256: peerSha },
            },
          ],
        ],
      ]),
    });
    assert.equal(explicitPlan.entries[0]?.semanticChange, "unchanged");

    const changedPlan = await computeConvergePlan(options);
    assert.equal(changedPlan.converged, true, JSON.stringify(changedPlan));
    assert.equal(changedPlan.entries[0]?.action, "identical");
    assert.equal(changedPlan.entries[0]?.semanticChange, "local_changed");
    assert.deepEqual(changedPlan.entries[0]?.semanticAgreement, {
      local: { path: "facts/local-id.md", sha256: editedLocalSha },
      peer: { path: "facts/peer-id.md", sha256: peerSha },
    });
    assert.equal(changedPlan.entries[0]?.localSha256, undefined);
    assert.equal(changedPlan.entries[0]?.peerSha256, undefined);

    const changedResult = await executeConvergeApply(options);
    assert.deepEqual(changedResult.transfers, {
      pulled: 0,
      pushed: 0,
      conflictsResolved: 0,
      suppressed: 0,
      failed: 0,
    });
    const changedCursor = await readConvergeCursor(cursorPath);
    assert.deepEqual(changedCursor?.semanticAgreements, [
      {
        local: { path: "facts/local-id.md", sha256: editedLocalSha },
        peer: { path: "facts/peer-id.md", sha256: peerSha },
      },
    ]);

    const unchangedPlan = await computeConvergePlan(options);
    assert.equal(unchangedPlan.entries[0]?.semanticChange, "unchanged");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(cursorDir, { recursive: true, force: true });
  }
});
test("remnic converge consumes peer manifests without per-fact content requests", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-stream-manifest-"));
  try {
    const body = "same streamed fact";
    const semanticHash = ContentHashIndex.computeHash(body);
    const memory = (id: string): string =>
      ["---", `id: ${id}`, "category: fact", `contentHash: ${semanticHash}`, "status: active", "---", body].join("\n");
    const localContent = memory("local-id");
    const peerContent = memory("peer-id");
    const peerSha = createHash("sha256").update(peerContent).digest("hex");
    await fs.mkdir(path.join(rootDir, "facts"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "facts/local-id.md"), localContent);
    let peerContentRequests = 0;
    let manifestRequests = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/offline-sync/capabilities")) {
        return Response.json({ version: 1, convergenceFinalization: true, manifestStream: true });
      }
      if (url.pathname.endsWith("/offline-sync/snapshot")) {
        const files =
          url.searchParams.get("namespace") === "default"
            ? [{ path: "facts/peer-id.md", sha256: peerSha, bytes: peerContent.length, mtimeMs: 2000 }]
            : [];
        return Response.json({ files, tombstones: [] });
      }
      if (url.pathname.endsWith("/offline-sync/manifest-stream")) {
        manifestRequests += 1;
        const namespace = url.searchParams.get("namespace");
        const rows = [
          JSON.stringify({
            type: "manifest",
            namespace,
            format: "remnic-reconcile-manifest",
            schemaVersion: 1,
          }),
        ];
        if (namespace === "default") {
          rows.push(
            JSON.stringify({
              type: "file",
              file: {
                path: "facts/peer-id.md",
                sha256: peerSha,
                bytes: peerContent.length,
                mtimeMs: 2000,
                memory: {
                  id: "peer-id",
                  category: "fact",
                  contentHash: semanticHash,
                  status: "active",
                },
              },
            })
          );
        }
        return new Response([...rows, ""].join("\n"));
      }
      if (url.pathname.endsWith("/offline-sync/file-content")) peerContentRequests += 1;
      return new Response(null, { status: 404 });
    };

    const plan = await computeConvergePlan({
      config: parseConfig({ memoryDir: rootDir }),
      peerUrl: "https://peer.example.test",
      fetchImpl,
    });

    assert.equal(manifestRequests, 2);
    assert.equal(peerContentRequests, 0);
    assert.equal(plan.converged, true, JSON.stringify(plan));
    assert.equal(plan.entries[0]?.reason, "semantic_duplicate");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("remnic converge falls back to per-fact content only for an older peer", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-legacy-manifest-"));
  try {
    const body = "same legacy peer fact";
    const semanticHash = ContentHashIndex.computeHash(body);
    const memory = (id: string): string =>
      ["---", `id: ${id}`, "category: fact", `contentHash: ${semanticHash}`, "status: active", "---", body].join("\n");
    const localContent = memory("local-id");
    const peerContent = memory("peer-id");
    const peerSha = createHash("sha256").update(peerContent).digest("hex");
    await fs.mkdir(path.join(rootDir, "facts"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "facts/local-id.md"), localContent);
    let peerContentRequests = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/offline-sync/capabilities")) {
        return new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/offline-sync/snapshot")) {
        const files =
          url.searchParams.get("namespace") === "default"
            ? [{ path: "facts/peer-id.md", sha256: peerSha, bytes: peerContent.length, mtimeMs: 2000 }]
            : [];
        return Response.json({ files, tombstones: [] });
      }
      if (url.pathname.endsWith("/offline-sync/file-content")) {
        peerContentRequests += 1;
        return new Response(peerContent, {
          headers: {
            "x-remnic-file-path": encodeURIComponent("facts/peer-id.md"),
            "x-remnic-file-sha256": peerSha,
            "x-remnic-file-bytes": String(peerContent.length),
            "x-remnic-file-mtime-ms": "2000",
            "x-remnic-chunk-offset": "0",
            "x-remnic-chunk-bytes": String(peerContent.length),
          },
        });
      }
      return new Response(null, { status: 404 });
    };

    const plan = await computeConvergePlan({
      config: parseConfig({ memoryDir: rootDir }),
      peerUrl: "https://older-peer.example.test",
      fetchImpl,
    });

    assert.equal(peerContentRequests, 1);
    assert.equal(plan.converged, true, JSON.stringify(plan));
    assert.equal(plan.entries[0]?.reason, "semantic_duplicate");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("remnic converge does not hide legacy manifest content failures", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-legacy-failure-"));
  try {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/offline-sync/capabilities")) {
        return new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/offline-sync/snapshot")) {
        return Response.json({
          files: [{ path: "facts/peer-id.md", sha256: "a".repeat(64), bytes: 10, mtimeMs: 2000 }],
          tombstones: [],
        });
      }
      if (url.pathname.endsWith("/offline-sync/file-content")) throw new Error("request timed out");
      return new Response(null, { status: 404 });
    };

    await assert.rejects(
      computeConvergePlan({
        config: parseConfig({ memoryDir: rootDir }),
        peerUrl: "https://older-peer.example.test",
        fetchImpl,
      }),
      /failed to read peer reconciliation manifest file: facts\/peer-id\.md/
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("remnic converge plan reuses unchanged shared peer semantics to collapse cross-path duplicates", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-shared-manifest-"));
  try {
    const body = "same active fact at a shared path";
    const semanticHash = ContentHashIndex.computeHash(body);
    const memory = (id: string): string =>
      [
        "---",
        `id: ${id}`,
        "category: fact",
        "created: 2026-01-01T00:00:00.000Z",
        "updated: 2026-01-01T00:00:00.000Z",
        `contentHash: ${semanticHash}`,
        "status: active",
        "---",
        body,
      ].join("\n");
    const canonicalContent = memory("a");
    const sharedContent = memory("z");
    const sharedSha = createHash("sha256").update(sharedContent).digest("hex");
    await fs.mkdir(path.join(rootDir, "facts"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "facts/a.md"), canonicalContent);
    await fs.writeFile(path.join(rootDir, "facts/z.md"), sharedContent);
    let peerContentRequests = 0;

    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/offline-sync/snapshot")) {
        return Response.json({
          files:
            url.searchParams.get("namespace") === "default"
              ? [{ path: "facts/z.md", sha256: sharedSha, bytes: sharedContent.length, mtimeMs: 2000 }]
              : [],
          tombstones: [],
        });
      }
      if (url.pathname.endsWith("/offline-sync/file-content")) {
        peerContentRequests += 1;
      }
      return new Response(null, { status: 404 });
    };

    const plan = await computeConvergePlan({
      config: parseConfig({ memoryDir: rootDir }),
      peerUrl: "https://peer.example.test",
      fetchImpl,
    });

    assert.equal(peerContentRequests, 0);
    assert.equal(plan.converged, true, JSON.stringify(plan));
    assert.deepEqual(
      plan.entries.map((entry) => [entry.path, entry.action, entry.reason]),
      [["facts/a.md", "identical", "semantic_duplicate"]]
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
test("remnic converge apply: finalizes each mutated peer namespace once after a successful batch", async () => {
  const teamA = Buffer.from("team a");
  const teamB = Buffer.from("team b");
  const shared = Buffer.from("shared");
  const buffers = new Map<string, Map<string, Buffer>>([
    [
      "team",
      new Map([
        ["facts/a.md", teamA],
        ["facts/b.md", teamB],
      ]),
    ],
    ["shared", new Map([["facts/c.md", shared]])],
  ]);
  const localFiles = new Map<string, ReconcileFileState[]>([
    [
      "team",
      [
        { path: "facts/a.md", sha256: createHash("sha256").update(teamA).digest("hex") },
        { path: "facts/b.md", sha256: createHash("sha256").update(teamB).digest("hex") },
      ],
    ],
    ["shared", [{ path: "facts/c.md", sha256: createHash("sha256").update(shared).digest("hex") }]],
  ]);
  const finalized: string[][] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/apply-file-content")) {
      return Response.json({ done: true, applied: true, skipped: false });
    }
    if (url.pathname.endsWith("/offline-sync/convergence-complete")) {
      assert.equal(new Headers(init?.headers).get("x-remnic-source-id"), "remnic-converge");
      const namespaces = url.searchParams.getAll("namespace");
      finalized.push(namespaces);
      return Response.json({ namespaces, refreshed: true });
    }
    return new Response(null, { status: 404 });
  };

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    localFilesByNamespace: localFiles,
    peerFilesByNamespace: new Map([
      ["team", []],
      ["shared", []],
    ]),
    localFileBuffers: buffers,
  });

  assert.equal(result.transfers.pushed, 3);
  assert.equal(result.transfers.failed, 0);
  assert.deepEqual(finalized, [["shared", "team"]]);
});

test("remnic converge apply: does not finalize peer namespaces after an incomplete batch", async () => {
  const content = Buffer.from("local");
  let finalizeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/offline-sync/convergence-complete")) {
      finalizeCalls += 1;
      return Response.json({ namespaces: ["team"], refreshed: true });
    }
    return Response.json({
      done: true,
      applied: false,
      skipped: false,
      conflict: { path: "facts/a.md", reason: "both_modified" },
    });
  };

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    localFilesByNamespace: new Map([
      [
        "team",
        [
          {
            path: "facts/a.md",
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      ],
    ]),
    peerFilesByNamespace: new Map([["team", []]]),
    localFileBuffers: new Map([["team", new Map([["facts/a.md", content]])]]),
  });

  assert.equal(result.transfers.failed, 1);
  assert.equal(finalizeCalls, 0);
});

test("remnic converge apply: finalizes completed namespaces when another namespace fails", async () => {
  const team = Buffer.from("team");
  const shared = Buffer.from("shared");
  const finalized: string[][] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/convergence-complete")) {
      const namespaces = url.searchParams.getAll("namespace");
      finalized.push(namespaces);
      return Response.json({ namespaces, refreshed: true });
    }
    if (url.searchParams.get("namespace") === "team") {
      return Response.json({ done: true, applied: true, skipped: false });
    }
    return Response.json({
      done: true,
      applied: false,
      skipped: false,
      conflict: { path: "facts/shared.md", reason: "both_modified" },
    });
  };

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    localFilesByNamespace: new Map([
      ["team", [{ path: "facts/team.md", sha256: createHash("sha256").update(team).digest("hex") }]],
      ["shared", [{ path: "facts/shared.md", sha256: createHash("sha256").update(shared).digest("hex") }]],
    ]),
    peerFilesByNamespace: new Map([
      ["team", []],
      ["shared", []],
    ]),
    localFileBuffers: new Map([
      ["team", new Map([["facts/team.md", team]])],
      ["shared", new Map([["facts/shared.md", shared]])],
    ]),
  });

  assert.equal(result.transfers.failed, 1);
  assert.deepEqual(finalized, [["team"]]);
});

test("remnic converge apply: does not finalize a peer namespace when every write is skipped", async () => {
  const content = Buffer.from("already present");
  let finalizeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes("/offline-sync/convergence-complete")) {
      finalizeCalls += 1;
      return Response.json({ namespaces: ["team"], refreshed: true });
    }
    return Response.json({ done: true, applied: false, skipped: true });
  };

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    localFilesByNamespace: new Map([
      [
        "team",
        [
          {
            path: "facts/a.md",
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      ],
    ]),
    peerFilesByNamespace: new Map([["team", []]]),
    localFileBuffers: new Map([["team", new Map([["facts/a.md", content]])]]),
  });

  assert.equal(result.transfers.failed, 0);
  assert.equal(finalizeCalls, 0);
});

test("remnic converge apply: finalization falls back to the engram route", async () => {
  const content = Buffer.from("local");
  const finalizePaths: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/apply-file-content")) {
      return Response.json({ done: true, applied: true, skipped: false });
    }
    if (url.pathname.endsWith("/offline-sync/convergence-complete")) {
      finalizePaths.push(url.pathname);
      if (url.pathname.startsWith("/remnic/")) return new Response(null, { status: 404 });
      return Response.json({ namespaces: ["team"], refreshed: true });
    }
    return new Response(null, { status: 404 });
  };

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test/",
    fetchImpl,
    localFilesByNamespace: new Map([
      [
        "team",
        [
          {
            path: "facts/a.md",
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      ],
    ]),
    peerFilesByNamespace: new Map([["team", []]]),
    localFileBuffers: new Map([["team", new Map([["facts/a.md", content]])]]),
  });

  assert.equal(result.transfers.failed, 0);
  assert.deepEqual(finalizePaths, [
    "/remnic/v1/offline-sync/convergence-complete",
    "/engram/v1/offline-sync/convergence-complete",
  ]);
});

test("remnic converge apply: finalizes after an ambiguous alias retry", async () => {
  const content = Buffer.from("local");
  let finalizeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/remnic/v1/offline-sync/apply-file-content") {
      throw new Error("response lost");
    }
    if (url.pathname === "/engram/v1/offline-sync/apply-file-content") {
      return Response.json({ done: true, applied: false, skipped: true });
    }
    if (url.pathname.endsWith("/offline-sync/convergence-complete")) {
      finalizeCalls += 1;
      return Response.json({ namespaces: ["team"], refreshed: true });
    }
    return new Response(null, { status: 404 });
  };

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    localFilesByNamespace: new Map([
      [
        "team",
        [
          {
            path: "facts/a.md",
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      ],
    ]),
    peerFilesByNamespace: new Map([["team", []]]),
    localFileBuffers: new Map([["team", new Map([["facts/a.md", content]])]]),
  });

  assert.equal(result.transfers.failed, 0);
  assert.equal(finalizeCalls, 1);
});

test("remnic converge apply: a failed peer refresh prevents convergence and cursor advancement", async () => {
  const content = Buffer.from("local");
  let finalizeCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes("/offline-sync/convergence-complete")) {
      finalizeCalls += 1;
      return new Response(null, { status: 503 });
    }
    return Response.json({ done: true, applied: true, skipped: false });
  };

  const result = await executeConvergeApply({
    peerUrl: "https://peer.example.test",
    fetchImpl,
    localFilesByNamespace: new Map([
      [
        "team",
        [
          {
            path: "facts/a.md",
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      ],
    ]),
    peerFilesByNamespace: new Map([["team", []]]),
    localFileBuffers: new Map([["team", new Map([["facts/a.md", content]])]]),
  });

  assert.equal(result.transfers.failed, 1);
  assert.equal(result.converged, false);
  assert.equal(result.cursorUpdated, false);
  assert.equal(finalizeCalls, 2);
});

test("remnic converge apply: durable cursor state is excluded and a clean second run performs no file transport", async () => {
  const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-clean-rerun-"));
  const peerUrl = "http://peer";
  const filePath = "assets/a.bin";
  const content = Buffer.from("stable");
  const sha256 = createHash("sha256").update(content).digest("hex");
  try {
    await fs.mkdir(path.join(memoryDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(memoryDir, filePath), content);
    await executeConvergeApply({
      cursorDir: memoryDir,
      peerUrl,
      localFilesByNamespace: new Map([["default", [{ path: filePath, sha256 }]]]),
      peerFilesByNamespace: new Map([["default", [{ path: filePath, sha256 }]]]),
    });

    let fileTransportCalls = 0;
    const result = await executeConvergeApply({
      config: parseConfig({ memoryDir }),
      peerUrl,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/offline-sync/capabilities")) {
          return new Response(null, { status: 404 });
        }
        if (url.pathname.endsWith("/offline-sync/snapshot")) {
          const files =
            url.searchParams.get("namespace") === "default"
              ? [
                  { path: filePath, sha256, bytes: content.length, mtimeMs: 1 },
                  { path: ".remnic/state/converge-cursors/host.json", sha256: shaA, bytes: 1, mtimeMs: 1 },
                ]
              : [];
          return Response.json({ files, tombstones: [] });
        }
        fileTransportCalls += 1;
        throw new Error(`unexpected file transport: ${url.pathname}`);
      },
    });

    assert.equal(result.converged, true);
    assert.equal(fileTransportCalls, 0);
    assert.equal(
      result.plan.entries.some((entry) => entry.path.startsWith(".remnic/")),
      false
    );
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// converge watch (scheduled replication)
// ---------------------------------------------------------------------------

function applyResult(overrides: Partial<ConvergeApplyResult> = {}): ConvergeApplyResult {
  return {
    converged: true,
    status: "converged",
    plan: { converged: true, byNamespace: [], entries: [] } as unknown as ReconcilePlan,
    transfers: { pulled: 0, pushed: 0, conflictsResolved: 0, suppressed: 0, failed: 0 },
    cursorUpdated: false,
    ...overrides,
  };
}

test("converge watch: cycles on the injected applier until maxCycles", async () => {
  let calls = 0;
  const outcome = await convergeWatch({
    intervalMs: 1,
    maxCycles: 3,
    apply: async () => {
      calls += 1;
      return applyResult({ converged: calls !== 2, status: calls === 2 ? "applied" : "converged" });
    },
  });
  assert.equal(outcome.cycles, 3);
  assert.equal(outcome.convergedCycles, 2);
  assert.equal(outcome.appliedCycles, 1);
  assert.equal(outcome.failedCycles, 0);
  assert.equal(outcome.lastStatus, "converged");
});

test("converge watch: a failing cycle reports and does not stop the watch", async () => {
  const events: Array<{ cycle: number; error?: unknown }> = [];
  let calls = 0;
  const outcome = await convergeWatch({
    intervalMs: 1,
    maxCycles: 3,
    apply: async () => {
      calls += 1;
      if (calls === 1) throw new Error("peer temporarily unreachable");
      return applyResult();
    },
    onCycle: (cycle, event) => events.push({ cycle, error: event.error }),
  });
  assert.equal(outcome.cycles, 3);
  assert.equal(outcome.failedCycles, 1);
  assert.equal(outcome.convergedCycles, 2);
  assert.equal(outcome.lastStatus, "converged");
  assert.equal(events[0]?.cycle, 1);
  assert.ok(events[0]?.error instanceof Error);
  assert.equal(events.length, 3);
});

test("converge watch: pre-aborted signal runs no cycles", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const outcome = await convergeWatch({
    intervalMs: 1,
    signal: controller.signal,
    apply: async () => {
      calls += 1;
      return applyResult();
    },
  });
  assert.equal(calls, 0);
  assert.equal(outcome.cycles, 0);
  assert.equal(outcome.lastStatus, "aborted");
});

test("converge watch: abort during the sleep stops after the current cycle", async () => {
  const controller = new AbortController();
  let calls = 0;
  const outcome = await convergeWatch({
    intervalMs: 60_000,
    signal: controller.signal,
    apply: async () => {
      calls += 1;
      if (calls === 1) {
        // Abort while the watch is sleeping after cycle 1.
        queueMicrotask(() => controller.abort());
      }
      return applyResult();
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.cycles, 1);
  assert.equal(outcome.lastStatus, "converged");
});

test("remnic converge watch: bad --interval is rejected with exit code 2", async () => {
  process.exitCode = undefined;
  await cmdConverge("watch", ["--interval", "abc"], false);
  assert.equal(process.exitCode, 2);
  process.exitCode = undefined;
});

test("remnic converge watch: --interval with no value is rejected with exit code 2", async () => {
  process.exitCode = undefined;
  await cmdConverge("watch", ["--interval"], false);
  assert.equal(process.exitCode, 2);
  process.exitCode = undefined;
});

test("converge watch: a successful mutation cycle (status applied, converged true) counts as applied, not converged", async () => {
  const outcome = await convergeWatch({
    intervalMs: 1,
    maxCycles: 2,
    apply: async () =>
      applyResult({
        converged: true,
        status: "applied",
        transfers: { pulled: 3, pushed: 1, conflictsResolved: 0, suppressed: 0, failed: 0 },
      }),
  });
  assert.equal(outcome.cycles, 2);
  assert.equal(outcome.appliedCycles, 2);
  assert.equal(outcome.convergedCycles, 0);
  assert.equal(outcome.failedCycles, 0);
});

test("converge watch: conflict-stopped and partially-failed cycles count as failed, not applied", async () => {
  let calls = 0;
  const outcome = await convergeWatch({
    intervalMs: 1,
    maxCycles: 3,
    apply: async () => {
      calls += 1;
      if (calls === 1) {
        return applyResult({ converged: false, status: "stopped_unresolved_conflicts" });
      }
      if (calls === 2) {
        return applyResult({
          converged: false,
          status: "applied",
          transfers: { pulled: 2, pushed: 0, conflictsResolved: 0, suppressed: 0, failed: 1 },
        });
      }
      return applyResult();
    },
  });
  assert.equal(outcome.cycles, 3);
  assert.equal(outcome.failedCycles, 2);
  assert.equal(outcome.appliedCycles, 0);
  assert.equal(outcome.convergedCycles, 1);
  assert.equal(outcome.cycles, outcome.convergedCycles + outcome.appliedCycles + outcome.failedCycles);
});

test("converge watch: abort fires through the sleeping path, not the pre-check", async () => {
  const controller = new AbortController();
  let calls = 0;
  // Abort from a delayed macrotask: cycle 1's apply has resolved and
  // sleepAborted has registered its abort listener by then, so this hits
  // the clearTimeout path a real SIGTERM takes during a 300s sleep.
  const abortTimer = setTimeout(() => controller.abort(), 10);
  try {
    const outcome = await convergeWatch({
      intervalMs: 60_000,
      signal: controller.signal,
      apply: async () => {
        calls += 1;
        return applyResult();
      },
    });
    assert.equal(calls, 1);
    assert.equal(outcome.cycles, 1);
    assert.equal(outcome.lastStatus, "converged");
  } finally {
    clearTimeout(abortTimer);
  }
});

// ---------------------------------------------------------------------------
// converge live-peer robustness (timeout surface + tombstone tolerance)
// ---------------------------------------------------------------------------

import {
  DEFAULT_CONVERGE_PEER_REQUEST_TIMEOUT_MS,
  MAX_CONVERGE_PEER_REQUEST_TIMEOUT_MS,
  parseConvergeConfig,
} from "@remnic/core";

test("converge config: peerRequestTimeoutMs is parsed, defaulted, and clamped", async () => {
  const dflt = parseConvergeConfig(undefined);
  assert.equal(dflt.peerRequestTimeoutMs, undefined);

  const set = parseConvergeConfig({ peerRequestTimeoutMs: 120000 });
  assert.equal(set.peerRequestTimeoutMs, 120000);

  const clamped = parseConvergeConfig({ peerRequestTimeoutMs: 99_999_999 });
  assert.equal(clamped.peerRequestTimeoutMs, MAX_CONVERGE_PEER_REQUEST_TIMEOUT_MS);

  assert.throws(() => parseConvergeConfig({ peerRequestTimeoutMs: -1 }), /positive integer/);
  assert.throws(() => parseConvergeConfig({ peerRequestTimeoutMs: "soon" }), /positive integer/);
  assert.equal(DEFAULT_CONVERGE_PEER_REQUEST_TIMEOUT_MS, 30_000);
});

function tombstonePeerFixture(opts: {
  listedBytes: number;
  serveBytes: Buffer | null;
  listedShaOverride?: string;
}) {
  const memoryContent = Buffer.from(`---\nid: mem-1\ncategory: fact\nstatus: active\n---\nA fact\n`);
  const memorySha = createHash("sha256").update(memoryContent).digest("hex");
  const tombstonePart = Buffer.alloc(opts.listedBytes, 0x61);
  const listedSha = opts.listedShaOverride ?? createHash("sha256").update(tombstonePart).digest("hex");
  const files = [
    { path: "facts/live.md", sha256: memorySha, bytes: memoryContent.length, mtimeMs: 1 },
    { path: "state/tombstones.jsonl", sha256: listedSha, bytes: opts.listedBytes, mtimeMs: 1 },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/capabilities")) {
      return new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/offline-sync/snapshot")) {
      return Response.json({ files, tombstones: [] });
    }
    const request = JSON.parse(String(init?.body)) as { path: string; offset: number };
    if (request.path === "state/tombstones.jsonl" && opts.serveBytes === null) {
      return new Response(null, { status: 404 });
    }
    const content = request.path === "state/tombstones.jsonl" ? (opts.serveBytes as Buffer) : memoryContent;
    return new Response(new Uint8Array(content.subarray(request.offset)), {
      headers: {
        "x-remnic-chunk-offset": String(request.offset),
        "x-remnic-chunk-bytes": String(content.length - request.offset),
        "x-remnic-file-bytes": String(content.length),
        "x-remnic-file-mtime-ms": "1",
        "x-remnic-file-path": encodeURIComponent(request.path),
        "x-remnic-file-sha256": createHash("sha256").update(content).digest("hex"),
      },
    });
  };
  return {
    fetchImpl,
    localFilesByNamespace: new Map<string, ReconcileFileState[]>([
      ["default", [{ path: "facts/live.md", sha256: memorySha, bytes: memoryContent.length, mtimeMs: 1 }]],
    ]),
  };
}

test("converge plan: a peer that lists but cannot serve tombstones stays FATAL (retraction evidence is load-bearing)", async () => {
  const fixture = tombstonePeerFixture({ listedBytes: 10, serveBytes: null });
  await assert.rejects(
    computeConvergePlan({
      peerUrl: "http://peer",
      localFilesByNamespace: fixture.localFilesByNamespace,
      fetchImpl: fixture.fetchImpl,
    }),
    /failed to read peer tombstone evidence/
  );
});

test("converge plan: a tombstone file that grew (append-only race) is accepted via prefix match", async () => {
  // Listed revision = 10 bytes of 'a'; the live file now has 10 bytes of 'a'
  // PLUS a newer append — consistent with an append-only store on a live peer.
  const served = Buffer.concat([Buffer.alloc(10, 0x61), Buffer.from("{}\n")]);
  const fixture = tombstonePeerFixture({ listedBytes: 10, serveBytes: served });
  const plan = await computeConvergePlan({
    peerUrl: "http://peer",
    localFilesByNamespace: fixture.localFilesByNamespace,
    fetchImpl: fixture.fetchImpl,
  });
  // Completed without the fatal mismatch despite the grown file.
  assert.ok(plan.entries.some((entry) => entry.path === "state/tombstones.jsonl"));
});

test("converge plan: a tombstone file whose prefix diverges from the listing is still fatal", async () => {
  const served = Buffer.alloc(10, 0x62); // entirely different bytes
  const fixture = tombstonePeerFixture({ listedBytes: 10, serveBytes: served });
  await assert.rejects(
    computeConvergePlan({
      peerUrl: "http://peer",
      localFilesByNamespace: fixture.localFilesByNamespace,
      fetchImpl: fixture.fetchImpl,
    }),
    /failed to read peer tombstone evidence/
  );
});

test("reconcile plan: POSIX-origin paths with colons are accepted off-Windows and rejected on Windows", async () => {
  const localFile: ReconcileFileState = { path: "facts/a.md", sha256: shaA, mtimeMs: 1000 };
  const peerFile: ReconcileFileState = {
    path: "codegraph/generalist/root:cglspfixmac.sqlite",
    sha256: shaB,
    mtimeMs: 2000,
  };
  const input = {
    localFilesByNamespace: new Map([["default", [localFile]]]),
    peerFilesByNamespace: new Map([["default", [peerFile]]]),
  };
  const plan = await computeConvergePlan(input);
  assert.equal(plan.converged, false);
  assert.equal(plan.byNamespace[0]?.pull, 1);
});

test("converge --timeout seconds convert to milliseconds before normalization (#2802 follow-up)", async () => {
  const { convergeTimeoutFlagToMs } = await import("./converge.js");
  // The round-1 form produced 3600 (ms) for `--timeout 3600` — 3.6 seconds.
  assert.equal(convergeTimeoutFlagToMs(3600), 3_600_000);
  assert.equal(convergeTimeoutFlagToMs(30), 30_000);
  assert.equal(convergeTimeoutFlagToMs(0.5), 500);
  // The one-hour ceiling still clamps.
  assert.equal(convergeTimeoutFlagToMs(7_200), 3_600_000);
  assert.throws(() => convergeTimeoutFlagToMs(Number.NaN), /--timeout/);
});

test("converge --timeout rounds fractional seconds before integer normalization (#2804 round 1)", async () => {
  const { convergeTimeoutFlagToMs } = await import("./converge.js");
  assert.equal(convergeTimeoutFlagToMs(1.001), 1001);
  // Sub-millisecond values normalize-reject (positive integer required).
  assert.throws(() => convergeTimeoutFlagToMs(0.0001), /--timeout/);
});

test("converge --token-file with a missing file exits 2 before any plan work (#2823)", async () => {
  process.exitCode = undefined;
  await cmdConverge("plan", ["--peer", "http://127.0.0.1:1", "--token-file", "/nonexistent/peer.token"], true);
  assert.equal(process.exitCode, 2);
  process.exitCode = undefined;
});

test("converge --token-file rejects permissive modes and missing values (#2823 round 1)", async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-mode-"));
  try {
    const permissive = path.join(dir, "open.token");
    await writeFile(permissive, "x".repeat(64) + "\n");
    await chmod(permissive, 0o644);
    process.exitCode = undefined;
    await cmdConverge("plan", ["--peer", "http://127.0.0.1:1", "--token-file", permissive], true);
    // Windows synthesizes POSIX mode bits (readable files present as 0666),
    // so the permissive rejection is only observable on POSIX.
    if (process.platform !== "win32") assert.equal(process.exitCode, 2);
    process.exitCode = undefined;
    await cmdConverge("plan", ["--peer", "http://127.0.0.1:1", "--token-file"], true);
    assert.equal(process.exitCode, 2);
    process.exitCode = undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("converge rejects invalid REMNIC_CONVERGE_TRANSFER_CONCURRENCY (#2832)", async () => {
  const prev = process.env.REMNIC_CONVERGE_TRANSFER_CONCURRENCY;
  try {
    for (const bad of ["0", "-1", "2.5", "abc", "Infinity"]) {
      process.env.REMNIC_CONVERGE_TRANSFER_CONCURRENCY = bad;
      await assert.rejects(() => executeConvergeApply({}), /TRANSFER_CONCURRENCY must be a positive integer/);
    }
  } finally {
    if (prev === undefined) delete process.env.REMNIC_CONVERGE_TRANSFER_CONCURRENCY;
    else process.env.REMNIC_CONVERGE_TRANSFER_CONCURRENCY = prev;
  }
});

test("converge plan honors offlineSyncExcludes so node-local state is not a push", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-excludes-"));
  try {
    await fs.mkdir(path.join(rootDir, "facts"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "state"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "facts/keep.md"), "keep\n");
    await fs.writeFile(path.join(rootDir, "state/last_recall.json"), "{\"n\":1}\n");
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/offline-sync/capabilities")) {
        return new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/offline-sync/snapshot")) {
        return Response.json({ files: [], tombstones: [] });
      }
      return new Response(null, { status: 404 });
    };
    const plan = await computeConvergePlan({
      config: parseConfig({
        memoryDir: rootDir,
        offlineSyncExcludes: ["**/state/last_*.json"],
      }),
      peerUrl: "https://peer.example.test",
      fetchImpl,
    });
    assert.equal(
      plan.entries.some((entry) => entry.path.includes("last_recall")),
      false,
      JSON.stringify(plan.entries.map((entry) => entry.path))
    );
    assert.ok(plan.entries.some((entry) => entry.path === "facts/keep.md"));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

