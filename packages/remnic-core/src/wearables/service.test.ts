import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  composeDayTranscriptBody,
  composeDayTranscriptMeta,
  serializeDayTranscript,
} from "./day-store.js";
import { emptySpeakerRegistry } from "./speakers.js";
import {
  createWearableMemoryWriter,
  locateTranscriptPath,
  WearablesService,
  type WearableStorageIo,
} from "./service.js";
import { defaultWearablesConfig, defaultWearableSourceSettings } from "./config.js";
import type { WearableConversation, WearablesConfig } from "./types.js";

function makeStorage(memoryDir: string): WearableStorageIo & {
  files: Map<string, string>;
  memories: Array<{
    path: string;
    frontmatter: {
      id: string;
      source: string;
      created: string;
      tags: string[];
      status?: string;
      structuredAttributes?: Record<string, string>;
    };
    content: string;
  }>;
} {
  const files = new Map<string, string>();
  const storage = {
    dir: memoryDir,
    files,
    memories: [] as Array<{
      path: string;
      frontmatter: {
        id: string;
        source: string;
        created: string;
        tags: string[];
        status?: string;
        structuredAttributes?: Record<string, string>;
      };
      content: string;
    }>,
    async writeWearableDayTranscript(sourceId: string, date: string, serialized: string) {
      files.set(`${sourceId}/${date}`, serialized);
    },
    async readWearableDayTranscript(sourceId: string, date: string) {
      return files.get(`${sourceId}/${date}`) ?? null;
    },
    async listWearableTranscriptDays(sourceId?: string) {
      return [...files.keys()]
        .map((key) => {
          const [source, date] = key.split("/");
          return { source, date };
        })
        .filter((entry) => sourceId === undefined || entry.source === sourceId)
        .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
    },
    async readAllMemories() {
      return storage.memories;
    },
    async writeMemory() {
      return "mem-1";
    },
    async hasFactContentHash() {
      return false;
    },
  };
  return storage;
}

function storeDay(
  storage: ReturnType<typeof makeStorage>,
  sourceId: string,
  date: string,
  texts: string[],
): void {
  const registry = emptySpeakerRegistry();
  const conversations: WearableConversation[] = [
    {
      id: `${sourceId}-${date}`,
      source: sourceId,
      title: "Stored conversation",
      startIso: `${date}T10:00:00.000Z`,
      endIso: `${date}T10:30:00.000Z`,
      segments: texts.map((text, index) => ({
        speakerKey: index % 2 === 0 ? "user" : "guest",
        isWearer: index % 2 === 0,
        text,
      })),
    },
  ];
  const body = composeDayTranscriptBody(sourceId, date, "UTC", conversations, registry);
  const meta = composeDayTranscriptMeta(
    sourceId,
    date,
    "UTC",
    conversations,
    registry,
    body,
    "2026-06-11T01:00:00.000Z",
  );
  storage.files.set(`${sourceId}/${date}`, serializeDayTranscript(meta, body));
}

function makeService(
  storage: WearableStorageIo,
  configOverrides: Partial<WearablesConfig> = {},
): WearablesService {
  return new WearablesService({
    config: { ...defaultWearablesConfig(), enabled: true, ...configOverrides },
    getStorage: async () => storage,
    extract: null,
    searchBackend: null,
  });
}

test("locateTranscriptPath maps index hits back to source/date", () => {
  assert.deepEqual(
    locateTranscriptPath("/memory/wearables/limitless/2026-06-10.md"),
    { source: "limitless", date: "2026-06-10" },
  );
  assert.deepEqual(
    locateTranscriptPath("wearables\\bee\\2026-06-10.md"),
    { source: "bee", date: "2026-06-10" },
  );
  assert.equal(locateTranscriptPath("/memory/facts/2026/06/10/fact-1.md"), null);
  assert.equal(locateTranscriptPath("/memory/wearables/limitless/2026-13-40.md"), null);
});

