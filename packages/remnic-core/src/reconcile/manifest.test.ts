import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ContentHashIndex } from "../storage/content-hash-index.js";
import { type ReconcileManifest, buildReconcileManifest, collapseActiveFactDuplicates } from "./manifest.js";
import { planReconciliation } from "./plan.js";

const fileHash = (content: string): string => createHash("sha256").update(content).digest("hex");

function memoryFile(options: {
  id: string;
  content: string;
  contentHash?: string;
  status?: string;
}): string {
  return [
    "---",
    `id: ${options.id}`,
    "category: fact",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    ...(options.contentHash ? [`contentHash: ${options.contentHash}`] : []),
    ...(options.status ? [`status: ${options.status}`] : []),
    "---",
    options.content,
  ].join("\n");
}

test("reconcile manifest keeps file identity separate from canonical semantic identity", async () => {
  const content = "The deployment uses a durable queue with an enrichment suffix.";
  const semanticHash = ContentHashIndex.computeHash("The deployment uses a durable queue.");
  const serialized = memoryFile({ id: "fact-a", content, contentHash: semanticHash, status: "active" });
  const serializedHash = fileHash(serialized);

  const manifest = await buildReconcileManifest({
    files: [{ path: "facts/fact-a.md", sha256: serializedHash, bytes: Buffer.byteLength(serialized) }],
    readFile: async () => Buffer.from(serialized),
  });

  assert.equal(manifest.format, "remnic-reconcile-manifest");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.files[0]?.sha256, serializedHash);
  assert.notEqual(serializedHash, semanticHash);
  assert.deepEqual(manifest.files[0]?.memory, {
    id: "fact-a",
    category: "fact",
    contentHash: semanticHash,
    status: "active",
  });
});

test("reconcile manifest hashes parsed legacy content and uses effective lifecycle status", async () => {
  const active = memoryFile({ id: "legacy", content: "Legacy fact body" });
  const archived = memoryFile({ id: "archived", content: "Archived fact body", status: "active" });
  const rawByPath = new Map([
    ["facts/legacy.md", Buffer.from(active)],
    ["archive/facts/archived.md", Buffer.from(archived)],
  ]);

  const manifest = await buildReconcileManifest({
    files: [...rawByPath].map(([path, raw]) => ({ path, sha256: fileHash(raw.toString()) })),
    readFile: async (file) => rawByPath.get(file.path) ?? null,
  });

  assert.equal(manifest.files[0]?.memory?.contentHash, ContentHashIndex.computeHash("Archived fact body"));
  assert.equal(manifest.files[0]?.memory?.status, "archived");
  assert.equal(manifest.files[1]?.memory?.contentHash, ContentHashIndex.computeHash("Legacy fact body"));
  assert.equal(manifest.files[1]?.memory?.status, "active");
});

test("reconcile manifest keeps file identity when memory bytes cannot be trusted", async () => {
  const readable = memoryFile({ id: "readable", content: "Readable fact" });
  const changed = memoryFile({ id: "changed", content: "Changed after census" });
  const files = [
    { path: "facts/readable.md", sha256: fileHash(readable) },
    { path: "facts/locked.md", sha256: "f".repeat(64) },
    { path: "facts/changed.md", sha256: fileHash("bytes from census") },
  ];

  const manifest = await buildReconcileManifest({
    files,
    readFile: async (file) => {
      if (file.path === "facts/locked.md") throw new Error("locked");
      return file.path === "facts/changed.md" ? changed : readable;
    },
  });

  assert.equal(manifest.files.length, 3);
  assert.equal(manifest.files.find((file) => file.path === "facts/readable.md")?.memory?.id, "readable");
  assert.equal(manifest.files.find((file) => file.path === "facts/locked.md")?.memory, undefined);
  assert.equal(manifest.files.find((file) => file.path === "facts/changed.md")?.memory, undefined);
});

test("ContentHashIndex resolves a semantic hash to a stable canonical path without changing membership", () => {
  const semanticHash = ContentHashIndex.computeHash("same fact");
  const entries = [
    { path: "facts/z.md", contentHash: semanticHash },
    { path: "facts/a.md", contentHash: semanticHash },
    { path: "facts/other.md", contentHash: ContentHashIndex.computeHash("other fact") },
  ];
  const index = new ContentHashIndex("unused");

  assert.equal(ContentHashIndex.resolvePathByHash(semanticHash, entries), "facts/a.md");
  assert.equal(ContentHashIndex.resolvePathByHash("f".repeat(64), entries), undefined);
  assert.equal(index.has("same fact"), false);
});

test("semantic collapse prevents different active fact paths from transferring both directions", () => {
  const semanticHash = ContentHashIndex.computeHash("same active fact");
  const localFile = { path: "facts/local-id.md", sha256: "a".repeat(64) };
  const peerFile = { path: "facts/peer-id.md", sha256: "b".repeat(64) };
  const plan = planReconciliation([{ namespace: "default", local: [localFile], peer: [peerFile] }]);
  const local: ReconcileManifest = {
    format: "remnic-reconcile-manifest",
    schemaVersion: 1,
    files: [
      { ...localFile, memory: { id: "local-id", category: "fact", contentHash: semanticHash, status: "active" } },
    ],
  };
  const peer: ReconcileManifest = {
    format: "remnic-reconcile-manifest",
    schemaVersion: 1,
    files: [{ ...peerFile, memory: { id: "peer-id", category: "fact", contentHash: semanticHash, status: "active" } }],
  };

  const collapsed = collapseActiveFactDuplicates(plan, new Map([["default", local]]), new Map([["default", peer]]));

  assert.equal(collapsed.converged, true);
  assert.deepEqual(collapsed.entries, [
    {
      path: "facts/local-id.md",
      namespace: "default",
      action: "identical",
      reason: "semantic_duplicate",
      localSha256: localFile.sha256,
      peerSha256: peerFile.sha256,
    },
  ]);
  assert.equal(collapsed.byNamespace[0]?.identical, 1);
  assert.equal(collapsed.byNamespace[0]?.pull, 0);
  assert.equal(collapsed.byNamespace[0]?.push, 0);
});

