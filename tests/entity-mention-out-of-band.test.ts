/**
 * Out-of-band fact writers share `bumpMemoryCorpusVersionForDir`. That bump
 * moves the entity-mention epoch unless the caller opts out with
 * `{ indexedText: false }` for a metadata stamp. Each writer kind below is
 * the real function, not a reimplementation of the bump.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { buildEntityRecallSection } from "@remnic/core/entity-retrieval";
import { StorageManager } from "@remnic/core/storage";
import type { PluginConfig } from "@remnic/core/types";
import type { VersioningConfig } from "@remnic/core";
import { runConsolidationUndo } from "@remnic/core/consolidation-undo";
import { entityMentionEpoch } from "../packages/remnic-core/src/entity-mention-epoch.js";
import {
  dropEntityMentionIndexCache,
  entityMentionIndexScopeKeys,
  settleEntityMentionIndex,
} from "../packages/remnic-core/src/entity-mention-index-cache.js";
import { bumpMemoryCorpusVersionForDir } from "../packages/remnic-core/src/memory-corpus-version.js";
import { performReview } from "../packages/remnic-core/src/review/index.js";
import { restoreMemoryGovernanceRun } from "../packages/remnic-core/src/maintenance/memory-governance.js";
import { exportCapsule } from "../packages/remnic-core/src/transfer/capsule-export.js";
import { importCapsule } from "../packages/remnic-core/src/transfer/capsule-import.js";
import { mergeCapsule } from "../packages/remnic-core/src/transfer/capsule-merge.js";
import { createVersion, revertToVersion } from "../packages/remnic-core/src/page-versioning.js";
import { curate } from "../packages/remnic-core/src/curation/index.js";
import { createSpace, pushToSpace } from "../packages/remnic-core/src/spaces/index.js";
import { runBinaryLifecyclePipeline } from "../packages/remnic-core/src/binary-lifecycle/pipeline.js";
import { writeManifest } from "../packages/remnic-core/src/binary-lifecycle/manifest.js";
import type { BinaryStorageBackend } from "../packages/remnic-core/src/binary-lifecycle/backend.js";
import { registerCli } from "../packages/remnic-core/src/cli.js";
import { resolvePreferenceDrift } from "../packages/remnic-core/src/preferences/preference-drift.js";
import { runProcedureLibraryMaintenance } from "../packages/remnic-core/src/procedural/library-maintenance.js";
import { buildProcedurePersistBody } from "../packages/remnic-core/src/procedural/procedure-types.js";
import {
  recordCausalTrajectory,
  type CausalTrajectoryRecord,
} from "../packages/remnic-core/src/causal-trajectory.js";
import {
  executeReviewDeckAction,
  executeReviewDeckUndo,
  type ReviewDeckMutationContext,
} from "../packages/remnic-core/src/review/review-deck-mutation.js";

const versioning: VersioningConfig = {
  enabled: true,
  maxVersionsPerPage: 50,
  sidecarDir: ".versions",
};

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function epoch(dir: string): number {
  return entityMentionEpoch.current(dir);
}

async function buildHarness(prefix: string) {
  const memoryDir = await tempDir(`${prefix}-memory-`);
  const workspaceDir = await tempDir(`${prefix}-workspace-`);
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    sharedContextEnabled: false,
    hourlySummariesEnabled: false,
    transcriptEnabled: true,
    nativeKnowledge: {
      enabled: false,
      includeFiles: [],
      maxChunkChars: 400,
      maxResults: 5,
      maxChars: 1600,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
  });
  const storage = new StorageManager(memoryDir, config.entitySchemas);
  await storage.ensureDirectories();
  return { memoryDir, workspaceDir, config, storage };
}

function scopeKeyFor(dir: string): string {
  const resolved = path.resolve(dir);
  const keys = entityMentionIndexScopeKeys().filter((key) => key.includes(resolved));
  assert.equal(keys.length, 1);
  return keys[0] ?? "";
}

async function recall(config: PluginConfig, storage: StorageManager, query: string) {
  return buildEntityRecallSection({
    config,
    storage,
    query,
    recentTurns: 6,
    maxHints: 2,
    maxSupportingFacts: 6,
    maxRelatedEntities: 3,
    maxChars: 2400,
    transcriptEntries: [],
  });
}

test("bumpMemoryCorpusVersionForDir moves the mention epoch unless indexed text cannot change", async () => {
  const dir = await tempDir("engram-epoch-fordir-");
  try {
    const before = epoch(dir);
    bumpMemoryCorpusVersionForDir(dir);
    assert.equal(epoch(dir), before + 1);

    const held = epoch(dir);
    entityMentionEpoch.hold(() => {
      bumpMemoryCorpusVersionForDir(dir);
    });
    assert.equal(epoch(dir), held);

    const metadata = epoch(dir);
    bumpMemoryCorpusVersionForDir(dir, { indexedText: false });
    assert.equal(epoch(dir), metadata);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review approval of a queued fact moves the epoch and settles to a full rebuild", async () => {
  const { memoryDir, workspaceDir, config, storage } = await buildHarness("engram-epoch-review");
  const originalReadAllMemories = storage.readAllMemories.bind(storage);
  let releaseScan: () => void = () => {};
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  try {
    const canonical = await storage.writeEntity("Cedar Lattice", "project", [
      "Cedar Lattice tracks harbor lights.",
    ]);
    assert.match((await recall(config, storage, "Who is Cedar Lattice?")) ?? "", /Cedar Lattice/);
    const scopeKey = scopeKeyFor(storage.dir);
    const suggestionDir = path.join(memoryDir, "suggestions");
    await mkdir(suggestionDir, { recursive: true });
    const suggestionPath = path.join(suggestionDir, "sug-violet.md");
    await writeFile(
      suggestionPath,
      [
        "---",
        "id: sug-violet",
        "category: fact",
        "confidence: 0.2",
        "confidenceTier: low",
        "source: extraction",
        "created: 2026-10-10T00:00:00.000Z",
        `entityRef: ${canonical}`,
        "status: pending_review",
        "---",
        "",
        "Cedar Lattice keeps the marker phrase violet-harbor-441.",
        "",
      ].join("\n"),
      "utf8",
    );
    storage.readAllMemories = async (...args) => {
      await scanGate;
      return originalReadAllMemories(...args);
    };
    const before = epoch(memoryDir);
    const result = performReview(memoryDir, "sug-violet", "approve");
    assert.ok(result.updatedPath);
    assert.notEqual(epoch(memoryDir), before);

    const pending = recall(config, storage, "Who is Cedar Lattice?");
    const raced = await Promise.race([
      pending.then((section) => ({ kind: "done" as const, section })),
      new Promise<{ kind: "timeout"; section?: undefined }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 1000);
      }),
    ]);
    assert.equal(raced.kind, "done");
    assert.doesNotMatch(raced.section ?? "", /violet-harbor-441/);
    releaseScan();
    await settleEntityMentionIndex(scopeKey);
    const settled = await recall(config, storage, "Who is Cedar Lattice?");
    assert.match(settled ?? "", /violet-harbor-441/);
    dropEntityMentionIndexCache(scopeKey);
    const rebuilt = await recall(config, storage, "Who is Cedar Lattice?");
    assert.equal(settled, rebuilt);
  } finally {
    releaseScan();
    storage.readAllMemories = originalReadAllMemories;
    await settleEntityMentionIndex().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("governance restore moves the mention epoch when it writes fact text back", async () => {
  const dir = await tempDir("engram-epoch-governance-");
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const factPath = path.join(dir, "facts", "2026-01-01", "fact-restored.md");
    const beforeRaw = [
      "---",
      "id: fact-restored",
      "category: fact",
      "---",
      "",
      "Governance restored the harbor marker violet-harbor-441.",
      "",
    ].join("\n");
    const restorePath = path.join(dir, "state", "memory-governance", "runs", "gov-epoch", "restore.json");
    await mkdir(path.dirname(restorePath), { recursive: true });
    await writeFile(
      restorePath,
      JSON.stringify({
        runId: "gov-epoch",
        createdAt: "2026-10-10T00:00:00.000Z",
        entries: [
          {
            action: "set_status",
            memoryId: "fact-restored",
            reasonCode: "malformed_import",
            originalPath: factPath,
            currentPath: factPath,
            beforeRaw,
            applied: true,
          },
        ],
      }),
      "utf8",
    );
    const before = epoch(dir);
    const restored = await restoreMemoryGovernanceRun({ memoryDir: dir, runId: "gov-epoch" });
    assert.equal(restored.restoredActions, 1);
    assert.notEqual(epoch(dir), before);
    assert.match(await readFile(factPath, "utf8"), /violet-harbor-441/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function exportFactCapsule(body: string): Promise<{ archivePath: string; source: string }> {
  const source = await tempDir("engram-epoch-capsule-src-");
  const factPath = path.join(source, "facts", "2026-04-25", "fact-1.md");
  await mkdir(path.dirname(factPath), { recursive: true });
  await writeFile(
    factPath,
    `---\nid: fact-1\ncategory: fact\n---\n\n${body}\n`,
    "utf8",
  );
  const result = await exportCapsule({
    name: "epoch-capsule",
    root: source,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
  });
  return { archivePath: result.archivePath, source };
}

test("capsule import moves the mention epoch on the destination", async () => {
  const { archivePath, source } = await exportFactCapsule("Imported harbor marker violet-harbor-441.");
  const dst = await tempDir("engram-epoch-capsule-dst-");
  try {
    const before = epoch(dst);
    const result = await importCapsule({ archivePath, root: dst });
    assert.equal(result.imported.length > 0, true);
    assert.notEqual(epoch(dst), before);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
    await rm(path.dirname(archivePath), { recursive: true, force: true }).catch(() => undefined);
  }
});

test("capsule merge moves the mention epoch on the target", async () => {
  const { archivePath, source } = await exportFactCapsule("Merged harbor marker violet-harbor-441.");
  const target = await tempDir("engram-epoch-capsule-merge-");
  try {
    const before = epoch(target);
    const result = await mergeCapsule({
      sourceArchive: archivePath,
      targetRoot: target,
      conflictMode: "prefer-source",
    });
    assert.equal(result.merged.length > 0, true);
    assert.notEqual(epoch(target), before);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(path.dirname(archivePath), { recursive: true, force: true }).catch(() => undefined);
  }
});

test("page revert of a fact file moves the mention epoch", async () => {
  const dir = await tempDir("engram-epoch-revert-");
  try {
    const factPath = path.join(dir, "facts", "pref.md");
    await mkdir(path.dirname(factPath), { recursive: true });
    await writeFile(factPath, "v1 harbor marker\n", "utf8");
    await createVersion(factPath, "v1 harbor marker\n", "write", versioning, undefined, undefined, dir);
    await writeFile(factPath, "v2 harbor marker\n", "utf8");
    await createVersion(factPath, "v2 harbor marker\n", "write", versioning, undefined, undefined, dir);
    const before = epoch(dir);
    await revertToVersion(factPath, "1", versioning, undefined, dir);
    assert.notEqual(epoch(dir), before);
    assert.equal(await readFile(factPath, "utf8"), "v1 harbor marker\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("curation writes move the mention epoch", async () => {
  const memoryDir = await tempDir("engram-epoch-curation-mem-");
  const sourceRoot = await tempDir("engram-epoch-curation-src-");
  try {
    const note = path.join(sourceRoot, "note.md");
    await writeFile(
      note,
      "The harbor keeps a violet marker so night crews can find the north pier.\n",
      "utf8",
    );
    const before = epoch(memoryDir);
    const result = await curate({
      targetPath: note,
      memoryDir,
      write: true,
      checkDuplicates: false,
      entityRef: "project-cedar-lattice",
    });
    assert.equal(result.written.length > 0, true);
    assert.notEqual(epoch(memoryDir), before);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("consolidation undo moves the mention epoch when it restores fact text", async () => {
  const dir = await tempDir("engram-epoch-undo-");
  try {
    const storage = new StorageManager(dir);
    storage.setVersioningConfig({ ...versioning });
    await storage.ensureDirectories();
    const { id: srcId } = await storage.writeMemory("fact", "alpha harbor body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((memory) => memory.frontmatter.id === srcId);
    assert.ok(src);
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);
    const { unlink } = await import("node:fs/promises");
    await unlink(src.path);
    storage.invalidateAllMemoriesCacheForDir();
    const { id: canonicalId } = await storage.writeMemory("fact", "canonical harbor body", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });
    const after = await storage.readAllMemories();
    const canonical = after.find((memory) => memory.frontmatter.id === canonicalId);
    assert.ok(canonical);
    const before = epoch(dir);
    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.restores[0]?.outcome, "restored");
    assert.notEqual(epoch(dir), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pushing a space copies fact text and moves the target mention epoch", async () => {
  const baseDir = await tempDir("engram-epoch-spaces-");
  try {
    const sourceDir = path.join(baseDir, "source");
    const targetDir = path.join(baseDir, "target");
    const source = createSpace({ baseDir, name: "Source Epoch", kind: "project", memoryDir: sourceDir });
    const target = createSpace({ baseDir, name: "Target Epoch", kind: "project", memoryDir: targetDir });
    const factPath = path.join(sourceDir, "facts", "2026-10-10", "fact-push.md");
    await mkdir(path.dirname(factPath), { recursive: true });
    await writeFile(
      factPath,
      "---\nid: fact-push\ncategory: fact\n---\n\nPushed harbor marker violet-harbor-441.\n",
      "utf8",
    );
    const before = epoch(targetDir);
    const pushed = await pushToSpace(source.id, target.id, { baseDir });
    assert.equal(pushed.memoriesPushed > 0, true);
    assert.notEqual(epoch(targetDir), before);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("binary redirect of a fact note moves the mention epoch", async () => {
  const memoryDir = await tempDir("engram-epoch-binary-");
  try {
    const image = "image-bytes";
    await writeFile(path.join(memoryDir, "image.png"), image, "utf8");
    const notePath = path.join(memoryDir, "facts", "note.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(notePath, "![img](../image.png)\n", "utf8");
    await writeManifest(memoryDir, {
      version: 1,
      assets: [
        {
          originalPath: "image.png",
          mirroredPath: "remote/image.png",
          contentHash: crypto.createHash("sha256").update(image).digest("hex"),
          sizeBytes: image.length,
          mimeType: "image/png",
          mirroredAt: "2026-01-01T00:00:00.000Z",
          status: "mirrored",
        },
      ],
    });
    const backend = {
      type: "test",
      upload: async (_localPath: string, remotePath: string) => `remote/${remotePath}`,
      exists: async () => true,
      delete: async () => {},
    } satisfies BinaryStorageBackend;
    const before = epoch(memoryDir);
    const result = await runBinaryLifecyclePipeline(
      memoryDir,
      {
        enabled: true,
        gracePeriodDays: 0,
        maxBinarySizeBytes: 1024 * 1024,
        scanPatterns: ["*.png"],
        backend: { type: "none" },
      },
      backend,
      { info() {}, warn() {}, error() {} },
    );
    assert.equal(result.errors.length, 0, result.errors.join("\n"));
    assert.notEqual(epoch(memoryDir), before);
    assert.equal(await readFile(notePath, "utf8"), "![img](remote/image.png)\n");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("dedupe-exact deletes a duplicate fact and moves the mention epoch", async () => {
  const memoryDir = await tempDir("engram-epoch-dedupe-");
  const body = "\nHarbor lights stay amber after dusk.\n";
  try {
    const factsDir = path.join(memoryDir, "facts", "2026-10-10");
    await mkdir(factsDir, { recursive: true });
    const keep = path.join(factsDir, "fact-keep.md");
    const drop = path.join(factsDir, "fact-drop.md");
    const doc = (id: string, confidence: string) =>
      [
        "---",
        `id: ${id}`,
        "category: fact",
        `confidence: ${confidence}`,
        "created: 2026-10-10T00:00:00.000Z",
        "updated: 2026-10-10T00:00:00.000Z",
        "---",
        body,
      ].join("\n");
    await writeFile(keep, doc("fact-keep", "0.9"), "utf8");
    await writeFile(drop, doc("fact-drop", "0.2"), "utf8");

    const children = new Map<string, CliNode>();
    const program = {
      command(name: string) {
        return commandNode(name, children);
      },
    };
    registerCli(
      {
        registerCli(handler) {
          handler({ program } as never, { commands: [] });
        },
      } as never,
      { config: parseConfig({ memoryDir, openaiApiKey: "sk-test" }) } as never,
    );
    const action = children.get("engram")?.children.get("dedupe-exact")?.action;
    assert.equal(typeof action, "function");
    const before = epoch(memoryDir);
    const originalLog = console.log;
    console.log = () => {};
    try {
      await action?.({});
    } finally {
      console.log = originalLog;
    }
    assert.notEqual(epoch(memoryDir), before);
    await assert.rejects(readFile(drop, "utf8"));
    assert.match(await readFile(keep, "utf8"), /Harbor lights stay amber/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

interface CliNode {
  children: Map<string, CliNode>;
  action?: (...args: unknown[]) => Promise<void>;
}

function commandNode(name: string, siblings: Map<string, CliNode>): CliNode {
  const node: CliNode = { children: new Map() };
  siblings.set(name, node);
  const proxy = new Proxy(node, {
    get(target, prop) {
      if (prop === "command") {
        return (child: string) => commandNode(child, target.children);
      }
      if (prop === "action") {
        return (handler: (...args: unknown[]) => Promise<void>) => {
          target.action = handler;
          return proxy;
        };
      }
      return () => proxy;
    },
  });
  return proxy;
}

test("preference drift keep stamps metadata and leaves the mention epoch in place", async () => {
  const dir = await tempDir("engram-epoch-drift-");
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const written = await storage.writeMemory(
      "preference",
      "The operator prefers terse status updates.",
      { source: "extraction" },
    );
    const before = epoch(dir);
    const result = await resolvePreferenceDrift(
      storage,
      { pairId: "pair-epoch", memoryIds: [written.id, "evidence-not-loaded"] },
      "keep",
    );
    assert.equal(result.affectedIds[0], written.id);
    assert.equal(epoch(dir), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("procedure-library repair stamps leave the mention epoch in place", async () => {
  const dir = await tempDir("engram-epoch-procedure-");
  const now = new Date("2026-08-18T12:00:00.000Z");
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const record: CausalTrajectoryRecord = {
      schemaVersion: 1,
      trajectoryId: "traj-epoch",
      recordedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      sessionKey: "session-epoch",
      goal: "Keep procedures healthy",
      actionSummary: "Ran deploy_cli then tailed logs.",
      observationSummary: "The run produced reusable signal.",
      outcomeKind: "success",
      outcomeSummary: "Done.",
    };
    await recordCausalTrajectory({ memoryDir: dir, record });
    const procedures = path.join(dir, "procedures");
    await mkdir(procedures, { recursive: true });
    const body = buildProcedurePersistBody("When you work on goals like: migrate the ledger", [
      { order: 1, intent: "Run the migration", toolCall: { kind: "ghost_tool", signature: "ghost --run" } },
    ]);
    await writeFile(
      path.join(procedures, "proc-stale.md"),
      [
        "---",
        "id: proc-stale",
        "category: procedure",
        "status: active",
        `created: ${now.toISOString()}`,
        `updated: ${now.toISOString()}`,
        "source: procedure-miner",
        "confidence: 0.8",
        "tags: []",
        "---",
        "",
        body,
        "",
      ].join("\n"),
      "utf8",
    );
    const before = epoch(dir);
    const report = await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: parseConfig({
        openaiApiKey: "sk-test",
        memoryDir: dir,
        procedural: { enabled: true, lookbackDays: 14, maintenance: { enabled: true } },
      }),
      apply: true,
      now,
    });
    assert.equal(report.proposed.some((action) => action.action === "flag_repair"), true);
    assert.equal(epoch(dir), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review-deck undo moves the mention epoch", async () => {
  const memoryDir = await tempDir("engram-epoch-deck-");
  try {
    await mkdir(path.join(memoryDir, "review"), { recursive: true });
    const id = "deck-epoch";
    const filePath = path.join(memoryDir, "review", `${id}.md`);
    const content = [
      "---",
      `id: ${id}`,
      "category: fact",
      "confidence: 0.4",
      "confidenceTier: low",
      "source: test",
      "created: 2026-05-17T00:00:00.000Z",
      "reviewReason: low_confidence",
      "lifecycleState: pending_review",
      "status: pending_review",
      "---",
      "Candidate memory.",
      "",
    ].join("\n");
    await writeFile(filePath, content, "utf8");
    const events: unknown[] = [];
    const ctx: ReviewDeckMutationContext = {
      memoryDir,
      namespace: "ns-test",
      principalDigest: "prin-test",
      async appendLifecycleEvents(next) {
        events.push(...next);
      },
      async readLifecycleEvents() {
        return events;
      },
    };
    const { readReviewDeckRow } = await import("../packages/remnic-core/src/review/review-deck-snapshot.js");
    const row = readReviewDeckRow({ memoryDir, itemId: id });
    assert.ok(row);
    const kept = await executeReviewDeckAction(ctx, {
      schemaVersion: 1,
      itemId: id,
      revision: row.revision,
      action: "keep",
      idempotencyKey: "deck-epoch-keep",
    });
    const before = epoch(memoryDir);
    const undone = await executeReviewDeckUndo(ctx, {
      schemaVersion: 1,
      receiptId: kept.receiptId,
      expectedRevision: kept.appliedRevision ?? "",
      idempotencyKey: "deck-epoch-undo",
    });
    assert.equal(undone.outcome, "applied");
    assert.notEqual(epoch(memoryDir), before);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
