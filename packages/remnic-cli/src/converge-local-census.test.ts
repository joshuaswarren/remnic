import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "@remnic/core";
import { convergeIdentityCachePath } from "@remnic/core/reconcile/cursor.js";

import { loadConvergeIdentityCache } from "./converge-identity-cache.js";
import { planLocalNamespaceCensus } from "./converge-local-census.js";

const TEMPLATE = "Source: {{source}}";

test("a warm census reuses persisted exclusions without re-reading files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "converge-local-census-excl-"));
  const originalRead = StorageManager.prototype.readMemoryByPath;
  try {
    const storage = new StorageManager(memoryDir);
    const publicWrite = await storage.writeMemory("fact", "The office opens at nine.", {
      source: "test",
      confidence: 1,
    });
    const privateWrite = await storage.writeMemory("preference", "Offer a quiet place.", {
      source: "support-passport",
      tags: ["support-passport-card"],
      confidence: 1,
    });
    const publicRel = path.relative(memoryDir, publicWrite.memory.path).split(path.sep).join("/");
    const privateRel = path.relative(memoryDir, privateWrite.memory.path).split(path.sep).join("/");
    const args = {
      rootDir: memoryDir,
      namespace: "default",
      index: 1,
      total: 1,
      citationTemplate: TEMPLATE,
      cache: null,
      memoryDir,
      peerUrl: "local",
    };

    await planLocalNamespaceCensus(args);

    const persisted = await loadConvergeIdentityCache(
      convergeIdentityCachePath(memoryDir, "local", "default"),
      TEMPLATE
    );
    assert.equal(typeof persisted.get(publicRel)?.statIdentity, "string");
    assert.equal(persisted.get(publicRel)?.excluded, false);

    let publicReads = 0;
    StorageManager.prototype.readMemoryByPath = async function (filePath: string) {
      if (path.resolve(filePath) === path.resolve(publicWrite.memory.path)) publicReads += 1;
      return originalRead.call(this, filePath);
    };

    const warm = await planLocalNamespaceCensus(args);
    assert.equal(publicReads, 0, "a matching persisted exclusion must not re-read the file");
    assert.equal(
      warm.files.some((file) => file.path === privateRel),
      false,
      "private support-passport files stay excluded"
    );
    assert.ok(warm.files.some((file) => file.path === publicRel));
  } finally {
    StorageManager.prototype.readMemoryByPath = originalRead;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("local census excludes transcripts so it matches the peer apply contract", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "converge-local-census-tx-"));
  try {
    const storage = new StorageManager(memoryDir);
    const fact = await storage.writeMemory("fact", "The office opens at nine.", {
      source: "test",
      confidence: 1,
    });
    const factRel = path.relative(memoryDir, fact.memory.path).split(path.sep).join("/");
    await mkdir(path.join(memoryDir, "transcripts"), { recursive: true });
    await writeFile(path.join(memoryDir, "transcripts", "session.jsonl"), '{"ok":true}\n');

    const census = await planLocalNamespaceCensus({
      rootDir: memoryDir,
      namespace: "default",
      index: 1,
      total: 1,
      citationTemplate: TEMPLATE,
      cache: null,
      memoryDir,
      peerUrl: "local",
    });

    assert.ok(census.files.some((file) => file.path === factRel));
    assert.equal(
      census.files.some((file) => file.path.split("/")[0] === "transcripts"),
      false,
      "transcripts must stay out of the local census"
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