test("semantic collapse does not fold non-active facts or unrelated path conflicts", () => {
  const semanticHash = ContentHashIndex.computeHash("same inactive fact");
  const localFile = { path: "facts/local.md", sha256: "a".repeat(64) };
  const peerFile = { path: "facts/peer.md", sha256: "b".repeat(64) };
  const plan = planReconciliation([{ namespace: "default", local: [localFile], peer: [peerFile] }]);
  const manifest = (file: typeof localFile, id: string, status: "active" | "archived"): ReconcileManifest => ({
    format: "remnic-reconcile-manifest",
    schemaVersion: 1,
    files: [{ ...file, memory: { id, category: "fact", contentHash: semanticHash, status } }],
  });

  const collapsed = collapseActiveFactDuplicates(
    plan,
    new Map([["default", manifest(localFile, "local", "active")]]),
    new Map([["default", manifest(peerFile, "peer", "archived")]])
  );

  assert.deepEqual(collapsed, plan);
});

test("semantic collapse leaves tombstone suppression authoritative", () => {
  const semanticHash = ContentHashIndex.computeHash("retracted fact");
  const localFile = { path: "facts/local.md", sha256: "a".repeat(64) };
  const peerFile = { path: "facts/peer.md", sha256: "b".repeat(64) };
  const plan = planReconciliation([
    {
      namespace: "default",
      local: [localFile],
      peer: [peerFile],
      tombstonedFileSha256: [localFile.sha256],
    },
  ]);
  const manifest = (file: typeof localFile, id: string): ReconcileManifest => ({
    format: "remnic-reconcile-manifest",
    schemaVersion: 1,
    files: [{ ...file, memory: { id, category: "fact", contentHash: semanticHash, status: "active" } }],
  });

  const collapsed = collapseActiveFactDuplicates(
    plan,
    new Map([["default", manifest(localFile, "local")]]),
    new Map([["default", manifest(peerFile, "peer")]])
  );

  assert.deepEqual(collapsed, plan);
  assert.equal(
    collapsed.entries.some((entry) => entry.action === "suppress"),
    true
  );
});

test("semantic collapse preserves same-path metadata updates", () => {
  const path = "facts/shared.md";
  const localFile = { path, sha256: "a".repeat(64) };
  const peerFile = { path, sha256: "b".repeat(64) };
  const baseFile = { path, sha256: peerFile.sha256 };
  const semanticHash = ContentHashIndex.computeHash("same raw fact");
  const plan = planReconciliation([{ namespace: "default", local: [localFile], peer: [peerFile], base: [baseFile] }]);
  const manifest = (file: typeof localFile, id: string): ReconcileManifest => ({
    format: "remnic-reconcile-manifest",
    schemaVersion: 1,
    files: [{ ...file, memory: { id, category: "fact", contentHash: semanticHash, status: "active" } }],
  });

  const collapsed = collapseActiveFactDuplicates(
    plan,
    new Map([["default", manifest(localFile, "local")]]),
    new Map([["default", manifest(peerFile, "peer")]])
  );

  assert.deepEqual(collapsed, plan);
  assert.equal(collapsed.entries[0]?.action, "push");
});

test("semantic collapse remains converged after transferring the canonical one-sided duplicate", () => {
  const semanticHash = ContentHashIndex.computeHash("same one-sided fact");
  const canonical = { path: "facts/a.md", sha256: "a".repeat(64) };
  const duplicate = { path: "facts/b.md", sha256: "b".repeat(64) };
  const manifest = (files: Array<{ path: string; sha256: string }>): ReconcileManifest => ({
    format: "remnic-reconcile-manifest",
    schemaVersion: 1,
    files: files.map((file) => ({
      ...file,
      memory: {
        id: file.path,
        category: "fact",
        contentHash: semanticHash,
        status: "active",
      },
    })),
  });
  const localManifest = manifest([canonical, duplicate]);
  const firstPlan = planReconciliation([{ namespace: "default", local: [canonical, duplicate], peer: [] }]);

  const firstCollapsed = collapseActiveFactDuplicates(
    firstPlan,
    new Map([["default", localManifest]]),
    new Map([["default", manifest([])]])
  );

  assert.deepEqual(
    firstCollapsed.entries.map((entry) => [entry.path, entry.action]),
    [[canonical.path, "push"]]
  );

  const rerunPlan = planReconciliation([{ namespace: "default", local: [canonical, duplicate], peer: [canonical] }]);
  const rerunCollapsed = collapseActiveFactDuplicates(
    rerunPlan,
    new Map([["default", localManifest]]),
    new Map([["default", manifest([canonical])]])
  );

  assert.equal(rerunCollapsed.converged, true, JSON.stringify(rerunCollapsed));
  assert.deepEqual(
    rerunCollapsed.entries.map((entry) => [entry.path, entry.action]),
    [[canonical.path, "identical"]]
  );
});
