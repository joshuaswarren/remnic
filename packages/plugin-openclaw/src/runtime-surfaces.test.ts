import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConsolidationObservation,
  MemoryFile,
  MemoryFrontmatter,
} from "@remnic/core";
import {
  parseDreamNarrativeResponse,
  planDreamEntryFromConsolidation,
  syncDreamSurfaceEntries,
  syncHeartbeatOutcomeLinks,
  syncHeartbeatSurfaceEntries,
} from "./runtime-surfaces.js";

function normalizeAttributePairs(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => [key.trim().toLowerCase(), value.trim()] as [string, string])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
}

function enrichStoredContent(
  content: string,
  structuredAttributes: Record<string, string> | undefined,
): string {
  if (!structuredAttributes || Object.keys(structuredAttributes).length === 0) {
    return content;
  }
  return `${content}\n[Attributes: ${normalizeAttributePairs(structuredAttributes)}]`;
}

function makeMemory(params: {
  id: string;
  category?: MemoryFrontmatter["category"];
  content: string;
  tags?: string[];
  created?: string;
  updated?: string;
  source?: string;
  memoryKind?: MemoryFrontmatter["memoryKind"];
  structuredAttributes?: Record<string, string>;
}): MemoryFile {
  return {
    path: `/tmp/${params.id}.md`,
    content: enrichStoredContent(params.content, params.structuredAttributes),
    frontmatter: {
      id: params.id,
      category: params.category ?? "fact",
      created: params.created ?? "2026-04-12T12:00:00.000Z",
      updated: params.updated ?? params.created ?? "2026-04-12T12:00:00.000Z",
      source: params.source ?? "extraction",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: params.tags ?? [],
      memoryKind: params.memoryKind,
      structuredAttributes: params.structuredAttributes,
    },
  };
}

function makeStorage(initial: MemoryFile[] = []) {
  const memories = [...initial];
  return {
    memories,
    async readAllMemories() {
      return memories.map((memory) => ({
        ...memory,
        frontmatter: {
          ...memory.frontmatter,
          tags: [...(memory.frontmatter.tags ?? [])],
          structuredAttributes: memory.frontmatter.structuredAttributes
            ? { ...memory.frontmatter.structuredAttributes }
            : undefined,
        },
      }));
    },
    async writeMemory(
      category: MemoryFrontmatter["category"],
      content: string,
      options: {
        tags?: string[];
        source?: string;
        memoryKind?: MemoryFrontmatter["memoryKind"];
        structuredAttributes?: Record<string, string>;
      } = {},
    ) {
      const id = `${category}-${memories.length + 1}`;
      memories.push(
        makeMemory({
          id,
          category,
          content,
          tags: options.tags,
          source: options.source,
          memoryKind: options.memoryKind,
          structuredAttributes: options.structuredAttributes,
        }),
      );
      return id;
    },
    async updateMemory(id: string, newContent: string) {
      const memory = memories.find((entry) => entry.frontmatter.id === id);
      if (!memory) return false;
      memory.content = newContent;
      memory.frontmatter.updated = "2026-04-12T13:00:00.000Z";
      return true;
    },
    async writeMemoryFrontmatter(memory: MemoryFile, patch: Partial<MemoryFrontmatter>) {
      const current = memories.find((entry) => entry.frontmatter.id === memory.frontmatter.id);
      if (!current) return false;
      current.frontmatter = {
        ...current.frontmatter,
        ...patch,
        tags: patch.tags ?? current.frontmatter.tags,
        structuredAttributes:
          patch.structuredAttributes ?? current.frontmatter.structuredAttributes,
      };
      return true;
    },
  };
}

