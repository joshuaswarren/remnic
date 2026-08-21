import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { computeLegacyContentHash } from "../content-hash.js";
import { attachCitation, formatCitation } from "../source-attribution.js";
import { parseFrontmatter } from "../storage.js";
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
    parseMemory: parseFrontmatter,
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
    normalizerVersion: 4,
    identityResolutionVersion: 2,
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
    parseMemory: parseFrontmatter,
    readFile: async (file) => rawByPath.get(file.path) ?? null,
  });

  assert.equal(manifest.files[0]?.memory?.contentHash, ContentHashIndex.computeHash("Archived fact body"));
  assert.equal(manifest.files[0]?.memory?.status, "archived");
  assert.equal(manifest.files[1]?.memory?.contentHash, ContentHashIndex.computeHash("Legacy fact body"));
  assert.equal(manifest.files[1]?.memory?.status, "active");
});

test("reconcile manifest reparses cached pre-version identities after Unicode migration", async () => {
  const content = "The user prefers café.";
  const legacyHash = computeLegacyContentHash(content);
  const serialized = memoryFile({ id: "legacy-unicode", content, contentHash: legacyHash });
  const file = { path: "facts/legacy-unicode.md", sha256: fileHash(serialized) };
  let reads = 0;

  const manifest = await buildReconcileManifest({
    files: [file],
    parseMemory: parseFrontmatter,
    readFile: async () => {
      reads += 1;
      return serialized;
    },
    cachedFiles: [{
      ...file,
      memory: {
        id: "legacy-unicode",
        category: "fact",
        contentHash: legacyHash,
        status: "active",
      },
    }],
  });

  assert.equal(reads, 1);
  // The café body is lossy under the legacy normalizer, so the persisted
  // legacy hash stays primary and the recovered current identity rides along
  // as an alias (issue #2367).
  assert.equal(
    manifest.files[0]?.memory?.contentHash,
    legacyHash,
  );
  assert.deepEqual(manifest.files[0]?.memory?.contentHashAliases, [
    ContentHashIndex.computeHash(content),
  ]);
});

test("reconcile manifest reparses cached identities lacking the identity-resolution version", async () => {
  const content = "The user prefers café.";
  const legacyHash = computeLegacyContentHash(content);
  const serialized = memoryFile({ id: "legacy-identity-version", content, contentHash: legacyHash });
  const file = { path: "facts/legacy-identity-version.md", sha256: fileHash(serialized) };
  let reads = 0;

  const manifest = await buildReconcileManifest({
    files: [file],
    parseMemory: parseFrontmatter,
    readFile: async () => {
      reads += 1;
      return serialized;
    },
    // Same normalizerVersion, but written before identity-resolution
    // versioning existed: the entry carries no aliases and must NOT be
    // reused (issue #2367 review round 2).
    cachedFiles: [{
      ...file,
      memory: {
        id: "legacy-identity-version",
        category: "fact",
        contentHash: legacyHash,
        normalizerVersion: 4,
        status: "active",
      },
    }],
  });

  assert.equal(reads, 1);
  assert.equal(manifest.files[0]?.memory?.identityResolutionVersion, 2);
  assert.deepEqual(manifest.files[0]?.memory?.contentHashAliases, [
    ContentHashIndex.computeHash(content),
  ]);
});

test("reconcile manifest replaces a pure-CJK legacy identity with its current hash", async () => {
  const content = "利用者は紅茶を好む。";
  const serialized = memoryFile({
    id: "legacy-cjk",
    content,
    contentHash: computeLegacyContentHash(content),
  });
  const manifest = await buildReconcileManifest({
    files: [{ path: "facts/legacy-cjk.md", sha256: fileHash(serialized) }],
    parseMemory: parseFrontmatter,
    readFile: async () => serialized,
  });

  assert.equal(
    manifest.files[0]?.memory?.contentHash,
    ContentHashIndex.computeHash(content),
  );
  assert.equal("contentHashAliases" in (manifest.files[0]?.memory ?? {}), false);
});

test("reconcile manifest recovers a raw hash source beneath citation and attributes", async () => {
  const content = "The user prefers café.";
  const cited = attachCitation(content, {
    agent: "planner",
    session: "agent:planner:main",
    ts: "2026-08-11T00:00:00.000Z",
  });
  const storedBody = `${cited}\n[Attributes: topic: coffee]`;
  const serialized = memoryFile({
    id: "legacy-enriched",
    content: storedBody,
    contentHash: computeLegacyContentHash(content),
  });
  const manifest = await buildReconcileManifest({
    files: [{ path: "facts/legacy-enriched.md", sha256: fileHash(serialized) }],
    parseMemory: parseFrontmatter,
    readFile: async () => serialized,
  });

  assert.equal(manifest.files[0]?.memory?.contentHash, computeLegacyContentHash(content));
  assert.deepEqual(manifest.files[0]?.memory?.contentHashAliases, [
    ContentHashIndex.computeHash(content),
  ]);
});

