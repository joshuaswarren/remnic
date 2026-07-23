import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager round-trips escaped backslashes and quotes for importance reasons and link reasons", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-escape-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const reasonWithEscapes = String.raw`Path C:\work\"quoted"`;
    const linkReasonWithEscapes = String.raw`See C:\docs\"policy" for context`;

    const { id: id } = await storage.writeMemory("fact", "payload", {
      source: "test",
      importance: {
        score: 0.9,
        level: "high",
        reasons: [reasonWithEscapes],
        keywords: ["escaping"],
      },
      links: [
        {
          targetId: "fact-target",
          linkType: "supports",
          strength: 0.7,
          reason: linkReasonWithEscapes,
        },
      ],
    });

    const firstRead = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(firstRead);
    assert.deepEqual(firstRead.frontmatter.importance?.reasons, [reasonWithEscapes]);
    assert.equal(firstRead.frontmatter.links?.[0]?.reason, linkReasonWithEscapes);

    const added = await storage.addLinksToMemory(id, [
      {
        targetId: "fact-target-2",
        linkType: "related",
        strength: 0.5,
        reason: linkReasonWithEscapes,
      },
    ]);
    assert.equal(added, true);

    const secondRead = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(secondRead);
    assert.deepEqual(secondRead.frontmatter.importance?.reasons, [reasonWithEscapes]);
    assert.equal(secondRead.frontmatter.links?.[0]?.reason, linkReasonWithEscapes);
    assert.equal(secondRead.frontmatter.links?.[1]?.reason, linkReasonWithEscapes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager preserves legacy backslash-heavy reasons from older frontmatter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-legacy-escape-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const today = new Date().toISOString().slice(0, 10);
    const factsDir = path.join(dir, "facts", today);
    await mkdir(factsDir, { recursive: true });

    const legacyImportanceReason = String.raw`C:\notes\temp`;
    const legacySingleSegmentReason = String.raw`D:\test`;
    const legacyLinkReason = String.raw`D:\temp\notes\today`;
    const legacyFile = `---
id: fact-legacy-escapes
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T00:00:00.000Z
source: test
confidence: 0.8
confidenceTier: normal
tags: ["legacy"]
importanceScore: 0.9
importanceLevel: high
importanceReasons: ["${legacyImportanceReason}", "${legacySingleSegmentReason}"]
links:
  - targetId: fact-target
    linkType: supports
    strength: 0.7
    reason: "${legacyLinkReason}"
---

legacy payload
`;

    await writeFile(path.join(factsDir, "fact-legacy-escapes.md"), legacyFile, "utf-8");

    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === "fact-legacy-escapes");
    assert.ok(memory);
    assert.deepEqual(memory.frontmatter.importance?.reasons, [legacyImportanceReason, legacySingleSegmentReason]);
    assert.equal(memory.frontmatter.links?.[0]?.reason, legacyLinkReason);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