test("syncDreamSurfaceEntries imports dream entries once and updates existing metadata idempotently", async () => {
  const storage = makeStorage();
  const reindexed: string[] = [];
  const result = await syncDreamSurfaceEntries({
    storage,
    entries: [
      {
        id: "dream-a",
        timestamp: "2026-04-12T10:00:00Z",
        title: "Patterns in the test suite",
        body: "The failures clustered around one fragile adapter.",
        tags: ["debug", "recurring"],
        sourceOffset: 12,
      },
    ],
    journalPath: "/workspace/DREAMS.md",
    maxEntries: 10,
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(result, { created: 1, updated: 0, linked: 0 });
  assert.equal(storage.memories.length, 1);
  assert.equal(storage.memories[0]?.frontmatter.memoryKind, "dream");
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.remnicDreamEntryId,
    "dream-a",
  );
  assert.equal(reindexed[0], "moment-1");

  const rerun = await syncDreamSurfaceEntries({
    storage,
    entries: [
      {
        id: "dream-a",
        timestamp: "2026-04-12T10:00:00Z",
        title: "Patterns in the test suite",
        body: "The failures clustered around one fragile adapter.",
        tags: ["debug", "recurring"],
        sourceOffset: 12,
      },
    ],
    journalPath: "/workspace/DREAMS.md",
    maxEntries: 10,
    reindexMemory: async () => {
      throw new Error("reindex should not run on a stable rerun");
    },
  });

  assert.deepEqual(rerun, { created: 0, updated: 0, linked: 0 });
  assert.equal(storage.memories.length, 1);
  assert.match(storage.memories[0]?.content ?? "", /\[Attributes: /);
});

test("syncDreamSurfaceEntries updates an edited dream entry instead of duplicating it when the stable id is unchanged", async () => {
  const storage = makeStorage();
  const reindexed: string[] = [];

  const first = await syncDreamSurfaceEntries({
    storage,
    entries: [
      {
        id: "dream-stable",
        timestamp: "2026-04-12T10:00:00Z",
        title: "First title",
        body: "Original body.",
        tags: ["debug"],
        sourceOffset: 12,
      },
    ],
    journalPath: "/workspace/DREAMS.md",
    maxEntries: 10,
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(first, { created: 1, updated: 0, linked: 0 });

  const second = await syncDreamSurfaceEntries({
    storage,
    entries: [
      {
        id: "dream-stable",
        timestamp: "2026-04-12T10:00:00Z",
        title: "Refined title",
        body: "Updated body with clearer wording.",
        tags: ["debug", "verification"],
        sourceOffset: 12,
      },
    ],
    journalPath: "/workspace/DREAMS.md",
    maxEntries: 10,
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(second, { created: 0, updated: 1, linked: 0 });
  assert.equal(storage.memories.length, 1);
  assert.match(storage.memories[0]?.content ?? "", /Refined title/);
  assert.match(storage.memories[0]?.content ?? "", /Updated body with clearer wording\./);
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.remnicDreamEntryId,
    "dream-stable",
  );
  assert.deepEqual(reindexed, ["moment-1", "moment-1"]);
});

test("syncDreamSurfaceEntries ignores structured attribute key reordering when the entry is unchanged", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "moment-1",
      category: "moment",
      content: "Patterns in the test suite\n\nThe failures clustered around one fragile adapter.",
      tags: ["debug", "recurring", "dream"],
      source: "dreams.md",
      memoryKind: "dream",
      structuredAttributes: {
        remnicDreamTitle: "Patterns in the test suite",
        remnicDreamSourceOffset: "12",
        remnicDreamJournalPath: "/workspace/DREAMS.md",
        remnicDreamTimestamp: "2026-04-12T10:00:00Z",
        remnicDreamEntryId: "dream-a",
        remnicSurfaceType: "dream",
      },
    }),
  ]);

  const result = await syncDreamSurfaceEntries({
    storage,
    entries: [
      {
        id: "dream-a",
        timestamp: "2026-04-12T10:00:00Z",
        title: "Patterns in the test suite",
        body: "The failures clustered around one fragile adapter.",
        tags: ["debug", "recurring"],
        sourceOffset: 12,
      },
    ],
    journalPath: "/workspace/DREAMS.md",
    maxEntries: 10,
    reindexMemory: async () => {
      throw new Error("reindex should not run when only structured-attribute key order differs");
    },
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 0 });
  assert.equal(storage.memories.length, 1);
});

test("syncDreamSurfaceEntries treats maxEntries zero as a hard disable", async () => {
  const storage = makeStorage();
  const reindexed: string[] = [];

  const result = await syncDreamSurfaceEntries({
    storage,
    entries: [
      {
        id: "dream-zero",
        timestamp: "2026-04-12T10:00:00Z",
        title: "Should not import",
        body: "maxEntries zero disables syncing.",
        tags: ["debug"],
        sourceOffset: 4,
      },
    ],
    journalPath: "/workspace/DREAMS.md",
    maxEntries: 0,
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 0 });
  assert.equal(storage.memories.length, 0);
  assert.deepEqual(reindexed, []);
});

