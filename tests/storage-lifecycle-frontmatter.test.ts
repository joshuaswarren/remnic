import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { StorageManager } from "@remnic/core/storage";

test("StorageManager parses lifecycle frontmatter fields including zero scores", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-lifecycle-fm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-02-23";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const file = path.join(factDir, "fact-lifecycle-test.md");
    const raw = [
      "---",
      "id: fact-lifecycle-test",
      "category: fact",
      "created: 2026-02-23T01:00:00.000Z",
      "updated: 2026-02-23T01:00:00.000Z",
      "source: test",
      "confidence: 0.9",
      "confidenceTier: implied",
      "tags: [\"policy\"]",
      "lifecycleState: stale",
      "verificationState: system_inferred",
      "policyClass: durable",
      "lastValidatedAt: 2026-02-23T02:00:00.000Z",
      "decayScore: 0",
      "heatScore: 0",
      "---",
      "",
      "lifecycle payload",
      "",
    ].join("\n");
    await writeFile(file, raw, "utf-8");

    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === "fact-lifecycle-test");
    assert.ok(memory);
    assert.equal(memory.frontmatter.lifecycleState, "stale");
    assert.equal(memory.frontmatter.verificationState, "system_inferred");
    assert.equal(memory.frontmatter.policyClass, "durable");
    assert.equal(memory.frontmatter.lastValidatedAt, "2026-02-23T02:00:00.000Z");
    assert.equal(memory.frontmatter.decayScore, 0);
    assert.equal(memory.frontmatter.heatScore, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager serializes parsed lifecycle fields on rewrite", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-lifecycle-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-02-24";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-lifecycle-roundtrip";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-02-24T01:00:00.000Z",
      "updated: 2026-02-24T01:00:00.000Z",
      "source: test",
      "confidence: 0.8",
      "confidenceTier: implied",
      "tags: [\"policy\"]",
      "lifecycleState: candidate",
      "verificationState: unverified",
      "policyClass: ephemeral",
      "decayScore: 0.25",
      "heatScore: 0.75",
      "---",
      "",
      "roundtrip payload",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);

    const archivedPath = await storage.archiveMemory(memory);
    assert.ok(archivedPath);

    const archivedRaw = await readFile(archivedPath, "utf-8");
    assert.ok(archivedRaw.includes("lifecycleState: candidate"));
    assert.ok(archivedRaw.includes("verificationState: unverified"));
    assert.ok(archivedRaw.includes("policyClass: ephemeral"));
    assert.ok(archivedRaw.includes("decayScore: 0.25"));
    assert.ok(archivedRaw.includes("heatScore: 0.75"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager keeps legacy memories compatible when lifecycle fields are absent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-lifecycle-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "legacy payload", { source: "test" });
    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);

    assert.ok(memory);
    assert.equal(memory.frontmatter.lifecycleState, undefined);
    assert.equal(memory.frontmatter.verificationState, undefined);
    assert.equal(memory.frontmatter.policyClass, undefined);
    assert.equal(memory.frontmatter.lastValidatedAt, undefined);
    assert.equal(memory.frontmatter.decayScore, undefined);
    assert.equal(memory.frontmatter.heatScore, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
