import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { StorageManager } from "@remnic/core/storage";

test("writeMemory stores structured attributes in frontmatter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sa-test-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "Sony WH-1000XM5 headphones cost $349.99", {
      confidence: 0.95,
      tags: ["product"],
      structuredAttributes: {
        brand: "Sony",
        model: "WH-1000XM5",
        price: "349.99",
        category: "headphones",
      },
    });

    assert.ok(id.startsWith("fact-"));

    // Read the written file and verify attributes appear in content
    const memories = await storage.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    assert.ok(memory, "memory should exist");
    assert.ok(memory!.content.includes("[Attributes:"), "content should have attributes suffix");
    assert.ok(memory!.content.includes("brand: Sony"), "content should include brand");
    assert.ok(memory!.content.includes("price: 349.99"), "content should include price");

    // Verify frontmatter has structuredAttributes
    assert.deepEqual(memory!.frontmatter.structuredAttributes, {
      brand: "Sony",
      model: "WH-1000XM5",
      price: "349.99",
      category: "headphones",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeMemory without structured attributes does not add suffix", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sa-test-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "The sky is blue", {
      confidence: 0.9,
      tags: [],
    });

    const memories = await storage.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    assert.ok(!memory!.content.includes("[Attributes:"), "content should not have attributes suffix");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeMemory handles empty structured attributes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sa-test-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "Simple fact", {
      confidence: 0.9,
      tags: [],
      structuredAttributes: {},
    });

    const memories = await storage.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    assert.ok(!memory!.content.includes("[Attributes:"), "empty attrs should not add suffix");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