test("syncDreamSurfaceEntries reuses memories created earlier in the same batch", async () => {
  const storage = makeStorage();

  const result = await syncDreamSurfaceEntries({
    storage,
    entries: [
      {
        id: "dream-batch",
        timestamp: "2026-04-12T10:00:00Z",
        title: "First draft",
        body: "Original body.",
        tags: ["debug"],
        sourceOffset: 12,
      },
      {
        id: "dream-batch",
        timestamp: "2026-04-12T10:00:00Z",
        title: "Refined draft",
        body: "Updated body.",
        tags: ["debug", "verification"],
        sourceOffset: 12,
      },
    ],
    journalPath: "/workspace/DREAMS.md",
    maxEntries: 10,
  });

  assert.deepEqual(result, { created: 1, updated: 1, linked: 0 });
  assert.equal(storage.memories.length, 1);
  assert.match(storage.memories[0]?.content ?? "", /Refined draft/);
});

test("syncHeartbeatSurfaceEntries updates an existing heartbeat memory when the stable entry id matches", async () => {
  const storage = makeStorage();
  const reindexed: string[] = [];

  const first = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci", "tests"],
        sourceOffset: 20,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(first, { created: 1, updated: 0, linked: 0 });
  assert.equal(storage.memories[0]?.frontmatter.memoryKind, "procedural");
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "check-test-suite",
  );
  assert.deepEqual(reindexed, ["principle-1"]);

  const second = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite, compare to the last run, and report new failures.",
        schedule: "hourly",
        tags: ["ci", "tests", "diff"],
        sourceOffset: 48,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(second, { created: 0, updated: 1, linked: 0 });
  assert.match(storage.memories[0]?.content ?? "", /compare to the last run/);
  assert.deepEqual(storage.memories[0]?.frontmatter.tags, [
    "ci",
    "tests",
    "diff",
    "heartbeat",
    "procedural",
    "check-test-suite",
  ]);
  assert.deepEqual(reindexed, ["principle-1", "principle-1"]);
});

test("syncHeartbeatSurfaceEntries preserves the stored heartbeat entry id across content edits when identity is stable", async () => {
  const storage = makeStorage();

  const first = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-stable",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci", "tests"],
        sourceOffset: 20,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
  });

  assert.deepEqual(first, { created: 1, updated: 0, linked: 0 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.remnicHeartbeatEntryId,
    "heartbeat-stable",
  );

  const second = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-stable",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite, compare to the last run, and report new failures.",
        schedule: "every 2 hours",
        tags: ["ci", "tests", "diff"],
        sourceOffset: 48,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
  });

  assert.deepEqual(second, { created: 0, updated: 1, linked: 0 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.remnicHeartbeatEntryId,
    "heartbeat-stable",
  );
  assert.match(storage.memories[0]?.content ?? "", /compare to the last run/);
});

test("syncHeartbeatSurfaceEntries does not report or reindex partial metadata write failures", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "principle-1",
      category: "principle",
      content: "check-test-suite\n\nRun the suite and report new failures.",
      tags: ["ci", "tests", "heartbeat", "procedural", "check-test-suite"],
      source: "heartbeat.md",
      memoryKind: "procedural",
      structuredAttributes: {
        remnicSurfaceType: "heartbeat",
        remnicHeartbeatEntryId: "heartbeat-a",
        relatedHeartbeatSlug: "check-test-suite",
        remnicHeartbeatJournalPath: "/workspace/HEARTBEAT.md",
        remnicHeartbeatSourceOffset: "20",
        remnicHeartbeatSchedule: "hourly",
      },
    }),
  ]);
  let frontmatterWrites = 0;
  storage.writeMemoryFrontmatter = async () => {
    frontmatterWrites += 1;
    return false;
  };
  const reindexed: string[] = [];

  const result = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite, compare to the last run, and report new failures.",
        schedule: "every 2 hours",
        tags: ["ci", "tests", "diff"],
        sourceOffset: 48,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 0 });
  assert.equal(frontmatterWrites, 1);
  assert.deepEqual(reindexed, []);
  assert.equal(
    storage.memories[0]?.content,
    enrichStoredContent("check-test-suite\n\nRun the suite and report new failures.", {
      remnicSurfaceType: "heartbeat",
      remnicHeartbeatEntryId: "heartbeat-a",
      relatedHeartbeatSlug: "check-test-suite",
      remnicHeartbeatJournalPath: "/workspace/HEARTBEAT.md",
      remnicHeartbeatSourceOffset: "20",
      remnicHeartbeatSchedule: "hourly",
    }),
  );
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.remnicHeartbeatSourceOffset,
    "20",
  );
});