test("dayTranscript returns all sources for a day with overlap hints", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    storeDay(storage, "limitless", "2026-06-10", ["Morning planning talk about the launch."]);
    storeDay(storage, "bee", "2026-06-10", ["Same day captured by the bracelet too."]);
    const service = makeService(storage);
    const views = await service.dayTranscript("2026-06-10");
    assert.equal(views.length, 2);
    const limitless = views.find((view) => view.source === "limitless");
    assert.ok(limitless);
    assert.deepEqual(limitless.overlapsWith, ["bee"]);
    assert.match(limitless.body, /Morning planning talk/);

    const scoped = await service.dayTranscript("2026-06-10", "bee");
    assert.equal(scoped.length, 1);
    assert.deepEqual(scoped[0].overlapsWith, []);

    await assert.rejects(service.dayTranscript("junk"), /invalid date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchTranscripts falls back to a bounded scan and scopes by source/date", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    storeDay(storage, "limitless", "2026-06-09", ["We discussed the solar panel quote."]);
    storeDay(storage, "limitless", "2026-06-10", ["Talked about the solar warranty terms."]);
    storeDay(storage, "bee", "2026-06-10", ["Solar again, captured by bee."]);
    const service = makeService(storage);

    const all = await service.searchTranscripts("solar");
    assert.equal(all.length, 3);
    assert.ok(all.every((result) => result.backend === "scan"));

    const scoped = await service.searchTranscripts("solar", {
      source: "limitless",
      from: "2026-06-10",
    });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].date, "2026-06-10");
    assert.match(scoped[0].snippet, /warranty/);

    await assert.rejects(service.searchTranscripts("  "), /non-empty/);
    await assert.rejects(service.searchTranscripts("x", { from: "junk" }), /invalid from/);
    await assert.rejects(service.searchTranscripts("x", { limit: 0 }), /invalid limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchTranscripts prefers the indexed backend and filters hits to transcripts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    storeDay(storage, "limitless", "2026-06-10", ["Indexed content."]);
    const service = new WearablesService({
      config: { ...defaultWearablesConfig(), enabled: true },
      getStorage: async () => storage,
      extract: null,
      searchBackend: {
        async search() {
          return [
            { path: "/memory/wearables/limitless/2026-06-10.md", score: 0.9, preview: "Indexed content." },
            { path: "/memory/facts/2026/06/10/fact-1.md", score: 0.8, preview: "A fact, not a transcript." },
          ];
        },
      },
    });
    const results = await service.searchTranscripts("indexed");
    assert.equal(results.length, 1);
    assert.equal(results[0].backend, "indexed");
    assert.equal(results[0].source, "limitless");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zero in-scope indexed hits fall back to the bounded scan", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    storeDay(storage, "limitless", "2026-06-10", ["The solar quote came in under budget."]);
    const service = new WearablesService({
      config: { ...defaultWearablesConfig(), enabled: true },
      getStorage: async () => storage,
      extract: null,
      searchBackend: {
        async search() {
          // The index returned hits, but they're all ordinary memory
          // files — transcripts were crowded out of the top results.
          return [
            { path: "/memory/facts/2026/06/10/fact-1.md", score: 0.9, preview: "solar memory" },
            { path: "/memory/facts/2026/06/10/fact-2.md", score: 0.8, preview: "solar memory 2" },
          ];
        },
      },
    });
    const results = await service.searchTranscripts("solar");
    assert.equal(results.length, 1);
    assert.equal(results[0].backend, "scan");
    assert.equal(results[0].source, "limitless");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcriptMemories filters by wearable source and day", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    storage.memories.push(
      {
        path: "facts/a.md",
        frontmatter: {
          id: "fact-1",
          source: "wearable:limitless",
          created: "2026-06-10T16:00:00.000Z",
          tags: ["wearable"],
          status: "pending_review",
          structuredAttributes: {
            wearableSource: "limitless",
            wearableDate: "2026-06-10",
            wearableConversationId: "c1",
          },
        },
        content: "Launch moved to September 12.",
      },
      {
        path: "facts/b.md",
        frontmatter: {
          id: "fact-2",
          source: "wearable:bee:native",
          created: "2026-06-09T16:00:00.000Z",
          tags: ["wearable"],
          structuredAttributes: { wearableSource: "bee", wearableNativeId: "n1" },
        },
        content: "Provider-extracted fact.",
      },
      {
        path: "facts/c.md",
        frontmatter: {
          id: "fact-3",
          source: "extraction",
          created: "2026-06-10T10:00:00.000Z",
          tags: [],
        },
        content: "Ordinary live-session memory.",
      },
    );
    const service = makeService(storage);

    const all = await service.transcriptMemories();
    assert.deepEqual(
      all.map((memory) => memory.id),
      ["fact-1", "fact-2"],
      "only wearable-derived memories, newest first",
    );

    const limitlessOnly = await service.transcriptMemories({ source: "limitless" });
    assert.deepEqual(limitlessOnly.map((memory) => memory.id), ["fact-1"]);

    const beeOnly = await service.transcriptMemories({ source: "bee" });
    assert.deepEqual(beeOnly.map((memory) => memory.id), ["fact-2"]);

    const byDay = await service.transcriptMemories({ date: "2026-06-10" });
    assert.deepEqual(byDay.map((memory) => memory.id), ["fact-1"]);

    await assert.rejects(service.transcriptMemories({ date: "junk" }), /invalid date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the wearable memory writer dedups non-fact categories by content scan", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    storage.memories.push({
      path: "facts/digest.md",
      frontmatter: {
        id: "moment-1",
        source: "wearable:limitless",
        created: "2026-06-10T16:00:00.000Z",
        tags: ["wearable", "daily-digest"],
        structuredAttributes: { wearableSource: "limitless", wearableDate: "2026-06-10" },
      },
      content: "Wearable day digest — limitless, 2026-06-10: 2 recorded conversations.",
    });
    const writer = createWearableMemoryWriter(storage);
    // The fact hash index (always false in this fake) misses moments —
    // the wearable-scoped content scan must catch the duplicate.
    assert.equal(
      await writer.hasFactContentHash(
        "Wearable day digest — limitless, 2026-06-10: 2 recorded conversations.",
      ),
      true,
    );
    assert.equal(await writer.hasFactContentHash("Novel digest content."), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed source ids reject as input errors before storage reads", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const service = makeService(makeStorage(dir));
    await assert.rejects(service.dayTranscript("2026-06-10", "../x"), /invalid source id/);
    await assert.rejects(service.listDays("Bad Source"), /invalid source id/);
    await assert.rejects(
      service.searchTranscripts("solar", { source: "../escape" }),
      /invalid source id/,
    );
    await assert.rejects(
      service.transcriptMemories({ source: " " }),
      /invalid source id/,
    );
    await assert.rejects(service.sync({ source: "../escape" }), /invalid source id/);
    await assert.rejects(service.checkAuth("../escape"), /invalid source id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync validates source selection before touching connectors", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: false },
      },
    });
    await assert.rejects(service.sync({ source: "nope" }), /unknown wearable source/);
    await assert.rejects(service.sync({ source: "limitless" }), /disabled/);
    await assert.rejects(service.sync({}), /no wearable sources are enabled/);

    const disabled = new WearablesService({
      config: { ...defaultWearablesConfig(), enabled: false },
      getStorage: async () => storage,
      extract: null,
      searchBackend: null,
    });
    await assert.rejects(disabled.sync({}), /wearables are not enabled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("speaker and correction management round-trips through the service", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const service = makeService(makeStorage(dir));

    await service.setSelfName("Jordan");
    await service.setSpeaker("bee", "0", "Jordan", { isSelf: true });
    await service.setSpeaker("limitless", "Speaker 2", "Alex Sample");
    let registry = await service.listSpeakers();
    assert.equal(registry.selfName, "Jordan");
    assert.equal(registry.speakers["limitless:Speaker 2"].name, "Alex Sample");
    assert.equal(registry.speakers["bee:0"].isSelf, true);

    registry = await service.removeSpeaker("limitless", "Speaker 2");
    assert.equal(registry.speakers["limitless:Speaker 2"], undefined);
    await assert.rejects(service.removeSpeaker("limitless", "Speaker 2"), /no speaker override/);
    await assert.rejects(service.setSpeaker("bee", "1", "  "), /non-empty/);

    await service.addCorrection({ match: "remnick", replace: "Remnic" });
    await assert.rejects(
      service.addCorrection({ match: "remnick", replace: "Remnic" }),
      /identical correction rule/,
    );
    let corrections = await service.listCorrections();
    assert.equal(corrections.fromState.length, 1);
    const removed = await service.removeCorrection(0);
    assert.equal(removed.match, "remnick");
    corrections = await service.listCorrections();
    assert.equal(corrections.fromState.length, 0);
    await assert.rejects(service.removeCorrection(5), /out of range/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
