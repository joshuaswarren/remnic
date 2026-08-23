import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";
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
  const valid = { id: "a", category: "fact", contentHash: "abc", status: "active" };
  assert.equal(isReconcileMemoryIdentity(valid), true);
  assert.equal(isReconcileMemoryIdentity({ ...valid, contentHashAliases: ["x"] }), true);
  assert.equal(isReconcileMemoryIdentity(null), false);
  assert.equal(isReconcileMemoryIdentity(undefined), false);
  assert.equal(isReconcileMemoryIdentity([valid]), false);
  assert.equal(isReconcileMemoryIdentity({ ...valid, id: 1 }), false);
  assert.equal(isReconcileMemoryIdentity({ ...valid, status: undefined }), false);
  assert.equal(isReconcileMemoryIdentity({ ...valid, normalizerVersion: "4" }), false);
  assert.equal(isReconcileMemoryIdentity({ ...valid, contentHashAliases: [1] }), false);
});