test("syncHeartbeatSurfaceEntries prefers stable heartbeat entry ids over matching stale slugs", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "principle-stale-slug",
      category: "principle",
      content: "Old heartbeat body.",
      tags: ["heartbeat", "procedural", "check-test-suite"],
      source: "heartbeat.md",
      memoryKind: "procedural",
      structuredAttributes: {
        remnicSurfaceType: "heartbeat",
        remnicHeartbeatEntryId: "heartbeat-old",
        relatedHeartbeatSlug: "check-test-suite",
      },
    }),
    makeMemory({
      id: "principle-stable-id",
      category: "principle",
      content: "Existing heartbeat body.",
      tags: ["heartbeat", "procedural", "old-slug"],
      source: "heartbeat.md",
      memoryKind: "procedural",
      structuredAttributes: {
        remnicSurfaceType: "heartbeat",
        remnicHeartbeatEntryId: "heartbeat-stable",
        relatedHeartbeatSlug: "old-slug",
      },
    }),
  ]);

  const result = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-stable",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci", "tests"],
        sourceOffset: 20,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
  });

  assert.deepEqual(result, { created: 0, updated: 1, linked: 0 });
  assert.match(storage.memories[1]?.content ?? "", /Run the suite and report new failures\./);
  assert.equal(
    storage.memories[1]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "check-test-suite",
  );
  assert.match(storage.memories[0]?.content ?? "", /^Old heartbeat body\./);
});

test("syncHeartbeatSurfaceEntries updates the existing memory when a heartbeat title rename changes the slug but not the entry id", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "principle-stable-id",
      category: "principle",
      content: "Existing heartbeat body.",
      tags: ["heartbeat", "procedural", "check-test-suite"],
      source: "heartbeat.md",
      memoryKind: "procedural",
      structuredAttributes: {
        remnicSurfaceType: "heartbeat",
        remnicHeartbeatEntryId: "heartbeat-stable",
        relatedHeartbeatSlug: "check-test-suite",
      },
    }),
  ]);

  const result = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-stable",
        slug: "check-smoke-suite",
        title: "check-smoke-suite",
        body: "Run the smoke suite and report new failures.",
        schedule: "hourly",
        tags: ["ci", "tests"],
        sourceOffset: 20,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
  });

  assert.deepEqual(result, { created: 0, updated: 1, linked: 0 });
  assert.equal(storage.memories.length, 1);
  assert.match(storage.memories[0]?.content ?? "", /check-smoke-suite/);
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.remnicHeartbeatEntryId,
    "heartbeat-stable",
  );
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "check-smoke-suite",
  );
});

test("syncHeartbeatSurfaceEntries never overwrites non-surface memories through slug fallback", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "A regular fact linked to check-test-suite.",
      tags: ["ops", "heartbeat:check-test-suite"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    }),
  ]);

  const result = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-new",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the test suite every hour.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 12,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
  });

  assert.deepEqual(result, { created: 1, updated: 0, linked: 0 });
  assert.equal(storage.memories.length, 2);
  assert.match(
    storage.memories[0]?.content ?? "",
    /^A regular fact linked to check-test-suite\./,
  );
  assert.equal(storage.memories[0]?.frontmatter.structuredAttributes?.remnicSurfaceType, undefined);
  assert.equal(
    storage.memories[1]?.frontmatter.structuredAttributes?.remnicSurfaceType,
    "heartbeat",
  );
  assert.equal(
    storage.memories[1]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "check-test-suite",
  );
});

test("syncHeartbeatSurfaceEntries reuses memories created earlier in the same batch", async () => {
  const storage = makeStorage();

  const result = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci", "tests"],
        sourceOffset: 20,
      },
      {
        id: "heartbeat-b",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite, compare to the last run, and report new failures.",
        schedule: "hourly",
        tags: ["ci", "tests", "diff"],
        sourceOffset: 48,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
  });

  assert.deepEqual(result, { created: 1, updated: 1, linked: 0 });
  assert.equal(storage.memories.length, 1);
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.remnicHeartbeatEntryId,
    "heartbeat-b",
  );
  assert.match(storage.memories[0]?.content ?? "", /compare to the last run/);
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "check-test-suite",
  );
});

test("syncHeartbeatOutcomeLinks annotates non-heartbeat memories that clearly reference one heartbeat slug", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "During check-test-suite we found three new failures in the smoke run.",
      tags: ["ci"],
    }),
  ]);
  const reindexed: string[] = [];

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
    ],
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 1 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "check-test-suite",
  );
  assert.deepEqual(storage.memories[0]?.frontmatter.tags, [
    "ci",
    "heartbeat:check-test-suite",
  ]);
  assert.deepEqual(reindexed, ["fact-1"]);
});

