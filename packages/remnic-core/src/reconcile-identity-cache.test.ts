import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";
import { type ServerIdentityCacheEntry, planServerIdentityCacheWrite } from "./access-offline-manifest.js";
import { isInternalRemnicStatePath } from "./offline-sync.js";
import { convergeIdentityCachePath } from "./reconcile/cursor.js";
import {
  buildReconcileManifest,
  citationTemplateFingerprint,
  isReconcileMemoryIdentity,
} from "./reconcile/manifest.js";
import { parseFrontmatter } from "./storage.js";

function memoryFile(id: string, body: string): string {
  return [
    "---",
    `id: ${id}`,
    "category: fact",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    "status: active",
    "---",
    body,
  ].join("\n");
}

test("converge identity cache path lives beside cursors but in its own dir", () => {
  const p = convergeIdentityCachePath("/tmp/mem", "http://peer", "default");
  assert.ok(p.includes("converge-identity"));
  assert.ok(!p.includes("converge-cursors"));
  assert.ok(path.basename(p).startsWith("identity-"));
});

test("cachedFiles with matching sha skip the content read (warm manifest build)", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "identity-cache-"));
  try {
    const content = memoryFile("warm-1", "warm body");
    const file = path.join(dir, "facts/warm-1.md");
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content);

    const contentSha = createHash("sha256").update(content).digest("hex");
    // First (cold) build reads content and produces identities.
    const cold = await buildReconcileManifest({
      files: [{ path: "facts/warm-1.md", sha256: contentSha, mtimeMs: 1, bytes: content.length }],
      parseMemory: parseFrontmatter,
      readFile: async () => content,
    });
    assert.ok(cold.files[0]?.memory?.id === "warm-1");

    // Warm build with cachedFiles: readFile must NEVER be called.
    let readCalled = false;
    const warm = await buildReconcileManifest({
      files: [{ path: "facts/warm-1.md", sha256: contentSha, mtimeMs: 1, bytes: content.length }],
      parseMemory: parseFrontmatter,
      cachedFiles: cold.files,
      readFile: async () => {
        readCalled = true;
        return content;
      },
    });
    assert.equal(readCalled, false);
    assert.deepEqual(warm.files[0]?.memory, cold.files[0]?.memory);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("a changed sha invalidates the cached identity (cold re-read)", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "identity-cache-"));
  try {
    const contentA = memoryFile("flip-1", "body a");
    const contentB = memoryFile("flip-1", "body b");
    const cold = await buildReconcileManifest({
      files: [
        {
          path: "facts/flip-1.md",
          sha256: createHash("sha256").update(contentA).digest("hex"),
          mtimeMs: 1,
          bytes: contentA.length,
        },
      ],
      parseMemory: parseFrontmatter,
      readFile: async () => contentA,
    });
    let readCalled = false;
    const warm = await buildReconcileManifest({
      files: [
        {
          path: "facts/flip-1.md",
          sha256: createHash("sha256").update(contentB).digest("hex"),
          mtimeMs: 2,
          bytes: contentB.length,
        },
      ],
      parseMemory: parseFrontmatter,
      cachedFiles: cold.files,
      readFile: async () => {
        readCalled = true;
        return contentB;
      },
    });
    assert.equal(readCalled, true);
    assert.ok(warm.files[0]?.memory);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("the server identity cache lives on a path snapshot enumeration excludes", () => {
  // The cache is node-local: enumerating it would advertise it as a peer file
  // and make convergence transfer the cache itself.
  assert.equal(isInternalRemnicStatePath(".remnic/state/converge-identity-cache.json"), true);
  assert.equal(isInternalRemnicStatePath("state/converge-identity-cache.json"), false);
});

test("the CLI identity cache path is excluded from enumeration too", () => {
  const absolute = convergeIdentityCachePath("/tmp/mem", "http://peer", "default");
  const relative = absolute.slice("/tmp/mem/".length);
  assert.equal(isInternalRemnicStatePath(relative), true);
});

test("citation templates fingerprint distinctly and default consistently", () => {
  const fallback = citationTemplateFingerprint(undefined);
  assert.equal(
    citationTemplateFingerprint("{{source}} — {{title}}"),
    citationTemplateFingerprint("{{source}} — {{title}}")
  );
  assert.notEqual(citationTemplateFingerprint("{{source}}"), citationTemplateFingerprint("{{title}}"));
  assert.notEqual(citationTemplateFingerprint("{{source}}"), fallback);
  assert.match(fallback, /^[0-9a-f]{16}$/);
});

test("malformed cached identities are rejected instead of trusted", () => {
  const hash = "a".repeat(64);
  const otherHash = "b".repeat(64);
  const valid = { id: "a", category: "fact", contentHash: hash, status: "active" };
  assert.equal(isReconcileMemoryIdentity(valid), true);
  assert.equal(isReconcileMemoryIdentity({ ...valid, contentHashAliases: [otherHash] }), true);
  assert.equal(isReconcileMemoryIdentity(null), false);
  assert.equal(isReconcileMemoryIdentity(undefined), false);
  assert.equal(isReconcileMemoryIdentity([valid]), false);
  assert.equal(isReconcileMemoryIdentity({ ...valid, id: 1 }), false);
  assert.equal(isReconcileMemoryIdentity({ ...valid, status: undefined }), false);
  assert.equal(isReconcileMemoryIdentity({ ...valid, normalizerVersion: "4" }), false);
  assert.equal(isReconcileMemoryIdentity({ ...valid, contentHashAliases: [1] }), false);
  // A well-typed but non-hash value would be reused without a parse and could
  // shift duplicate decisions, so the guard enforces the producer's format.
  assert.equal(isReconcileMemoryIdentity({ ...valid, contentHash: "not-a-hash" }), false);
  assert.equal(isReconcileMemoryIdentity({ ...valid, contentHashAliases: ["not-a-hash"] }), false);
});

test("a cache miss before a cache hit does not overwrite the hit", async () => {
  const changed = memoryFile("mixed-a", "edited body");
  const unchanged = memoryFile("mixed-b", "stable body");
  const changedSha = createHash("sha256").update(changed).digest("hex");
  const unchangedSha = createHash("sha256").update(unchanged).digest("hex");
  const byPath = new Map([
    ["facts/mixed-a.md", changed],
    ["facts/mixed-b.md", unchanged],
  ]);
  const files = [
    { path: "facts/mixed-a.md", sha256: changedSha, mtimeMs: 2, bytes: changed.length },
    { path: "facts/mixed-b.md", sha256: unchangedSha, mtimeMs: 1, bytes: unchanged.length },
  ];

  const cold = await buildReconcileManifest({
    files,
    parseMemory: parseFrontmatter,
    readFile: async (file) => byPath.get(file.path) ?? null,
  });

  // Warm run where only the FIRST file changed: its rebuild is assigned by
  // input index while the second file is a cache hit.
  const staleSha = createHash("sha256").update("stale").digest("hex");
  const warm = await buildReconcileManifest({
    files,
    parseMemory: parseFrontmatter,
    cachedFiles: [
      { path: "facts/mixed-a.md", sha256: staleSha, mtimeMs: 1, bytes: 1 },
      cold.files.find((file) => file.path === "facts/mixed-b.md")!,
    ],
    readFile: async (file) => byPath.get(file.path) ?? null,
  });

  assert.equal(warm.files.length, 2);
  assert.deepEqual(
    warm.files.map((file) => file.path),
    ["facts/mixed-a.md", "facts/mixed-b.md"]
  );
  assert.equal(
    warm.files.every((file) => file !== undefined),
    true
  );
  assert.equal(warm.files[0]?.memory?.id, "mixed-a");
  assert.equal(warm.files[1]?.memory?.id, "mixed-b");
});

test("the server cache write persists removals and prunes only completed walks", () => {
  const entry = (path: string): ServerIdentityCacheEntry => ({
    path,
    sha256: "c".repeat(64),
    memory: {
      id: path,
      category: "fact",
      contentHash: "d".repeat(64),
      normalizerVersion: 4,
      identityResolutionVersion: 2,
      status: "active",
    },
  });
  const persisted = new Map([
    ["facts/kept.md", entry("facts/kept.md")],
    ["facts/deleted.md", entry("facts/deleted.md")],
  ]);

  // A completed walk that only observed the surviving file must still write,
  // or the deleted file's entry stays on disk forever.
  const pruned = planServerIdentityCacheWrite({
    persisted,
    yieldedPaths: new Set(["facts/kept.md"]),
    streamCompleted: true,
    cacheDirty: false,
  });
  assert.equal(pruned.shouldWrite, true);
  assert.deepEqual(
    pruned.entries.map((e) => e.path),
    ["facts/kept.md"]
  );

  // An entry dropped because its file lost its identity is a mutation even
  // though nothing was rebuilt.
  const lostIdentity = planServerIdentityCacheWrite({
    persisted: new Map([["facts/kept.md", entry("facts/kept.md")]]),
    yieldedPaths: new Set(["facts/kept.md", "facts/lost.md"]),
    streamCompleted: true,
    cacheDirty: true,
  });
  assert.equal(lostIdentity.shouldWrite, true);

  // Nothing changed: no write.
  const unchanged = planServerIdentityCacheWrite({
    persisted,
    yieldedPaths: new Set(["facts/kept.md", "facts/deleted.md"]),
    streamCompleted: true,
    cacheDirty: false,
  });
  assert.equal(unchanged.shouldWrite, false);

  // An aborted walk never prunes, so it can only add.
  const aborted = planServerIdentityCacheWrite({
    persisted,
    yieldedPaths: new Set(["facts/kept.md"]),
    streamCompleted: false,
    cacheDirty: false,
  });
  assert.equal(aborted.shouldWrite, false);
  assert.equal(aborted.entries.length, 2);
});
