import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";

function makeStorage(): { storage: StorageManager; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-wearable-io-"));
  return { storage: new StorageManager(dir), dir };
}

test("wearable transcript write/read/list round-trips", async () => {
  const { storage, dir } = makeStorage();
  try {
    assert.equal(await storage.readWearableDayTranscript("limitless", "2026-06-10"), null);
    assert.deepEqual(await storage.listWearableTranscriptDays(), []);

    await storage.writeWearableDayTranscript("limitless", "2026-06-10", "---\nkind: wearable-transcript\n---\n\nbody A\n");
    await storage.writeWearableDayTranscript("limitless", "2026-06-11", "---\nkind: wearable-transcript\n---\n\nbody B\n");
    await storage.writeWearableDayTranscript("bee", "2026-06-11", "---\nkind: wearable-transcript\n---\n\nbody C\n");

    const raw = await storage.readWearableDayTranscript("limitless", "2026-06-10");
    assert.ok(raw?.includes("body A"));

    const allDays = await storage.listWearableTranscriptDays();
    assert.deepEqual(allDays, [
      { source: "bee", date: "2026-06-11" },
      { source: "limitless", date: "2026-06-11" },
      { source: "limitless", date: "2026-06-10" },
    ]);
    const scoped = await storage.listWearableTranscriptDays("limitless");
    assert.equal(scoped.length, 2);
    assert.ok(scoped.every((entry) => entry.source === "limitless"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriting a day replaces content atomically", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeWearableDayTranscript("omi", "2026-06-10", "first version\n");
    await storage.writeWearableDayTranscript("omi", "2026-06-10", "second version\n");
    const raw = await storage.readWearableDayTranscript("omi", "2026-06-10");
    assert.equal(raw, "second version\n");
    assert.equal((await storage.listWearableTranscriptDays("omi")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malicious source ids and dates are rejected before any path math", async () => {
  const { storage, dir } = makeStorage();
  try {
    await assert.rejects(
      storage.writeWearableDayTranscript("../escape", "2026-06-10", "x"),
      /invalid wearable source id/,
    );
    await assert.rejects(
      storage.readWearableDayTranscript("limitless", "../../etc/passwd"),
      /invalid wearable transcript date/,
    );
    await assert.rejects(
      storage.readWearableDayTranscript("Limitless", "2026-06-10"),
      /invalid wearable source id/,
    );
    assert.throws(
      () => storage.wearableTranscriptPath("a/b", "2026-06-10"),
      /invalid wearable source id/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcript files never surface from readAllMemories", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeWearableDayTranscript(
      "limitless",
      "2026-06-10",
      "---\nkind: wearable-transcript\nsource: \"limitless\"\n---\n\ntranscript body\n",
    );
    const memories = await storage.readAllMemories();
    assert.equal(memories.length, 0, "wearables/ must stay outside memory scan roots");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promoteWearableMemory flips status, merges evidence, and updates confidence", async () => {
  const { storage, dir } = makeStorage();
  try {
    const id = await storage.writeMemory("fact", "Launch moved to September twelfth.", {
      confidence: 0.6,
      source: "wearable:limitless",
      status: "pending_review",
      structuredAttributes: { wearableSource: "limitless", trustScore: "0.600" },
    });
    const promoted = await storage.promoteWearableMemory(
      id,
      { trustScore: "0.750", trustDecision: "promoted-by-corroboration" },
      0.75,
    );
    assert.equal(promoted, true);
    const memory = (await storage.readAllMemories()).find(
      (entry) => entry.frontmatter.id === id,
    );
    assert.ok(memory);
    assert.equal(memory.frontmatter.status, "active");
    assert.equal(memory.frontmatter.confidence, 0.75);
    assert.equal(memory.frontmatter.structuredAttributes?.trustScore, "0.750");
    assert.equal(
      memory.frontmatter.structuredAttributes?.trustDecision,
      "promoted-by-corroboration",
    );

    // Already-active rows are not re-promoted (operator decisions win).
    assert.equal(await storage.promoteWearableMemory(id, {}, 0.9), false);
    assert.equal(await storage.promoteWearableMemory("missing-id", {}), false);

    const found = await storage.findWearableMemoryByContent(
      "Launch moved to September twelfth.",
    );
    assert.equal(found?.id, id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("demoteWearableMemory rejects only pending rows and merges evidence", async () => {
  const { storage, dir } = makeStorage();
  try {
    const id = await storage.writeMemory("fact", "Vendor call moved the launch again.", {
      confidence: 0.5,
      source: "wearable:limitless",
      status: "pending_review",
      structuredAttributes: { wearableSource: "limitless", trustScore: "0.500" },
    });
    const demoted = await storage.demoteWearableMemory(id, {
      trustScore: "0.310",
      trustDecision: "demoted-by-rejection",
      judgeVerdict: "reject",
    });
    assert.equal(demoted, true);
    const memory = (await storage.readAllMemories()).find(
      (entry) => entry.frontmatter.id === id,
    );
    assert.ok(memory);
    assert.equal(memory.frontmatter.status, "rejected");
    assert.equal(memory.frontmatter.structuredAttributes?.trustDecision, "demoted-by-rejection");
    assert.equal(memory.frontmatter.structuredAttributes?.wearableSource, "limitless");

    // Rejected rows are terminal for the wearable pipeline: no
    // re-demote, no promote (operator surfaces own them from here).
    assert.equal(await storage.demoteWearableMemory(id, {}), false);
    assert.equal(await storage.promoteWearableMemory(id, {}, 0.9), false);
    assert.equal(await storage.demoteWearableMemory("missing-id", {}), false);

    // Active rows are never auto-demoted.
    const activeId = await storage.writeMemory("fact", "Approved active row.", {
      confidence: 0.9,
      source: "wearable:limitless",
      status: "active",
    });
    assert.equal(await storage.demoteWearableMemory(activeId, {}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-transcript files in the wearables tree are ignored by listing", async () => {
  const { storage, dir } = makeStorage();
  try {
    const { promises: fsPromises } = await import("node:fs");
    await fsPromises.mkdir(path.join(dir, "wearables", "limitless"), { recursive: true });
    await fsPromises.writeFile(path.join(dir, "wearables", "limitless", "notes.md"), "x", "utf-8");
    await fsPromises.writeFile(path.join(dir, "wearables", "limitless", "2026-06-10.md.tmp"), "x", "utf-8");
    await fsPromises.mkdir(path.join(dir, "wearables", "NotASource"), { recursive: true });
    assert.deepEqual(await storage.listWearableTranscriptDays(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