test("syncHeartbeatOutcomeLinks does not infer canonical links from plain slug tags alone", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "This note does not mention the heartbeat in its body.",
      tags: ["ops", "check-test-suite"],
    }),
  ]);

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
    ],
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 0 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    undefined,
  );
  assert.deepEqual(storage.memories[0]?.frontmatter.tags, ["ops", "check-test-suite"]);
});

test("syncHeartbeatOutcomeLinks repairs stale heartbeat slugs when the memory now points to a different heartbeat", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "During sync-secrets we refreshed the vault material and rotated the dev secrets.",
      tags: ["ops", "heartbeat:check-test-suite"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    }),
  ]);
  const reindexed: string[] = [];

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
      {
        id: "heartbeat-b",
        slug: "sync-secrets",
        title: "sync-secrets",
        body: "Refresh dev secrets from the vault.",
        schedule: "daily",
        tags: ["ops"],
        sourceOffset: 40,
      },
    ],
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 1 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "sync-secrets",
  );
  assert.deepEqual(storage.memories[0]?.frontmatter.tags, [
    "ops",
    "heartbeat:sync-secrets",
  ]);
  assert.deepEqual(reindexed, ["fact-1"]);
});

test("syncHeartbeatOutcomeLinks clears stale heartbeat links when the memory no longer matches any entry", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "The secrets were rotated manually and no recurring task owns this note now.",
      tags: ["ops", "heartbeat:sync-secrets"],
      structuredAttributes: {
        relatedHeartbeatSlug: "sync-secrets",
      },
    }),
  ]);
  const reindexed: string[] = [];

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
    ],
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 1 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    undefined,
  );
  assert.deepEqual(storage.memories[0]?.frontmatter.tags, ["ops"]);
  assert.deepEqual(reindexed, ["fact-1"]);
});

test("syncHeartbeatOutcomeLinks does not treat empty heartbeat titles as universal matches", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "This memory does not mention any heartbeat slug.",
      tags: ["ci"],
    }),
  ]);

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
    ],
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 0 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    undefined,
  );
});

test("syncHeartbeatOutcomeLinks does not treat empty heartbeat slugs as universal matches", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "This memory mentions punctuation, but no actual heartbeat slug.",
      tags: ["ops"],
    }),
  ]);

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "",
        title: "",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
    ],
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 0 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    undefined,
  );
});

test("syncHeartbeatOutcomeLinks still resolves mixed empty-title entries by slug without false positives", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "The check-test-suite follow-up needs attention before rollout.",
      tags: ["ops"],
    }),
  ]);

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
      {
        id: "heartbeat-b",
        slug: "sync-secrets",
        title: "Sync secrets",
        body: "Verify sync timing before deployment.",
        schedule: "hourly",
        tags: ["ops"],
        sourceOffset: 1,
      },
    ],
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 1 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "check-test-suite",
  );
  assert.deepEqual(storage.memories[0]?.frontmatter.tags, ["ops", "heartbeat:check-test-suite"]);
});

test("syncHeartbeatOutcomeLinks does not false-match heartbeat titles inside larger words", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "We are still testing the adapter boundaries before rollout.",
      tags: ["ops"],
    }),
  ]);

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "heartbeat-test",
        title: "test",
        body: "Run the focused test checklist.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
    ],
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 0 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    undefined,
  );
});

test("syncHeartbeatOutcomeLinks does not false-match heartbeat titles inside hyphenated tokens", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "The pre-test-run note belongs to a different workflow.",
      tags: ["ops"],
    }),
  ]);

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "heartbeat-test",
        title: "test",
        body: "Run the focused test checklist.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
    ],
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 0 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    undefined,
  );
  assert.deepEqual(storage.memories[0]?.frontmatter.tags, ["ops"]);
});

test("syncHeartbeatOutcomeLinks does not false-match hyphenated slugs inside larger hyphenated tokens", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "The pre-check-test-suite-run note belongs to a different workflow.",
      tags: ["ops"],
    }),
  ]);

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
    ],
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 0 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    undefined,
  );
});

