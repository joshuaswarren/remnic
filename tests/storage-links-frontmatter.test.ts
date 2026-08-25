import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { StorageManager } from "@remnic/core/storage";

test("StorageManager preserves escaped link reasons with backslashes/quotes/newlines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-link-reason-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const reason = String.raw`Path C:\Users\dev\notes says "keep it"` + "\nnext line";
    const { id: id } = await storage.writeMemory("fact", "payload", {
      source: "test",
      links: [
        {
          targetId: "fact-target",
          linkType: "references",
          strength: 0.9,
          reason,
        },
      ],
    });

    const first = await storage.getMemoryById(id);
    assert.ok(first);
    assert.equal(first.frontmatter.links?.[0]?.reason, reason);

    await storage.addLinksToMemory(id, [
      {
        targetId: "fact-other",
        linkType: "related",
        strength: 0.7,
        reason: String.raw`follow-up at D:\logs`,
      },
    ]);

    const second = await storage.getMemoryById(id);
    assert.ok(second);
    const persistedReasons = (second.frontmatter.links ?? []).map((link) => link.reason);
    assert.ok(persistedReasons.includes(reason));

    const raw = await readFile(second.path, "utf-8");
    assert.match(raw, /reason: "Path C:\\\\Users\\\\dev\\\\notes says \\"keep it\\"\\nnext line"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager reads legacy link reasons with unescaped backslashes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-link-reason-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = "fact-legacy-link-reason";
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, "facts", day, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "source: test",
      "confidence: 0.8",
      "confidenceTier: medium",
      "tags: []",
      "links:",
      "  - targetId: fact-target",
      "    linkType: references",
      "    strength: 0.9",
      String.raw`    reason: "Path C:\Users\dev\notes says \"keep it\""`,
      "---",
      "",
      "payload",
      "",
    ].join("\n");

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, raw, "utf-8");

    const memory = await storage.getMemoryById(id);
    assert.ok(memory);
    assert.equal(memory.frontmatter.links?.[0]?.reason, String.raw`Path C:\Users\dev\notes says "keep it"`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager preserves legacy backslash sequences that look like JSON escapes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-link-reason-legacy-json-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = "fact-legacy-link-reason-json-ish";
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, "facts", day, `${id}.md`);
    const legacyReason = String.raw`D:\temp\notes\today`;
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "source: test",
      "confidence: 0.8",
      "confidenceTier: medium",
      "tags: []",
      "links:",
      "  - targetId: fact-target",
      "    linkType: references",
      "    strength: 0.9",
      `    reason: "${legacyReason}"`,
      "---",
      "",
      "payload",
      "",
    ].join("\n");

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, raw, "utf-8");

    const memory = await storage.getMemoryById(id);
    assert.ok(memory);
    assert.equal(memory.frontmatter.links?.[0]?.reason, legacyReason);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