test("reconcile manifest recovers raw identity beneath a configured citation", async () => {
  const content = "The user prefers café.";
  const citationTemplate = "[src:{agent}/{sessionId}@{date}]";
  const storedBody = `${content} ${formatCitation({
    agent: "planner",
    session: "agent:planner:main",
    ts: "2026-08-11T00:00:00.000Z",
  }, citationTemplate)}`;
  const serialized = memoryFile({
    id: "legacy-custom-citation",
    content: storedBody,
    contentHash: computeLegacyContentHash(content),
  });
  const manifest = await buildReconcileManifest({
    files: [{ path: "facts/legacy-custom-citation.md", sha256: fileHash(serialized) }],
    parseMemory: parseFrontmatter,
    readFile: async () => serialized,
    citationTemplate,
  });

  assert.equal(manifest.files[0]?.memory?.contentHash, computeLegacyContentHash(content));
  assert.deepEqual(manifest.files[0]?.memory?.contentHashAliases, [
    ContentHashIndex.computeHash(content),
  ]);
});

test("reconcile manifest prefers a persisted explicit hash over a colliding legacy body hash (issue #2367)", async () => {
  // Source `caf` with body `café`: hash("caf") numerically equals the legacy
  // hash of the stored body, but it is the fact's explicit contentHashSource
  // identity written by the current normalizer. The legacy candidate match
  // must not replace it.
  const source = "caf";
  const body = "café";
  const persistedHash = ContentHashIndex.computeHash(source);
  assert.equal(persistedHash, computeLegacyContentHash(body));
  const serialized = memoryFile({ id: "explicit-source", content: body, contentHash: persistedHash });
  const manifest = await buildReconcileManifest({
    files: [{ path: "facts/explicit-source.md", sha256: fileHash(serialized) }],
    parseMemory: parseFrontmatter,
    readFile: async () => serialized,
  });

  assert.equal(manifest.files[0]?.memory?.contentHash, persistedHash);
  assert.notEqual(manifest.files[0]?.memory?.contentHash, ContentHashIndex.computeHash(body));
  assert.deepEqual(manifest.files[0]?.memory?.contentHashAliases, [
    ContentHashIndex.computeHash(body),
  ]);
});

test("reconcile collapse matches an explicit-source replica through the persisted hash (issue #2367)", async () => {
  const source = "caf";
  const persistedHash = ContentHashIndex.computeHash(source);
  const localSerialized = memoryFile({ id: "explicit-local", content: "café", contentHash: persistedHash });
  const peerSerialized = memoryFile({ id: "explicit-peer", content: source, contentHash: persistedHash });
  const localFile = { path: "facts/explicit-local.md", sha256: fileHash(localSerialized) };
  const peerFile = { path: "facts/explicit-peer.md", sha256: fileHash(peerSerialized) };
  const build = async (file: typeof localFile, raw: string) =>
    await buildReconcileManifest({
      files: [file],
      parseMemory: parseFrontmatter,
      readFile: async () => raw,
    });
  const local = await build(localFile, localSerialized);
  const peer = await build(peerFile, peerSerialized);
  const plan = planReconciliation([{ namespace: "default", local: [localFile], peer: [peerFile] }]);

  const collapsed = collapseActiveFactDuplicates(
    plan,
    new Map([["default", local]]),
    new Map([["default", peer]]),
  );

  assert.equal(collapsed.converged, true);
  assert.equal(collapsed.entries.length, 1);
  assert.equal(collapsed.entries[0]?.reason, "semantic_duplicate");
});

test("reconcile manifest does not collapse distinct pure-CJK legacy facts through the empty skeleton (issue #2367)", async () => {
  const first = "利用者は紅茶を好む。";
  const second = "利用者は珈琲を好む。";
  assert.equal(computeLegacyContentHash(first), computeLegacyContentHash(second));
  const build = async (id: string, content: string) => {
    const serialized = memoryFile({ id, content, contentHash: computeLegacyContentHash(content) });
    const file = { path: `facts/${id}.md`, sha256: fileHash(serialized) };
    const manifest = await buildReconcileManifest({
      files: [file],
      parseMemory: parseFrontmatter,
      readFile: async () => serialized,
    });
    return { file, manifest };
  };
  const a = await build("legacy-cjk-first", first);
  const b = await build("legacy-cjk-second", second);
  const plan = planReconciliation([
    { namespace: "default", local: [a.file], peer: [b.file] },
  ]);

  const collapsed = collapseActiveFactDuplicates(
    plan,
    new Map([["default", a.manifest]]),
    new Map([["default", b.manifest]]),
  );

  assert.equal(collapsed.converged, false);
  assert.equal(collapsed.entries.length, 2);
});

