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
