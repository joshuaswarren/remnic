import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareMemoryLifecycleEvents,
  memoryLifecycleEventProjectionIdentity,
} from "../memory-lifecycle-ledger-utils.js";
import { getMemoryProjectionPath, openProjectionReadonly } from "../memory-projection-store.js";
import { readRawMemoryDocument } from "../storage/memory-frontmatter-metadata.js";
import { StorageManager } from "../storage.js";
import type { MemoryLifecycleEvent } from "../types.js";
import { rebuildMemoryProjection } from "./rebuild-memory-projection.js";

const FIXED_NOW = new Date("2026-06-01T00:00:00.000Z");

function fact(id: string, body: string): string {
  return [
    "---",
    `id: ${id}`,
    "category: fact",
    "confidence: 0.8",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-02T00:00:00.000Z",
    "status: active",
    "source: test",
    "entityRef: project-alpha",
    "tags:",
    "  - topic:alpha",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function ledgerEvent(partial: Pick<MemoryLifecycleEvent, "eventId" | "memoryId" | "eventType" | "timestamp">): MemoryLifecycleEvent {
  return {
    actor: "test",
    ruleVersion: "1",
    ...partial,
  };
}

async function seedCorpus(memoryDir: string, events: MemoryLifecycleEvent[]): Promise<void> {
  await mkdir(path.join(memoryDir, "facts", "2026-01-01"), { recursive: true });
  await mkdir(path.join(memoryDir, "cold", "facts", "2026-01-01"), { recursive: true });
  await mkdir(path.join(memoryDir, "archive", "facts", "2026-01-01"), { recursive: true });
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await writeFile(path.join(memoryDir, "facts", "2026-01-01", "hot-1.md"), fact("hot-1", "HOTBODY unique hot text"));
  await writeFile(path.join(memoryDir, "facts", "2026-01-01", "blank.md"), fact("  ", "blank id body"));
  await writeFile(path.join(memoryDir, "cold", "facts", "2026-01-01", "hot-1.md"), fact("hot-1", "COLDBODY should lose to hot"));
  await writeFile(path.join(memoryDir, "cold", "facts", "2026-01-01", "cold-only.md"), fact("cold-only", "COLDONLY body"));
  await writeFile(path.join(memoryDir, "archive", "facts", "2026-01-01", "arch-1.md"), fact("arch-1", "ARCHBODY archived text"));
  const lines = [
    ...events.map((event) => JSON.stringify(event)),
    "{not-json",
  ];
  await writeFile(
    path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

function expectedKeptEventIds(events: MemoryLifecycleEvent[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  const sorted = [...events].sort(compareMemoryLifecycleEvents);
  for (const event of sorted) {
    if (!event.memoryId.trim()) continue;
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    kept.push(event.eventId);
  }
  return kept.sort();
}

function projectionDigest(memoryDir: string): { hash: string; counts: Record<string, number>; eventIds: string[]; previews: Record<string, string>; ledgerCount: string | undefined } {
  const db = openProjectionReadonly(memoryDir);
  assert.ok(db, "projection opens");
  try {
    const hash = createHash("sha256");
    const counts: Record<string, number> = {};
    const queries: Array<[string, string]> = [
      ["memory_current", "SELECT * FROM memory_current ORDER BY memory_id"],
      ["memory_timeline", "SELECT * FROM memory_timeline ORDER BY event_id"],
      ["memory_entity_mentions", "SELECT * FROM memory_entity_mentions ORDER BY memory_id, entity_ref, mention_source"],
    ];
    for (const [name, sql] of queries) {
      hash.update(name);
      hash.update("\n");
      let count = 0;
      for (const row of db.prepare(sql).iterate()) {
        count += 1;
        hash.update(JSON.stringify(row));
        hash.update("\n");
      }
      counts[name] = count;
    }
    const eventIds = (db.prepare("SELECT event_id FROM memory_timeline ORDER BY event_id").all() as Array<{ event_id: string }>)
      .map((row) => row.event_id);
    const previews: Record<string, string> = {};
    for (const row of db.prepare("SELECT memory_id, preview_text FROM memory_current").all() as Array<{ memory_id: string; preview_text: string }>) {
      previews[row.memory_id] = row.preview_text;
    }
    const ledgerCount = (db.prepare("SELECT value FROM meta WHERE key = 'sourceLifecycleLedgerEventCount'").get() as { value?: string } | undefined)?.value;
    return { hash: hash.digest("hex"), counts, eventIds, previews, ledgerCount };
  } finally {
    db.close();
  }
}

test("retainRaw false skips the raw copy and does not poison the corpus cache", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-retain-raw-cache-"));
  try {
    await mkdir(path.join(memoryDir, "facts", "2026-01-01"), { recursive: true });
    await mkdir(path.join(memoryDir, "cold", "facts", "2026-01-01"), { recursive: true });
    await mkdir(path.join(memoryDir, "archive", "facts", "2026-01-01"), { recursive: true });
    await writeFile(path.join(memoryDir, "facts", "2026-01-01", "hot.md"), fact("hot", "hot body"));
    await writeFile(path.join(memoryDir, "cold", "facts", "2026-01-01", "cold.md"), fact("cold", "cold body"));
    await writeFile(path.join(memoryDir, "archive", "facts", "2026-01-01", "arch.md"), fact("arch", "arch body"));

    const storage = new StorageManager(memoryDir);
    const hot = await storage.readAllMemories();
    assert.equal(typeof readRawMemoryDocument(hot[0]!), "string");
    const stripped = await storage.readAllMemories({ retainRaw: false });
    assert.equal(readRawMemoryDocument(stripped[0]!), undefined);
    const again = await storage.readAllMemories();
    assert.equal(typeof readRawMemoryDocument(again[0]!), "string");

    const coldFirst = await storage.readAllColdMemories({ retainRaw: false });
    assert.equal(readRawMemoryDocument(coldFirst[0]!), undefined);
    const coldRetained = await storage.readAllColdMemories();
    assert.equal(typeof readRawMemoryDocument(coldRetained[0]!), "string");
    const coldAfter = await storage.readAllColdMemories({ retainRaw: false });
    assert.equal(readRawMemoryDocument(coldAfter[0]!), undefined);
    const coldStill = await storage.readAllColdMemories();
    assert.equal(typeof readRawMemoryDocument(coldStill[0]!), "string");

    const archived = await storage.readArchivedMemories({ retainRaw: false });
    assert.equal(readRawMemoryDocument(archived[0]!), undefined);
    const archivedKept = await storage.readArchivedMemories();
    assert.equal(typeof readRawMemoryDocument(archivedKept[0]!), "string");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("projection rows are byte-identical with retainRaw false", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-retain-raw-bytes-"));
  const events = [
    ledgerEvent({
      eventId: "dup-1",
      memoryId: "hot-1",
      eventType: "updated",
      timestamp: "2026-03-01T00:00:00.000Z",
    }),
    ledgerEvent({
      eventId: "dup-1",
      memoryId: "hot-1",
      eventType: "created",
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    ledgerEvent({
      eventId: "blank-1",
      memoryId: "  ",
      eventType: "created",
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    ledgerEvent({
      eventId: "cold-evt",
      memoryId: "cold-only",
      eventType: "created",
      timestamp: "2026-01-15T00:00:00.000Z",
    }),
  ];
  try {
    await seedCorpus(memoryDir, events);
    await rebuildMemoryProjection({ memoryDir, dryRun: false, now: FIXED_NOW, retainRaw: true });
    const withRaw = projectionDigest(memoryDir);
    await rm(getMemoryProjectionPath(memoryDir), { force: true });
    await rebuildMemoryProjection({ memoryDir, dryRun: false, now: FIXED_NOW });
    const withoutRaw = projectionDigest(memoryDir);

    assert.equal(withoutRaw.hash, withRaw.hash);
    assert.deepEqual(withoutRaw.counts, withRaw.counts);
    assert.deepEqual(withoutRaw.eventIds, expectedKeptEventIds(events));
    assert.match(withoutRaw.previews["hot-1"] ?? "", /HOTBODY/);
    assert.equal((withoutRaw.previews["hot-1"] ?? "").includes("COLDBODY"), false);
    assert.match(withoutRaw.previews["cold-only"] ?? "", /COLDONLY/);
    assert.match(withoutRaw.previews["arch-1"] ?? "", /ARCHBODY/);
    assert.equal(withoutRaw.previews["  "], undefined);
    const identities = new Set(events.map(memoryLifecycleEventProjectionIdentity));
    assert.equal(withoutRaw.ledgerCount, String(identities.size));
    assert.equal(withoutRaw.counts.memory_timeline, expectedKeptEventIds(events).length);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