test("planDreamEntryFromConsolidation requires enough session-like spread, meta tags, and interval headroom", () => {
  const observation: ConsolidationObservation = {
    runAt: "2026-04-12T15:00:00.000Z",
    recentMemories: [
      makeMemory({
        id: "a",
        content: "A recurring failure showed up in the adapter tests.",
        tags: ["recurring", "debug"],
        created: "2026-04-12T10:00:00.000Z",
      }),
      makeMemory({
        id: "b",
        content: "Another surprising regression appeared in a different session.",
        tags: ["surprising"],
        created: "2026-04-12T11:00:00.000Z",
      }),
      makeMemory({
        id: "c",
        content: "The team felt stuck until the slot mismatch check clarified the path.",
        tags: ["stuck"],
        created: "2026-04-12T12:00:00.000Z",
      }),
    ],
    existingMemories: [],
    profile: "",
    result: { items: [], profileUpdates: [], entityUpdates: [] },
    merged: 0,
    invalidated: 0,
  };

  const plan = planDreamEntryFromConsolidation({
    observation,
    existingDreams: [],
    minIntervalMinutes: 120,
    now: new Date("2026-04-12T15:00:00.000Z"),
  });

  assert.ok(plan);
  assert.deepEqual(plan?.suggestedTags, ["recurring", "debug", "surprising", "stuck"]);
  assert.equal(plan?.sessionLikeCount, 3);
  assert.equal(plan?.memoryContext.length, 3);

  const suppressed = planDreamEntryFromConsolidation({
    observation,
    existingDreams: [
      {
        id: "dream-recent",
        timestamp: "2026-04-12T14:30:00.000Z",
        title: null,
        body: "A recent reflection already exists.",
        tags: [],
        sourceOffset: 10,
      },
    ],
    minIntervalMinutes: 120,
    now: new Date("2026-04-12T15:00:00.000Z"),
  });

  assert.equal(suppressed, null);
});

test("parseDreamNarrativeResponse extracts title, body, and tags with fallback tags", () => {
  const parsed = parseDreamNarrativeResponse(
    [
      "Title: Learning from recurring test drift",
      "Tags: #recurring #debug",
      "Body:",
      "The suite kept failing in the same corner until the adapter contract was clarified.",
    ].join("\n"),
    ["fallback"],
  );

  assert.deepEqual(parsed, {
    title: "Learning from recurring test drift",
    body: "The suite kept failing in the same corner until the adapter contract was clarified.",
    tags: ["recurring", "debug"],
  });

  const fallback = parseDreamNarrativeResponse("Body:\nA quieter reflection.", ["fallback"]);
  assert.deepEqual(fallback, {
    title: null,
    body: "A quieter reflection.",
    tags: ["fallback"],
  });

  const inlineBody = parseDreamNarrativeResponse(
    "Title: Signal drift\nBody: Inline reflection from the model\nTags: #dream",
    ["fallback"],
  );
  assert.deepEqual(inlineBody, {
    title: "Signal drift",
    body: "Inline reflection from the model",
    tags: ["dream"],
  });

  const bodyMetadataWords = parseDreamNarrativeResponse(
    [
      "Title: Signal drift",
      "Body:",
      "This note keeps the literal markers for later discussion.",
      "Title: A real body heading",
      "Tags: should stay in the body here",
      "Closing line keeps the prior Tags line inside the body.",
    ].join("\n"),
    ["fallback"],
  );

  assert.deepEqual(bodyMetadataWords, {
    title: "Signal drift",
    body: [
      "This note keeps the literal markers for later discussion.",
      "Title: A real body heading",
      "Tags: should stay in the body here",
      "Closing line keeps the prior Tags line inside the body.",
    ].join("\n"),
    tags: ["fallback"],
  });

  const headerAndTrailingTags = parseDreamNarrativeResponse(
    [
      "Title: Signal drift",
      "Tags: #header-tag",
      "Body: Inline reflection from the model",
      "Closing line keeps the note in the body.",
      "Tags: #trailing-tag",
    ].join("\n"),
    ["fallback"],
  );

  assert.deepEqual(headerAndTrailingTags, {
    title: "Signal drift",
    body: [
      "Inline reflection from the model",
      "Closing line keeps the note in the body.",
    ].join("\n"),
    tags: ["header-tag", "trailing-tag"],
  });

  const trailingOnlyTags = parseDreamNarrativeResponse(
    [
      "Title: Signal drift",
      "Body:",
      "Only trailing metadata should become the returned tags once.",
      "Tags: #trailing-tag",
    ].join("\n"),
    ["fallback"],
  );

  assert.deepEqual(trailingOnlyTags, {
    title: "Signal drift",
    body: "Only trailing metadata should become the returned tags once.",
    tags: ["trailing-tag"],
  });
});
