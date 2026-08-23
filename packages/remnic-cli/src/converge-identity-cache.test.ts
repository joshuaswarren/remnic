import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ReconcileManifest } from "@remnic/core/reconcile/manifest.js";
import { loadConvergeIdentityCache, saveConvergeIdentityCache } from "./converge-identity-cache.js";

const TEMPLATE = "Source: {{source}}";
const HASH_A = "a".repeat(64);

function manifest(): ReconcileManifest {
  return {
    format: "remnic-reconcile-manifest",
    schemaVersion: 1,
    files: [
      {
        path: "facts/a.md",
        sha256: "aa",
        mtimeMs: 1,
        bytes: 2,
        memory: {
          id: "a",
          category: "fact",
          contentHash: HASH_A,
          normalizerVersion: 4,
          identityResolutionVersion: 2,
          status: "active",
        },
      },
      { path: "facts/no-identity.md", sha256: "bb", mtimeMs: 1, bytes: 2 },
    ],
  } as ReconcileManifest;
}

async function withCacheFile(run: (cachePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "converge-identity-cache-"));
  try {
    await run(path.join(dir, "nested", "identity.json"));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

test("a saved cache round-trips only the entries that carry an identity", async () => {
  await withCacheFile(async (cachePath) => {
    await saveConvergeIdentityCache(cachePath, manifest(), TEMPLATE);
    const loaded = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    assert.deepEqual([...loaded.keys()], ["facts/a.md"]);
    assert.equal(loaded.get("facts/a.md")?.memory?.contentHash, HASH_A);
  });
});

test("a cache written under a different citation template is discarded", async () => {
  await withCacheFile(async (cachePath) => {
    await saveConvergeIdentityCache(cachePath, manifest(), TEMPLATE);
    const loaded = await loadConvergeIdentityCache(cachePath, "Cited from {{source}}");
    assert.equal(loaded.size, 0);
  });
});

test("entries with a malformed identity are dropped, not handed to the hit path", async () => {
  await withCacheFile(async (cachePath) => {
    await saveConvergeIdentityCache(cachePath, manifest(), TEMPLATE);
    const raw = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as {
      citationTemplate: string;
      files: unknown[];
    };
    raw.files.push({ path: "facts/null.md", sha256: "cc", memory: null });
    raw.files.push({ path: "facts/partial.md", sha256: "dd", memory: { id: "p" } });
    raw.files.push({
      path: "facts/bad-hash.md",
      sha256: "ff",
      memory: { id: "b", category: "fact", contentHash: "not-a-hash", status: "active" },
    });
    raw.files.push({ sha256: "ee" });
    await fs.promises.writeFile(cachePath, JSON.stringify(raw));

    const loaded = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    assert.deepEqual([...loaded.keys()], ["facts/a.md"]);
  });
});

test("a missing or corrupt cache loads empty rather than throwing", async () => {
  await withCacheFile(async (cachePath) => {
    assert.equal((await loadConvergeIdentityCache(cachePath, TEMPLATE)).size, 0);
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.promises.writeFile(cachePath, "{not json");
    assert.equal((await loadConvergeIdentityCache(cachePath, TEMPLATE)).size, 0);
    assert.equal((await loadConvergeIdentityCache(undefined, TEMPLATE)).size, 0);
  });
});

test("an unchanged warm run does not rewrite the cache file", async () => {
  await withCacheFile(async (cachePath) => {
    await saveConvergeIdentityCache(cachePath, manifest(), TEMPLATE);
    const loaded = await loadConvergeIdentityCache(cachePath, TEMPLATE);

    // Marker: if the next save rewrites the file, the marker disappears.
    const raw = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as Record<string, unknown>;
    raw.marker = "untouched";
    await fs.promises.writeFile(cachePath, JSON.stringify(raw));

    // Rebuild the manifest from the loaded entries the way a warm
    // buildReconcileManifest run does: same memory object references.
    const warmManifest: ReconcileManifest = {
      ...manifest(),
      files: manifest().files.map((file) =>
        file.memory === undefined ? file : { ...file, memory: loaded.get(file.path)?.memory ?? file.memory }
      ),
    };
    await saveConvergeIdentityCache(cachePath, warmManifest, TEMPLATE, loaded);

    const after = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as Record<string, unknown>;
    assert.equal(after.marker, "untouched", "an unchanged cache must not be rewritten");

    // A real change (a rebuilt identity gets a fresh object) must still write.
    const changedManifest: ReconcileManifest = {
      ...warmManifest,
      files: warmManifest.files.map((file) =>
        file.memory === undefined ? file : { ...file, memory: { ...file.memory, contentHash: "f".repeat(64) } }
      ),
    };
    await saveConvergeIdentityCache(cachePath, changedManifest, TEMPLATE, loaded);
    const afterChange = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as Record<string, unknown>;
    assert.equal(afterChange.marker, undefined, "a changed cache must be rewritten");
    assert.equal(afterChange.files?.length, 1);
  });
});
