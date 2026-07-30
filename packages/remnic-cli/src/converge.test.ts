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

test("remnic converge apply: finalizes each mutated peer namespace once after a successful batch", async () => {
  const teamA = Buffer.from("team a");
  const teamB = Buffer.from("team b");
  const shared = Buffer.from("shared");
  const buffers = new Map<string, Map<string, Buffer>>([
    ["team", new Map([
      ["facts/a.md", teamA],
      ["facts/b.md", teamB],
    ])],
    ["shared", new Map([["facts/c.md", shared]])],
  ]);
  const localFiles = new Map<string, ReconcileFileState[]>([
    ["team", [
      { path: "facts/a.md", sha256: createHash("sha256").update(teamA).digest("hex") },
      { path: "facts/b.md", sha256: createHash("sha256").update(teamB).digest("hex") },
    ]],
    ["shared", [
      { path: "facts/c.md", sha256: createHash("sha256").update(shared).digest("hex") },
    ]],
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
      ["team", [{
        path: "facts/a.md",
        sha256: createHash("sha256").update(content).digest("hex"),
      }]],
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
      ["team", [{
        path: "facts/a.md",
        sha256: createHash("sha256").update(content).digest("hex"),
      }]],
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
      ["team", [{
        path: "facts/a.md",
        sha256: createHash("sha256").update(content).digest("hex"),
      }]],
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
      ["team", [{
        path: "facts/a.md",
        sha256: createHash("sha256").update(content).digest("hex"),
      }]],
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
      ["team", [{
        path: "facts/a.md",
        sha256: createHash("sha256").update(content).digest("hex"),
      }]],
    ]),
    peerFilesByNamespace: new Map([["team", []]]),
    localFileBuffers: new Map([["team", new Map([["facts/a.md", content]])]]),
  });

  assert.equal(result.transfers.failed, 1);
  assert.equal(result.converged, false);
  assert.equal(result.cursorUpdated, false);
  assert.equal(finalizeCalls, 2);
});
