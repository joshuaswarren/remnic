/**
 * Write-time location tagging regression (issue #2046): the post-write
 * enrichment path the extraction coordinator calls after a batch is durable.
 * Pins the gates, the provider-owned patch contract (StorageManager
 * chokepoint, actor "location-tagging"), and per-memory failure isolation.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { MemoryFile } from "../types.js";
import type { StorageManager } from "../index.js";
import type { WearableConversation } from "../wearables/types.js";
import { parseLocationConfig } from "./config.js";
import type { LocationSourceSegments } from "./matching.js";
import { enrichMemoriesWithLocation, fillWearableConversationLocations } from "./tagging.js";

function memory(id: string, frontmatter: Record<string, unknown> = {}): MemoryFile {
  return { path: `facts/${id}.md`, content: "body", frontmatter: { id, ...frontmatter } } as MemoryFile;
}

function taggedConfig() {
  return parseLocationConfig({
    enabled: true,
    timezone: "UTC",
    sources: [{ id: "reitti" }],
    tagging: { enabled: true },
  });
}

const HOME: LocationSourceSegments = {
  sourceId: "reitti",
  segments: [
    {
      startUtc: "2026-08-01T12:00:00.000Z",
      endUtc: "2026-08-01T14:00:00.000Z",
      place: { id: "reitti:place:home-1", label: "Home", kind: "home" },
      confidence: 0.9,
    },
  ],
};

const index = new Map([["2026-08-01", [HOME]]]);

function storageFor(memories: MemoryFile[], failWriteFor?: string) {
  const byId = new Map(memories.map((m) => [m.frontmatter.id, m]));
  const writes: Array<{ id: string; patch: Record<string, unknown>; actor: string }> = [];
  const storage: Pick<StorageManager, "getMemoryById" | "writeMemoryFrontmatter"> = {
    getMemoryById: (id) => Promise.resolve(byId.get(id) ?? null),
    writeMemoryFrontmatter: (file, patch, lifecycle) => {
      if (file.frontmatter.id === failWriteFor) return Promise.reject(new Error("disk full"));
      writes.push({ id: file.frontmatter.id, patch: patch as Record<string, unknown>, actor: lifecycle?.actor ?? "" });
      return Promise.resolve(true);
    },
  };
  return { storage, writes };
}

test("write-time enrichment tags matched memories through the storage chokepoint", async () => {
  const { storage, writes } = storageFor([
    memory("matched", { valid_at: "2026-08-01T12:30:00.000Z", invalid_at: "2026-08-01T13:30:00.000Z", tags: [] }),
    memory("untimed", { tags: [] }),
    memory("elsewhere", { valid_at: "2026-08-02T12:30:00.000Z", invalid_at: "2026-08-02T13:30:00.000Z", tags: [] }),
  ]);
  const counts = await enrichMemoriesWithLocation({
    storage,
    memoryIds: ["matched", "untimed", "elsewhere"],
    memoryDir: "/unused-when-index-passed",
    config: taggedConfig(),
    index,
  });

  assert.equal(counts.tagged, 1);
  assert.equal(counts.untimed, 1);
  assert.equal(counts.unmatched, 1);
  assert.equal(counts.failed, 0);
  assert.equal(writes.length, 1, "only the matched memory is patched");
  assert.equal(writes[0]?.id, "matched");
  assert.equal(writes[0]?.actor, "location-tagging");
  const tags = (writes[0]?.patch.tags as string[] | undefined) ?? [];
  assert.ok(tags.some((tag) => tag.startsWith("location:")), `provider tag written: ${JSON.stringify(tags)}`);
  const attributes = (writes[0]?.patch.structuredAttributes as Record<string, string> | undefined) ?? {};
  assert.equal(attributes.locationSource, "reitti");
  assert.equal(attributes.locationPlaceId, "reitti:place:home-1");
});

test("tagging gates off inside the shared core: no reads, no writes", async () => {
  const { storage, writes } = storageFor([
    memory("matched", { valid_at: "2026-08-01T12:30:00.000Z", invalid_at: "2026-08-01T13:30:00.000Z", tags: [] }),
  ]);
  const counts = await enrichMemoriesWithLocation({
    storage,
    memoryIds: ["matched"],
    memoryDir: "/unused-when-index-passed",
    config: parseLocationConfig({ enabled: true, timezone: "UTC", sources: [{ id: "reitti" }] }),
    index,
  });
  assert.equal(counts.tagged, 0);
  assert.equal(writes.length, 0);
});

test("a failing memory write is counted and never blocks the others", async () => {
  const { storage, writes } = storageFor(
    [
      memory("boom", { valid_at: "2026-08-01T12:30:00.000Z", invalid_at: "2026-08-01T13:30:00.000Z", tags: [] }),
      memory("fine", { valid_at: "2026-08-01T12:30:00.000Z", invalid_at: "2026-08-01T13:30:00.000Z", tags: [] }),
    ],
    "boom",
  );
  const counts = await enrichMemoriesWithLocation({
    storage,
    memoryIds: ["boom", "fine"],
    memoryDir: "/unused-when-index-passed",
    config: taggedConfig(),
    index,
  });
  assert.equal(counts.failed, 1);
  assert.equal(counts.tagged, 1);
  assert.deepEqual(writes.map((w) => w.id), ["fine"]);
});

test("wearable fill reuses the shared window: over-span conversations stay unfilled", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-location-wearable-"));
  try {
    await mkdir(path.join(memoryDir, "state", "locations"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "state", "locations", "sync.json"),
      JSON.stringify({ version: 1, sources: { reitti: { days: { "2026-08-01": { observationCount: 1, segments: HOME.segments } } } } }),
    );
    const conversations: Array<{ id: string; startIso: string; endIso?: string; location?: string }> = [
      { id: "c1", startIso: "2026-08-01T12:30:00.000Z", endIso: "2026-08-01T13:30:00.000Z" },
      { id: "c2", startIso: "2026-08-01T12:30:00.000Z", endIso: "2026-08-05T13:30:00.000Z" },
    ];
    await fillWearableConversationLocations(conversations as WearableConversation[], {
      memoryDir,
      config: taggedConfig(),
    });
    assert.equal(conversations[0]?.location, "Home", "in-window conversation gets the matched label");
    assert.equal(conversations[1]?.location, undefined, "span-too-long conversation is skipped, not mislabeled");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
