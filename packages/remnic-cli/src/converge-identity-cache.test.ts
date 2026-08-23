import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ReconcileManifest } from "@remnic/core/reconcile/manifest.js";
import { loadConvergeIdentityCache, saveConvergeIdentityCache, type ConvergeIdentityCacheEntry } from "./converge-identity-cache.js";

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

test("a saved cache round-trips every file, identity or not", async () => {
  await withCacheFile(async (cachePath) => {
    await saveConvergeIdentityCache(cachePath, manifest(), TEMPLATE);
    const loaded = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    assert.deepEqual([...loaded.keys()], ["facts/a.md", "facts/no-identity.md"]);
    assert.equal(loaded.get("facts/a.md")?.memory?.contentHash, HASH_A);
    assert.equal(loaded.get("facts/no-identity.md")?.memory, undefined);
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
    raw.files.push({ path: "facts/no-identity.md", sha256: "bb" }); // benign: sha-only entry, no memory
    raw.files.push({ path: "facts/partial.md", sha256: "dd", memory: { id: "p" } });
    raw.files.push({
      path: "facts/bad-hash.md",
      sha256: "ff",
      memory: { id: "b", category: "fact", contentHash: "not-a-hash", status: "active" },
    });
    raw.files.push({ sha256: "ee" });
    await fs.promises.writeFile(cachePath, JSON.stringify(raw));

    const loaded = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    assert.deepEqual([...loaded.keys()], ["facts/a.md", "facts/no-identity.md"]);
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
      files: manifest().files.map((file) => {
        const cached = loaded.get(file.path);
        if (cached === undefined) return file;
        return { path: file.path, sha256: cached.sha256, mtimeMs: file.mtimeMs, bytes: file.bytes, ...(cached.memory ? { memory: cached.memory } : {}) };
      }),
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
    const afterChange = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as {
      files?: unknown[];
      marker?: string;
    };
    assert.equal(afterChange.marker, undefined, "a changed cache must be rewritten");
    assert.equal(afterChange.files?.length, 2);
  });
});

test("negative identity results persist so warm runs skip them too", async () => {
  await withCacheFile(async (cachePath) => {
    const withNegative: ReconcileManifest = {
      ...manifest(),
      files: [
        ...manifest().files,
        {
          path: "facts/no-identity.md",
          sha256: "c".repeat(64),
          mtimeMs: 2,
          bytes: 3,
          normalizerVersion: 4,
          identityResolutionVersion: 2,
        },
      ],
    };
    await saveConvergeIdentityCache(cachePath, withNegative, TEMPLATE);
    const loaded = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    assert.ok(loaded.has("facts/no-identity.md"), "a sha-only entry must persist");
    assert.equal(loaded.get("facts/no-identity.md")?.memory, undefined);
    assert.equal(loaded.get("facts/no-identity.md")?.normalizerVersion, 4);
    assert.equal(loaded.get("facts/no-identity.md")?.identityResolutionVersion, 2);
  });
});

test("classifications persist onto entries and skip the rewrite when unchanged", async () => {
  await withCacheFile(async (cachePath) => {
    await saveConvergeIdentityCache(cachePath, manifest(), TEMPLATE);
    const loaded = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    const classifications = new Map([
      ["facts/a.md", { statIdentity: "1:2:3:4:5", excluded: false }],
      ["facts/no-identity.md", { statIdentity: "1:2:9:4:5", excluded: false }],
    ]);

    // Built from the loaded references the way a warm run rebuilds a manifest.
    const buildFrom = (from: ReadonlyMap<string, ConvergeIdentityCacheEntry>): ReconcileManifest => ({
      ...manifest(),
      files: [
        {
          path: "facts/a.md",
          sha256: "aa",
          mtimeMs: 1,
          bytes: 2,
          ...(from.get("facts/a.md")?.memory ? { memory: from.get("facts/a.md")!.memory } : {}),
        },
        { path: "facts/no-identity.md", sha256: "c".repeat(64), mtimeMs: 2, bytes: 3 },
      ],
    });
    const withClassification = buildFrom(loaded);
    await saveConvergeIdentityCache(cachePath, withClassification, TEMPLATE, loaded, classifications);
    const persisted = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    assert.equal(persisted.get("facts/a.md")?.statIdentity, "1:2:3:4:5");
    assert.equal(persisted.get("facts/a.md")?.excluded, false);
    assert.equal(persisted.get("facts/no-identity.md")?.excluded, false);

    // Unchanged classifications on an unchanged manifest: no rewrite.
    const raw = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as Record<string, unknown>;
    raw.marker = "untouched";
    await fs.promises.writeFile(cachePath, JSON.stringify(raw));
    const reload = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    await saveConvergeIdentityCache(cachePath, buildFrom(reload), TEMPLATE, reload, classifications);
    const after = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as Record<string, unknown>;
    assert.equal(after.marker, "untouched", "identical classifications must not rewrite the cache");
  });
});

test("a completed save does not resurrect a path the manifest dropped", async () => {
  await withCacheFile(async (cachePath) => {
    await saveConvergeIdentityCache(cachePath, manifest(), TEMPLATE);
    const loaded = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    assert.ok(loaded.has("facts/no-identity.md"));

    const withoutDeleted: ReconcileManifest = {
      ...manifest(),
      files: manifest().files.filter((file) => file.path !== "facts/no-identity.md"),
    };
    await saveConvergeIdentityCache(cachePath, withoutDeleted, TEMPLATE, loaded);
    const after = await loadConvergeIdentityCache(cachePath, TEMPLATE);
    assert.equal(after.has("facts/no-identity.md"), false, "a deleted path must stay out of the cache");
    assert.ok(after.has("facts/a.md"));
  });
});