test("reconcile manifest does not add a legacy alias to a current Unicode identity", async () => {
  const unicode = "The user prefers café.";
  const ascii = "The user prefers caf.";
  const serialized = memoryFile({
    id: "current-unicode",
    content: unicode,
    contentHash: ContentHashIndex.computeHash(unicode),
  });
  const manifest = await buildReconcileManifest({
    files: [{ path: "facts/current-unicode.md", sha256: fileHash(serialized) }],
    parseMemory: parseFrontmatter,
    readFile: async () => serialized,
  });

  assert.notEqual(
    manifest.files[0]?.memory?.contentHash,
    ContentHashIndex.computeHash(ascii),
  );
  assert.equal("contentHashAliases" in (manifest.files[0]?.memory ?? {}), false);
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
    parseMemory: parseFrontmatter,
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
      semanticAgreement: {
        local: localFile,
        peer: peerFile,
      },
      semanticChange: "unchanged",
    },
  ]);
  assert.equal(collapsed.byNamespace[0]?.identical, 1);
  assert.equal(collapsed.byNamespace[0]?.pull, 0);
  assert.equal(collapsed.byNamespace[0]?.push, 0);
});

test("semantic collapse matches legacy and current Unicode identities across replicas", async () => {
  const content = "The user prefers café.";
  const localSerialized = memoryFile({
    id: "legacy-id",
    content,
    contentHash: computeLegacyContentHash(content),
  });
  const peerSerialized = memoryFile({
    id: "current-id",
    content,
    contentHash: ContentHashIndex.computeHash(content),
  });
  const localFile = { path: "facts/legacy-id.md", sha256: fileHash(localSerialized) };
  const peerFile = { path: "facts/current-id.md", sha256: fileHash(peerSerialized) };
  const build = async (file: typeof localFile, raw: string) =>
    await buildReconcileManifest({
      files: [file],
      parseMemory: parseFrontmatter,
      readFile: async () => raw,
    });
  const local = await build(localFile, localSerialized);
  const peer = await build(peerFile, peerSerialized);
  const plan = planReconciliation([{ namespace: "default", local: [localFile], peer: [peerFile] }]);

  const collapsed = collapseActiveFactDuplicates(
    plan,
    new Map([["default", local]]),
    new Map([["default", peer]]),
  );

  assert.equal(collapsed.converged, true);
  assert.equal(collapsed.entries.length, 1);
  assert.equal(collapsed.entries[0]?.reason, "semantic_duplicate");
});

test("semantic collapse classifies a later one-sided metadata edit from its per-side base", () => {
  const semanticHash = ContentHashIndex.computeHash("same active fact");
  const priorLocal = { path: "facts/local-id.md", sha256: "a".repeat(64) };
  const currentLocal = { ...priorLocal, sha256: "c".repeat(64) };
  const peerFile = { path: "facts/peer-id.md", sha256: "b".repeat(64) };
  const manifest = (file: typeof currentLocal): ReconcileManifest => ({
    format: "remnic-reconcile-manifest",
    schemaVersion: 1,
    files: [{
      ...file,
      memory: {
        id: file.path,
        category: "fact",
        contentHash: semanticHash,
        status: "active",
      },
    }],
  });
  const plan = planReconciliation([{
    namespace: "default",
    local: [currentLocal],
    peer: [peerFile],
  }]);

  const collapsed = collapseActiveFactDuplicates(
    plan,
    new Map([["default", manifest(currentLocal)]]),
    new Map([["default", manifest(peerFile)]]),
    new Map([["default", [{ local: priorLocal, peer: peerFile }]]])
  );

  assert.deepEqual(collapsed.entries, [{
    path: currentLocal.path,
    namespace: "default",
    action: "identical",
    reason: "semantic_duplicate",
    semanticAgreement: {
      local: currentLocal,
      peer: peerFile,
    },
    semanticChange: "local_changed",
  }]);
  assert.equal(collapsed.converged, true);
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

test("semantic collapse preserves a shared-path metadata update when peer canonical path differs", () => {
  const semanticHash = ContentHashIndex.computeHash("same raw fact");
  const sharedLocal = { path: "facts/b.md", sha256: "a".repeat(64) };
  const sharedPeer = { path: "facts/b.md", sha256: "b".repeat(64) };
  const peerDuplicate = { path: "facts/a.md", sha256: "c".repeat(64) };
  const plan = planReconciliation([{
    namespace: "default",
    local: [sharedLocal],
    peer: [peerDuplicate, sharedPeer],
    base: [{ path: sharedPeer.path, sha256: sharedPeer.sha256 }],
  }]);
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

  const collapsed = collapseActiveFactDuplicates(
    plan,
    new Map([["default", manifest([sharedLocal])]]),
    new Map([["default", manifest([peerDuplicate, sharedPeer])]])
  );

  assert.deepEqual(collapsed.entries, [{
    path: sharedLocal.path,
    namespace: "default",
    action: "push",
    reason: "local_changed",
    localSha256: sharedLocal.sha256,
    peerSha256: sharedPeer.sha256,
    baseSha256: sharedPeer.sha256,
  }]);
  assert.equal(collapsed.converged, false);
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
