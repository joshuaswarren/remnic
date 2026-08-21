import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager.readMemoryByPath returns synthetic MemoryFile for entity files (no frontmatter)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-storage-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Write a real entity file (no YAML frontmatter — uses # Name + **Type:** format)
    await storage.writeEntity("Jane Doe", "person", ["Works at Acme", "Likes TypeScript"]);

    // writeEntity uses normalizeEntityName which prefixes the type: "jane doe" → "person-jane-doe"
    const entityPath = path.join(dir, "entities", "person-jane-doe.md");
    const result = await storage.readMemoryByPath(entityPath);

    // Must return a MemoryFile (not null) so boostSearchResults and access-service
    // can process entity files surfaced by the direct retrieval agent.
    assert.ok(result !== null, "readMemoryByPath should return MemoryFile for entity files");
    assert.equal(result!.frontmatter.category, "entity");
    assert.equal(result!.frontmatter.id, "person-jane-doe");
    assert.ok(result!.frontmatter.tags.includes("person"), "tags should include entity type");
    assert.ok(result!.content.includes("Jane Doe"), "content should include entity name");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager.writeEntity tolerates malformed entity payloads (no throw)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-storage-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    let threw = false;
    try {
      const id = await storage.writeEntity(undefined as any, undefined as any, ["a", 1] as any);
      assert.equal(typeof id, "string");
    } catch {
      threw = true;
    }

    assert.equal(threw, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager.readMemoryByPath uses entity content type instead of non-canonical filename prefix", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-storage-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityPath = path.join(dir, "entities", "jane-doe.md");
    await writeFile(
      entityPath,
      [
        "---",
        "created: 2026-04-14T10:00:00.000Z",
        "updated: 2026-04-14T10:00:00.000Z",
        "---",
        "",
        "# Jane Doe",
        "",
        "**Type:** person",
        "",
        "## Synthesis",
        "",
        "Jane Doe keeps launch reviews concise.",
      ].join("\n"),
      "utf-8",
    );

    const entityMemory = await storage.readMemoryByPath(entityPath);

    assert.ok(entityMemory, "expected to read the non-canonical entity file");
    assert.ok(entityMemory!.frontmatter.tags.includes("person"), "tags should include the entity type from content");
    assert.equal(entityMemory!.frontmatter.tags.includes("jane"), false, "tags should not infer a bogus type from the filename");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager.readMemoryByPath falls back to canonical entity filename prefixes when content is empty", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-storage-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityPath = path.join(dir, "entities", "person-jane-doe.md");
    await writeFile(
      entityPath,
      [
        "---",
        "created: 2026-04-14T10:00:00.000Z",
        "updated: 2026-04-14T10:00:00.000Z",
        "---",
      ].join("\n"),
      "utf-8",
    );

    const entityMemory = await storage.readMemoryByPath(entityPath);

    assert.ok(entityMemory, "expected to read the canonical entity file");
    assert.ok(entityMemory!.frontmatter.tags.includes("person"), "tags should include the canonical entity type from the filename");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
