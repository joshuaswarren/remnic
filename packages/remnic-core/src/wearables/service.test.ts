import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { realpath as fsRealpath } from "node:fs/promises";
import { test } from "node:test";

import {
  bodyIsEscaped,
  composeDayTranscriptBody,
  composeDayTranscriptMeta,
  parseDayTranscript,
  serializeDayTranscript,
} from "./day-store.js";
import {
  DEFAULT_SOURCE_TRUST,
  FUSION_ALGO_VERSION,
  FusionArtifactStore,
  canonicalDayKey,
  composeFusionDayMeta,
  parseFusionDay,
  reconstructFusionInputs,
  serializeFusionDay,
} from "./fusion/index.js";
import { emptySpeakerRegistry } from "./speakers.js";
import {
  createWearableMemoryWriter,
  locateTranscriptPath,
  WearablesService,
  type WearableStorageIo,
} from "./service.js";
import { sealedWriteToLegacyArgs } from "../write-envelope.js";
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
  const fusedFiles = new Map<string, string>();
  const fusionStore = new FusionArtifactStore(path.join(memoryDir, "wearables"), memoryDir, {
    writeFile: async (filePath, content) => {
      fusedFiles.set(filePath, content);
    },
    readFile: async (filePath) => {
      if (!fusedFiles.has(filePath)) {
        const err = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return fusedFiles.get(filePath)!;
    },
    readDir: async (dirPath) =>
      [...fusedFiles.keys()]
        .filter((key) => path.dirname(key) === dirPath)
        .map((key) => path.basename(key)),
    deleteFile: async (filePath) => {
      if (!fusedFiles.delete(filePath)) {
        const err = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
    },
    realpath: (filePath) => fsRealpath(filePath),
    lstat: async (filePath) => {
      // The in-memory mock models no real symlinks: a `_fusion` dir
      // "exists" when at least one fused file lives beneath it, and is
      // never itself a symbolic link.
      const hasChildren = [...fusedFiles.keys()].some(
        (k) => path.dirname(k) === filePath,
      );
      if (!hasChildren) {
        const err = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return { isSymbolicLink: false };
    },
  });
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
    fusionArtifactStore() {
      return fusionStore;
    },
    async readAllMemories() {
      return storage.memories;
    },
    async writeSealedMemory() {
      return { id: "mem-1", tombstoneBlocked: false };
    },
    async hasFactContentHash() {
      return false;
    },
    async findWearableMemoryByContent(content: string) {
      const needle = content.trim();
      const match = storage.memories.find(
        (memory) =>
          memory.frontmatter.source.startsWith("wearable:") &&
          memory.content.trim() === needle,
      );
      return match
        ? { id: match.frontmatter.id, status: match.frontmatter.status }
        : null;
    },
    async promoteWearableMemory(id: string) {
      const match = storage.memories.find((memory) => memory.frontmatter.id === id);
      if (!match || match.frontmatter.status !== "pending_review") return false;
      match.frontmatter.status = "active";
      return true;
    },
    async demoteWearableMemory(id: string, attrs: Record<string, string>) {
      const match = storage.memories.find((memory) => memory.frontmatter.id === id);
      if (!match || match.frontmatter.status !== "pending_review") return false;
      match.frontmatter.status = "rejected";
      match.frontmatter.structuredAttributes = {
        ...(match.frontmatter.structuredAttributes ?? {}),
        ...attrs,
      };
      return true;
    },
  };
  return storage;
}

function storeDay(
  storage: ReturnType<typeof makeStorage>,
  sourceId: string,
  date: string,
  texts: string[],
  timezone = "UTC",
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
  const body = composeDayTranscriptBody(sourceId, date, timezone, conversations, registry);
  const meta = composeDayTranscriptMeta(
    sourceId,
    date,
    timezone,
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

test("indexed search escapes the query and decodes the snippet (#1849)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    // Segment text carries a literal backslash. In the stored file the
    // backslash is doubled, so the indexed text has C:\\GAPDIR while
    // the original had C:\GAPDIR. The indexed backend must receive
    // the escaped form to match the indexed representation.
    storeDay(storage, "limitless", "2026-06-10", ["File at C:\\GAPDIR\\report.txt"]);

    const receivedQueries: string[] = [];
    const service = new WearablesService({
      config: { ...defaultWearablesConfig(), enabled: true },
      getStorage: async () => storage,
      extract: null,
      searchBackend: {
        async search(query: string) {
          receivedQueries.push(query);
          // Simulate a hit whose preview carries the escaped form.
          return [
            {
              path: "/memory/wearables/limitless/2026-06-10.md",
              score: 0.9,
              preview: "**Me (you)** [10:00]: File at C:\\\\GAPDIR\\\\report.txt",
            },
          ];
        },
      },
    });

    const results = await service.searchTranscripts("C:\\GAPDIR");
    assert.equal(results.length, 1);
    assert.equal(results[0].backend, "indexed");
    assert.equal(results[0].source, "limitless");
    // The escaped query form (doubled backslash) must reach the backend.
    assert.ok(
      receivedQueries.some((q) => q === "C:\\\\GAPDIR"),
      "indexed backend must receive escaped query for backslash content",
    );
    // The snippet must show the DECODED original (single backslash).
    assert.ok(
      results[0].snippet.includes("C:\\GAPDIR"),
      "snippet shows decoded single backslash",
    );
    assert.ok(
      !results[0].snippet.includes("C:\\\\GAPDIR"),
      "no escaped-backslash leak in snippet",
    );
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

test("support corpus includes pending_review rows and excludes terminal statuses", async () => {
  const { registerWearableConnector, clearWearableConnectors } = await import("./registry.js");
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  const borderlineFact =
    "The launch moved to September twelfth after the vendor call.";
  const makeRow = (
    id: string,
    status: string | undefined,
    content: string,
    archivedAt?: string,
  ) => ({
    path: `facts/${id}.md`,
    frontmatter: {
      id,
      source: "wearable:limitless",
      created: "2026-06-09T16:00:00.000Z",
      tags: ["wearable"],
      ...(status !== undefined ? { status } : {}),
      ...(archivedAt !== undefined ? { archivedAt } : {}),
      structuredAttributes: { wearableSource: "limitless" },
    },
    content,
  });
  const runSmartSync = async (
    rows: ReturnType<typeof makeRow>[],
  ): Promise<Record<string, unknown>> => {
    const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-service-mem-")));
    storage.memories.push(...rows);
    const writes: Array<{ options: Record<string, unknown> }> = [];
    storage.writeSealedMemory = ((envelope: Parameters<WearableStorageIo["writeSealedMemory"]>[0], extras: Record<string, unknown>) => {
      const { options } = sealedWriteToLegacyArgs(envelope, extras);
      writes.push({ options });
      return Promise.resolve({ id: `mem-${writes.length}`, tombstoneBlocked: false });
    }) as WearableStorageIo["writeSealedMemory"];
    try {
      registerWearableConnector({
        id: "testsource",
        displayName: "Test Source",
        factory: () => ({
          id: "testsource",
          displayName: "Test Source",
          verifyAuth: async () => ({ ok: true }),
          fetchConversations: async () => ({
            conversations: [
              {
                id: "c1",
                source: "testsource",
                startIso: "2026-06-10T15:00:00.000Z",
                endIso: "2026-06-10T15:30:00.000Z",
                segments: [
                  { speakerKey: "user", isWearer: true, text: "We are moving the launch to September twelfth after that vendor call wrapped up." },
                  { speakerKey: "guest", speakerName: "guest", text: "Confirmed, the vendor is aligned on the September date for the launch." },
                ],
              },
            ],
            nextCursor: null,
          }),
        }),
      });
      const service = new WearablesService({
        config: {
          ...defaultWearablesConfig(),
          enabled: true,
          digestEnabled: false,
          sources: {
            testsource: { ...defaultWearableSourceSettings(), enabled: true, memoryMode: "smart" },
          },
        },
        getStorage: async () => storage,
        // Borderline: 0.75 * 0.8 = 0.6 — active only with +0.10 support.
        extract: async () => ({
          facts: [{ category: "fact", content: borderlineFact, confidence: 0.75, tags: [] }],
          profileUpdates: [],
          entities: [],
          questions: [],
        }),
        searchBackend: null,
      });
      await service.sync({ date: "2026-06-10" });
      assert.equal(writes.length, 1);
      return writes[0].options;
    } finally {
      clearWearableConnectors();
    }
  };

  try {
    // A pending_review row with matching content IS support evidence.
    // (Similar wording, not identical — identical content would be
    // consumed by the duplicate-existing dedup before scoring.)
    const supported = await runSmartSync([
      makeRow(
        "pending-1",
        "pending_review",
        "The launch moved to September twelfth after the vendor call, noted earlier.",
      ),
    ]);
    assert.equal(supported.status, "active");
    assert.equal(
      (supported.structuredAttributes as Record<string, string>).supportingMemoryId,
      "pending-1",
    );

    // Terminal statuses with the same content are NOT support evidence.
    const similar =
      "The launch moved to September twelfth after the vendor call, noted earlier.";
    const unsupported = await runSmartSync([
      makeRow("rejected-1", "rejected", similar),
      makeRow("quarantined-1", "quarantined", similar),
      makeRow("superseded-1", "superseded", similar),
      makeRow("archived-1", "archived", similar),
      makeRow("forgotten-1", "forgotten", similar),
      // Archived via archivedAt with NO explicit status — the
      // canonical inferMemoryStatus must resolve this to archived.
      makeRow("archived-implicit-1", undefined, similar, "2026-06-09T00:00:00.000Z"),
    ]);
    assert.equal(unsupported.status, "pending_review");
    assert.equal(
      (unsupported.structuredAttributes as Record<string, string>).supportingMemoryId,
      undefined,
    );

    // Content matching ONLY through the "[Attributes: ...]" enrichment
    // suffix is not corroboration — the suffix is stripped before
    // token matching, so attribute metadata never grants the boost.
    const suffixOnly = await runSmartSync([
      makeRow(
        "pending-2",
        "pending_review",
        "Unrelated note about quarterly budget planning.\n[Attributes: context: launch moved to September twelfth after the vendor call]",
      ),
    ]);
    assert.equal(suffixOnly.status, "pending_review");
    assert.equal(
      (suffixOnly.structuredAttributes as Record<string, string>).supportingMemoryId,
      undefined,
    );
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

test("fuseDay is gated by wearables.fusion.enabled", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    storeDay(storage, "limitless", "2026-06-10", ["Hello world."]);
    const service = makeService(storage); // fusion defaults to disabled
    await assert.rejects(() => service.fuseDay("2026-06-10"), /fusion is not enabled/);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay honors the wearables master gate before the fusion gate (issue #1849)", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    storeDay(storage, "limitless", "2026-06-10", ["Hello world."]);
    // wearables.enabled=false but fusion.enabled=true — fuseDay must refuse
    // at the master gate (the same assertEnabled() sync/checkAuth use),
    // before reading any source or touching the derived artifact store.
    const service = makeService(storage, {
      enabled: false,
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });
    await assert.rejects(
      () => service.fuseDay("2026-06-10"),
      /wearables are not enabled/,
    );
    // The master-gate refusal must not write or delete any fusion artifact.
    assert.equal(
      await storage.fusionArtifactStore().readFusedDay("2026-06-10"),
      null,
      "master-gate refusal must not mutate derived fusion state",
    );
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay writes a derived artifact, is idempotent, and leaves raw transcripts untouched", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // Two enabled sources recorded the same overlapping window.
    storeDay(storage, "limitless", "2026-06-10", ["We agreed to ship Friday."]);
    storeDay(storage, "bee", "2026-06-10", ["We agreed to ship Friday."]);
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: {
        enabled: true,
        proximityGapMs: 300_000,
        windowToleranceMs: 30_000,
      },
    });

    // No fused artifact yet.
    assert.equal(await storage.fusionArtifactStore().readFusedDay("2026-06-10"), null);

    const first = await service.fuseDay("2026-06-10");
    assert.equal(first.written, true);
    assert.ok(first.conversationCount >= 1, "overlapping sources fuse into >=1 conversation");
    assert.deepEqual([...first.sources].sort(), ["bee", "limitless"]);

    // The derived artifact is readable via the listing surface.
    const conversations = await service.fusedConversations("2026-06-10");
    assert.equal(conversations.length, first.conversationCount);
    assert.ok(conversations[0]!.id.startsWith("fusion-"));
    assert.deepEqual(
      [...conversations[0]!.sources].sort(),
      ["bee", "limitless"],
    );

    // Idempotent re-run: identical inputs -> not written again.
    const second = await service.fuseDay("2026-06-10");
    assert.equal(second.written, false, "unchanged inputs must not rewrite the artifact");
    assert.equal(second.contentHash, first.contentHash);

    // Raw per-source transcripts remain readable and untouched.
    const limitlessRaw = await storage.readWearableDayTranscript("limitless", "2026-06-10");
    const beeRaw = await storage.readWearableDayTranscript("bee", "2026-06-10");
    assert.notEqual(limitlessRaw, null);
    assert.notEqual(beeRaw, null);
    // Raw transcripts are byte-identical to what was stored (fusion never
    // overwrites source transcripts).
    assert.ok(limitlessRaw?.includes("We agreed to ship Friday."));
    assert.ok(beeRaw?.includes("We agreed to ship Friday."));

    // listFusedDays surfaces the fused date.
    assert.deepEqual(await service.listFusedDays(), ["2026-06-10"]);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay rebuilds the artifact when fusion config changes (not skipped)", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // Two enabled sources recorded the same overlapping window.
    storeDay(storage, "limitless", "2026-06-10", ["We agreed to ship Friday."]);
    storeDay(storage, "bee", "2026-06-10", ["We agreed to ship Friday."]);

    const baseSources = {
      limitless: { ...defaultWearableSourceSettings(), enabled: true },
      bee: { ...defaultWearableSourceSettings(), enabled: true },
    };

    const serviceGap5m = makeService(storage, {
      sources: baseSources,
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    // Initial fuse writes the artifact.
    const first = await serviceGap5m.fuseDay("2026-06-10");
    assert.equal(first.written, true);
    const firstHash = first.contentHash;

    // Unchanged inputs + config => idempotent skip.
    const rerun = await serviceGap5m.fuseDay("2026-06-10");
    assert.equal(rerun.written, false, "unchanged inputs+config must not rewrite");
    assert.equal(rerun.contentHash, firstHash);

    // Tune proximityGapMs => new content hash => artifact rebuilt, not skipped.
    const serviceGap10m = makeService(storage, {
      sources: baseSources,
      fusion: { enabled: true, proximityGapMs: 600_000, windowToleranceMs: 30_000 },
    });
    const afterGap = await serviceGap10m.fuseDay("2026-06-10");
    assert.equal(afterGap.written, true, "proximityGapMs change must trigger a rebuild");
    assert.notEqual(afterGap.contentHash, firstHash);

    // Re-run under the new config => idempotent skip again.
    const afterGapRerun = await serviceGap10m.fuseDay("2026-06-10");
    assert.equal(afterGapRerun.written, false);
    assert.equal(afterGapRerun.contentHash, afterGap.contentHash);

    // Tune per-source trust => new content hash => artifact rebuilt.
    const serviceTrust = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true, sourceTrust: 0.95 },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 600_000, windowToleranceMs: 30_000 },
    });
    const afterTrust = await serviceTrust.fuseDay("2026-06-10");
    assert.equal(afterTrust.written, true, "per-source trust change must trigger a rebuild");
    assert.notEqual(afterTrust.contentHash, afterGap.contentHash);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay regenerates a stale artifact written under an older algorithm version (issue #1849)", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    storeDay(storage, "limitless", "2026-06-10", ["We agreed to ship Friday."]);
    storeDay(storage, "bee", "2026-06-10", ["We agreed to ship Friday."]);
    const baseSources = {
      limitless: { ...defaultWearableSourceSettings(), enabled: true },
      bee: { ...defaultWearableSourceSettings(), enabled: true },
    };
    const fusionConfig = { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 };
    const service = makeService(storage, { sources: baseSources, fusion: fusionConfig });

    // Initial fuse writes the artifact under the current algorithm version.
    const first = await service.fuseDay("2026-06-10");
    assert.equal(first.written, true);
    const currentHash = first.contentHash;

    // Unchanged inputs + same version => idempotent skip.
    const rerun = await service.fuseDay("2026-06-10");
    assert.equal(rerun.written, false, "same version must be idempotent");

    // Simulate a pre-bump artifact: reconstruct the same inputs the service
    // fuses and compute the day hash under a STALE algorithm version, then
    // overwrite the stored artifact with the SAME body but that stale hash.
    const bodies = await Promise.all(
      ["limitless", "bee"].map(async (source) => {
        const raw = await storage.readWearableDayTranscript(source, "2026-06-10");
        const parsed = parseDayTranscript(raw ?? "");
        return {
          source,
          body: parsed?.body ?? raw ?? "",
          escaped: bodyIsEscaped(parsed?.meta),
        };
      }),
    );
    const reconstructed = reconstructFusionInputs("2026-06-10", bodies);
    const staleHash = canonicalDayKey(
      "2026-06-10",
      reconstructed,
      {
        proximityGapMs: 300_000,
        windowToleranceMs: 30_000,
        sourceTrust: { limitless: DEFAULT_SOURCE_TRUST, bee: DEFAULT_SOURCE_TRUST },
      },
      "2000-01-01-stale",
    );
    assert.notEqual(staleHash, currentHash, "sanity: stale-version hash differs");
    // Sanity: the current-version hash matches what the service produced —
    // the only difference between staleHash and currentHash is the version.
    assert.equal(
      canonicalDayKey(
        "2026-06-10",
        reconstructed,
        {
          proximityGapMs: 300_000,
          windowToleranceMs: 30_000,
          sourceTrust: { limitless: DEFAULT_SOURCE_TRUST, bee: DEFAULT_SOURCE_TRUST },
        },
        FUSION_ALGO_VERSION,
      ),
      currentHash,
      "sanity: canonicalDayKey with the current version matches fuseDay output",
    );

    // Overwrite the stored artifact with the SAME conversations but the stale
    // contentHash (same body => same bodyHash; only the version-derived
    // contentHash differs).
    const store = storage.fusionArtifactStore();
    const rawArtifact = await store.readFusedDay("2026-06-10");
    const parsedArtifact = parseFusionDay(rawArtifact ?? "");
    assert.ok(parsedArtifact, "artifact must exist after initial fuse");
    const staleMeta = composeFusionDayMeta(
      "2026-06-10",
      parsedArtifact!.conversations,
      [...first.sources].sort(),
      staleHash,
      parsedArtifact!.meta.fusedAt,
    );
    await store.writeFusedDay(
      "2026-06-10",
      serializeFusionDay(staleMeta, parsedArtifact!.conversations),
    );

    // Re-fuse: the recomputed hash (current version) != stale stored hash, so
    // the artifact is regenerated rather than skipped.
    const afterStale = await service.fuseDay("2026-06-10");
    assert.equal(afterStale.written, true, "stale algo-version artifact must be regenerated");
    assert.equal(afterStale.contentHash, currentHash, "regenerated hash matches the current algorithm");
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});
test("fuseDay rewrites an artifact whose body is corrupt despite a matching contentHash", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // Two enabled sources recorded the same overlapping window.
    storeDay(storage, "limitless", "2026-06-10", ["We agreed to ship Friday."]);
    storeDay(storage, "bee", "2026-06-10", ["We agreed to ship Friday."]);
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: {
        enabled: true,
        proximityGapMs: 300_000,
        windowToleranceMs: 30_000,
      },
    });

    // Initial fuse writes a valid artifact.
    const first = await service.fuseDay("2026-06-10");
    assert.equal(first.written, true);
    assert.ok(first.conversationCount >= 1, "overlapping sources fuse into >=1 conversation");
    const hash = first.contentHash;

    // Corrupt the stored body while leaving the frontmatter (incl.
    // contentHash) intact: a truncated/garbled JSON body that the lenient
    // read parser reduces to zero conversations.
    const fusionStore = storage.fusionArtifactStore();
    const validRaw = await fusionStore.readFusedDay("2026-06-10");
    assert.ok(validRaw);
    const closeIdx = validRaw!.indexOf("\n---\n", 4);
    assert.ok(closeIdx !== -1, "fused artifact has a closing frontmatter delimiter");
    const corruptRaw = `${validRaw!.slice(0, closeIdx + 5)}\n{ this is not valid JSON`;
    await fusionStore.writeFusedDay("2026-06-10", corruptRaw);

    // The corrupted artifact surfaces as a corrupt-artifact error, not a
    // clean empty list (issue #1849).
    await assert.rejects(service.fusedConversations("2026-06-10"), /corrupt/);

    // Re-fuse: matching contentHash but a corrupt body => self-repair
    // (written: true), not a silent skip that leaves the bad file in place.
    const repaired = await service.fuseDay("2026-06-10");
    assert.equal(repaired.written, true, "a corrupt body must be rewritten despite a matching hash");
    assert.equal(repaired.contentHash, hash, "inputs+config are unchanged so the hash is stable");
    assert.equal(repaired.conversationCount, first.conversationCount);

    // Subsequent read returns the correct conversations again.
    const conversations = await service.fusedConversations("2026-06-10");
    assert.equal(conversations.length, first.conversationCount);
    assert.ok(conversations[0]!.id.startsWith("fusion-"));
    assert.deepEqual(
      [...conversations[0]!.sources].sort(),
      ["bee", "limitless"],
    );

    // A final re-run is idempotent again: the repaired body is valid, so
    // it is skipped (written: false), proving the rewrite was a one-off
    // self-repair rather than a permanent forced write.
    const idempotent = await service.fuseDay("2026-06-10");
    assert.equal(idempotent.written, false, "a repaired artifact must skip on the next run");
    assert.equal(idempotent.contentHash, hash);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay rewrites a corrupt body even when the expected conversation count is zero", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // No stored transcripts for this day -> fusion yields ZERO conversations.
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: {
        enabled: true,
        proximityGapMs: 300_000,
        windowToleranceMs: 30_000,
      },
    });

    // First fuse writes a valid (empty) artifact.
    const first = await service.fuseDay("2026-06-10");
    assert.equal(first.written, true);
    assert.equal(first.conversationCount, 0);
    const hash = first.contentHash;

    // A legitimately-empty ([] body) artifact must SKIP on re-run: same
    // inputs + config, clean parse, 0 == 0 -> not rewritten.
    const idempotent = await service.fuseDay("2026-06-10");
    assert.equal(idempotent.written, false, "a valid empty body must skip");
    assert.equal(idempotent.contentHash, hash);

    // Corrupt the stored body while leaving the frontmatter (incl.
    // contentHash) intact: truncated JSON that the lenient read parser
    // reduces to zero conversations.
    const fusionStore = storage.fusionArtifactStore();
    const validRaw = await fusionStore.readFusedDay("2026-06-10");
    assert.ok(validRaw);
    const closeIdx = validRaw!.indexOf("\n---\n", 4);
    assert.ok(closeIdx !== -1, "fused artifact has a closing frontmatter delimiter");
    const corruptRaw = `${validRaw!.slice(0, closeIdx + 5)}\n{ this is not valid JSON`;
    await fusionStore.writeFusedDay("2026-06-10", corruptRaw);

    // The corrupted body surfaces as a corrupt-artifact error (not a clean
    // empty), and the recomputed result is ALSO zero — without the parseOk
    // signal this 0 == 0 match plus a matching hash would silently skip
    // and leave the bad file.
    await assert.rejects(service.fusedConversations("2026-06-10"), /corrupt/);

    // Re-fuse: matching hash + 0 == 0 but a corrupt body (parseOk:false)
    // => self-repair (written: true), not a silent skip.
    const repaired = await service.fuseDay("2026-06-10");
    assert.equal(
      repaired.written,
      true,
      "a corrupt body must be rewritten even when the expected count is zero",
    );
    assert.equal(repaired.contentHash, hash);
    assert.equal(repaired.conversationCount, 0);

    // A final re-run is idempotent again: the repaired body parses cleanly,
    // so it skips (written: false), proving the rewrite was a one-off
    // self-repair rather than a permanent forced write.
    const final = await service.fuseDay("2026-06-10");
    assert.equal(final.written, false, "a repaired artifact must skip on the next run");
    assert.equal(final.contentHash, hash);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay rewrites an artifact whose body has malformed elements despite matching hash + bodyHash + count", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    storeDay(storage, "limitless", "2026-06-10", ["We agreed to ship Friday."]);
    storeDay(storage, "bee", "2026-06-10", ["We agreed to ship Friday."]);
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    const first = await service.fuseDay("2026-06-10");
    assert.equal(first.written, true);
    assert.ok(first.conversationCount >= 1);
    const hash = first.contentHash;

    // Replace ONLY the body with a parseable-but-malformed array `[{}]`,
    // leaving every frontmatter field (contentHash, bodyHash, count)
    // intact. The body parses as JSON and is an array, but its element is
    // not a well-formed FusedWearableConversation — element validation
    // must drive parseOk:false so fuseDay rewrites rather than trusting
    // the matching hashes + count.
    const fusionStore = storage.fusionArtifactStore();
    const validRaw = await fusionStore.readFusedDay("2026-06-10");
    assert.ok(validRaw);
    const closeIdx = validRaw!.indexOf("\n---\n", 4);
    assert.ok(closeIdx !== -1);
    await fusionStore.writeFusedDay("2026-06-10", `${validRaw!.slice(0, closeIdx + 5)}\n[{}]`);

    // The malformed body surfaces as a corrupt-artifact error (issue #1849).
    await assert.rejects(service.fusedConversations("2026-06-10"), /corrupt/);

    // Re-fuse: matching hash + bodyHash + count but parseOk:false => rewrite.
    const repaired = await service.fuseDay("2026-06-10");
    assert.equal(repaired.written, true, "a malformed-element body must be rewritten");
    assert.equal(repaired.contentHash, hash);
    assert.equal(repaired.conversationCount, first.conversationCount);

    // Repaired body is valid again, so the next run skips idempotently.
    const idempotent = await service.fuseDay("2026-06-10");
    assert.equal(idempotent.written, false, "a repaired artifact must skip on the next run");
    assert.equal(idempotent.contentHash, hash);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fusedConversations surfaces a corrupt artifact distinctly, not as a clean empty (issue #1849)", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    storeDay(storage, "limitless", "2026-06-10", ["We agreed to ship Friday."]);
    storeDay(storage, "bee", "2026-06-10", ["We agreed to ship Friday."]);
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    // Initial fuse writes a valid artifact with >= 1 conversation.
    const first = await service.fuseDay("2026-06-10");
    assert.ok(first.conversationCount >= 1);

    // A day that was never fused returns [] — the "no artifact" path.
    assert.deepEqual(await service.fusedConversations("2026-07-01"), []);

    // Corrupt the body: valid frontmatter, garbled JSON body.
    const fusionStore = storage.fusionArtifactStore();
    const validRaw = await fusionStore.readFusedDay("2026-06-10");
    assert.ok(validRaw);
    const closeIdx = validRaw!.indexOf("\n---\n", 4);
    assert.ok(closeIdx !== -1);
    await fusionStore.writeFusedDay(
      "2026-06-10",
      `${validRaw!.slice(0, closeIdx + 5)}\n{ this is not valid JSON`,
    );

    // The corrupt artifact must NOT look like "no conversations" — it must
    // throw so the caller/CLI can distinguish corruption from absence and
    // prompt a re-fuse, rather than silently returning an empty list.
    await assert.rejects(
      service.fusedConversations("2026-06-10"),
      /corrupt/,
    );

    // The "never fused" path is unchanged — still returns [].
    assert.deepEqual(await service.fusedConversations("2026-07-01"), []);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay rewrites an artifact whose body bytes drifted despite matching contentHash + count", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    storeDay(storage, "limitless", "2026-06-10", ["We agreed to ship Friday."]);
    storeDay(storage, "bee", "2026-06-10", ["We agreed to ship Friday."]);
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    const first = await service.fuseDay("2026-06-10");
    assert.equal(first.written, true);
    assert.ok(first.conversationCount >= 1);
    const hash = first.contentHash;

    // Tamper: keep the body structurally valid (parses, every element is a
    // well-formed conversation, same conversation count) but ALTER its
    // bytes, leaving the frontmatter (contentHash + bodyHash + count)
    // untouched. parseOk stays true and contentHash still matches, so only
    // the body-hash recompute over the stored body can catch the drift.
    const fusionStore = storage.fusionArtifactStore();
    const validRaw = await fusionStore.readFusedDay("2026-06-10");
    assert.ok(validRaw);
    const closeIdx = validRaw!.indexOf("\n---\n", 4);
    assert.ok(closeIdx !== -1);
    const header = validRaw!.slice(0, closeIdx + 5);
    const bodyJson = validRaw!.slice(closeIdx + 5).replace(/^\n/, "").trimEnd();
    const convs = JSON.parse(bodyJson) as Array<{ segments: Array<{ text: string }> }>;
    convs[0]!.segments[0]!.text += " [tampered]";
    await fusionStore.writeFusedDay(
      "2026-06-10",
      `${header}\n${JSON.stringify(convs, null, 2)}\n`,
    );

    // The tampered body still parses cleanly (valid structure + elements),
    // so it is served until the next fuseDay repairs it.
    const tampered = await service.fusedConversations("2026-06-10");
    assert.equal(tampered.length, first.conversationCount);
    assert.ok(tampered[0]!.segments[0]!.text.includes("[tampered]"));

    // Re-fuse: contentHash matches + parseOk true, but the stored body
    // hash no longer matches a recompute over the stored body => rewrite.
    const repaired = await service.fuseDay("2026-06-10");
    assert.equal(
      repaired.written,
      true,
      "a byte-drifted body must be rewritten via the body-hash check",
    );
    assert.equal(repaired.contentHash, hash);
    assert.equal(repaired.conversationCount, first.conversationCount);

    // The repaired body no longer carries the tampered text.
    const restored = await service.fusedConversations("2026-06-10");
    assert.ok(!restored[0]!.segments[0]!.text.includes("[tampered]"));

    const idempotent = await service.fuseDay("2026-06-10");
    assert.equal(idempotent.written, false);
    assert.equal(idempotent.contentHash, hash);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay skips a day whose sources were rendered under conflicting timezones", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // Two enabled sources recorded the same window but in DIFFERENT
    // timezones whose UTC offsets genuinely differ on this date
    // (America/Los_Angeles is UTC-7 in summer; Asia/Tokyo is UTC+9).
    storeDay(
      storage,
      "limitless",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "America/Los_Angeles",
    );
    storeDay(
      storage,
      "bee",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "Asia/Tokyo",
    );
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    const result = await service.fuseDay("2026-06-10");
    // Fail-safe: the day is skipped with a reason, not silently misaligned.
    assert.equal(result.written, false);
    assert.equal(result.skipped?.reason, "conflicting-timezones");
    assert.equal(result.sources.length, 0);
    // No artifact is written for the conflicting day.
    assert.equal(await storage.fusionArtifactStore().readFusedDay("2026-06-10"), null);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay clears a stale fused artifact when a later run skips on conflicting timezones", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // First, both sources share one timezone -> the day fuses successfully.
    storeDay(
      storage,
      "limitless",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "America/Los_Angeles",
    );
    storeDay(
      storage,
      "bee",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "America/Los_Angeles",
    );
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    const first = await service.fuseDay("2026-06-10");
    assert.equal(first.written, true);
    assert.ok(first.conversationCount >= 1, "same-timezone sources fuse");
    // A fused artifact now exists and is served by the listing surface.
    assert.notEqual(await storage.fusionArtifactStore().readFusedDay("2026-06-10"), null);
    assert.ok((await service.fusedConversations("2026-06-10")).length >= 1);

    // Later sync: bee's source is re-rendered under a DIFFERENT timezone
    // (Asia/Tokyo, UTC+9), conflicting with limitless (UTC-7 in summer).
    storeDay(
      storage,
      "bee",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "Asia/Tokyo",
    );

    // Re-fuse: the day is now skipped, and the stale artifact MUST be
    // cleared so fusedConversations() stops serving it (issue #1849).
    const result = await service.fuseDay("2026-06-10");
    assert.equal(result.written, false);
    assert.equal(result.skipped?.reason, "conflicting-timezones");
    assert.equal(await storage.fusionArtifactStore().readFusedDay("2026-06-10"), null);
    assert.equal((await service.fusedConversations("2026-06-10")).length, 0);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay skips sources that share a UTC offset but differ in timezone id", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // America/Los_Angeles and America/Tijuana are both UTC-7 on this
    // summer date, so the OLD noon-offset guard fused them. Under the
    // tz-identity model their DIFFERENT IANA ids must skip instead:
    // reconstructFusionInputs only compares local HH:MM clocks safely
    // when every source carries one explicit, identical tz id.
    storeDay(
      storage,
      "limitless",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "America/Los_Angeles",
    );
    storeDay(
      storage,
      "bee",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "America/Tijuana",
    );
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    const result = await service.fuseDay("2026-06-10");
    assert.equal(result.written, false, "differing tz ids skip even at equal offset");
    assert.equal(result.skipped?.reason, "conflicting-timezones");
    assert.equal(result.sources.length, 0);
    assert.equal(await storage.fusionArtifactStore().readFusedDay("2026-06-10"), null);
    assert.equal((await service.fusedConversations("2026-06-10")).length, 0);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay skips a DST-date pair whose noon offsets coincide (LA vs Phoenix on 2026-03-08)", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // Regression for the codex finding: on 2026-03-08 America/Los_Angeles
    // springs forward (UTC-8 -> UTC-7) at 02:00 while America/Phoenix
    // stays UTC-7 all day. Both zones are UTC-7 by local NOON, so the old
    // single-offset guard fused the day — yet recordings before LA's
    // switch sat an hour apart and were misaligned on the fused timeline.
    // Exact tz-id identity now refuses this pair up front.
    storeDay(
      storage,
      "limitless",
      "2026-03-08",
      ["Morning standup before the DST switch."],
      "America/Los_Angeles",
    );
    storeDay(
      storage,
      "bee",
      "2026-03-08",
      ["Morning standup before the DST switch."],
      "America/Phoenix",
    );
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    const result = await service.fuseDay("2026-03-08");
    assert.equal(result.written, false, "DST-date coincident-offset pair skips");
    assert.equal(result.skipped?.reason, "conflicting-timezones");
    assert.equal(result.sources.length, 0);
    assert.equal(await storage.fusionArtifactStore().readFusedDay("2026-03-08"), null);
    assert.equal((await service.fusedConversations("2026-03-08")).length, 0);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay skips when a source lacks a resolvable timezone id", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // limitless carries an explicit tz id; bee's transcript is missing the
    // timezone field entirely. The guard must NOT coerce the missing id to
    // a default and silently match — any unresolvable tz fails safe.
    storeDay(
      storage,
      "limitless",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "America/Los_Angeles",
    );
    // Build bee's transcript the normal way, then strip the timezone line
    // so the persisted frontmatter has no resolvable tz id.
    const registry = emptySpeakerRegistry();
    const conversations: WearableConversation[] = [
      {
        id: "bee-2026-06-10",
        source: "bee",
        title: "Stored conversation",
        startIso: "2026-06-10T10:00:00.000Z",
        endIso: "2026-06-10T10:30:00.000Z",
        segments: [{ speakerKey: "user", isWearer: true, text: "We agreed to ship Friday." }],
      },
    ];
    const beeBody = composeDayTranscriptBody(
      "bee",
      "2026-06-10",
      "UTC",
      conversations,
      registry,
    );
    const beeMeta = composeDayTranscriptMeta(
      "bee",
      "2026-06-10",
      "UTC",
      conversations,
      registry,
      beeBody,
      "2026-06-11T01:00:00.000Z",
    );
    const beeRaw = serializeDayTranscript(beeMeta, beeBody).replace(/^timezone: .*\n/m, "");
    storage.files.set("bee/2026-06-10", beeRaw);

    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    const result = await service.fuseDay("2026-06-10");
    assert.equal(result.written, false, "a missing tz id fails safe");
    assert.equal(result.skipped?.reason, "conflicting-timezones");
    assert.equal(result.sources.length, 0);
    assert.equal(await storage.fusionArtifactStore().readFusedDay("2026-06-10"), null);
    assert.equal((await service.fusedConversations("2026-06-10")).length, 0);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay ignores a zero-conversation source when checking timezone identity (issue #1849)", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // limitless CONTRIBUTES a real conversation under one timezone.
    storeDay(
      storage,
      "limitless",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "America/Los_Angeles",
    );
    // bee is an EMPTY (all-elided / zero-conversation) transcript — the
    // sync path writes one explicitly for days whose segments were all
    // dropped. It carries a DIFFERENT timezone, but contributes NO
    // conversations/clocks, so it must not block the fusion.
    const registry = emptySpeakerRegistry();
    const beeBody = composeDayTranscriptBody(
      "bee",
      "2026-06-10",
      "Asia/Tokyo",
      [],
      registry,
    );
    const beeMeta = composeDayTranscriptMeta(
      "bee",
      "2026-06-10",
      "Asia/Tokyo",
      [],
      registry,
      beeBody,
      "2026-06-11T01:00:00.000Z",
    );
    storage.files.set("bee/2026-06-10", serializeDayTranscript(beeMeta, beeBody));

    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    const result = await service.fuseDay("2026-06-10");
    // The zero-conversation source is ignored; the single contributing
    // source fuses normally (NOT skipped).
    assert.equal(result.written, true, "a zero-conversation source must not block fusion");
    assert.equal(result.skipped, undefined);
    assert.ok(result.conversationCount >= 1, "the contributing source still fuses");
    assert.deepEqual([...result.sources].sort(), ["limitless"]);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});

test("fuseDay still skips when two CONTRIBUTING sources disagree on timezone (issue #1849)", async () => {
  const storage = makeStorage(mkdtempSync(path.join(tmpdir(), "remnic-fusion-")));
  try {
    // Both sources CONTRIBUTE a real conversation but under DIFFERENT
    // timezones — the guard must still skip. This is the contrasting case
    // to ignoring zero-conversation sources: only sources that actually
    // contribute clocks are compared, and two disagreeing contributors skip.
    storeDay(
      storage,
      "limitless",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "America/Los_Angeles",
    );
    storeDay(
      storage,
      "bee",
      "2026-06-10",
      ["We agreed to ship Friday."],
      "Asia/Tokyo",
    );
    const service = makeService(storage, {
      sources: {
        limitless: { ...defaultWearableSourceSettings(), enabled: true },
        bee: { ...defaultWearableSourceSettings(), enabled: true },
      },
      fusion: { enabled: true, proximityGapMs: 300_000, windowToleranceMs: 30_000 },
    });

    const result = await service.fuseDay("2026-06-10");
    assert.equal(result.written, false, "two disagreeing contributing sources must skip");
    assert.equal(result.skipped?.reason, "conflicting-timezones");
    assert.equal(result.sources.length, 0);
    assert.equal(await storage.fusionArtifactStore().readFusedDay("2026-06-10"), null);
    assert.equal((await service.fusedConversations("2026-06-10")).length, 0);
  } finally {
    rmSync(storage.dir, { recursive: true, force: true });
  }
});


test("dayTranscript returns decoded segment text, not the escaped storage form (#1849)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    // Segment text carries a real newline + a literal backslash. The stored
    // file escapes both; the user-facing view must decode them back.
    const original = "Line one.\nLine two with a backslash \\ path.";
    storeDay(storage, "limitless", "2026-06-10", [original]);
    const service = makeService(storage);
    const views = await service.dayTranscript("2026-06-10");
    assert.equal(views.length, 1);
    assert.ok(views[0].body.includes(original), "view shows the original (decoded) text");
    assert.ok(
      views[0].body.includes("Line one.\\nLine two") === false,
      "no escaped-newline leak in the user-facing view",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchTranscripts scan decodes segment text so snippets show the original (#1849)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-service-"));
  try {
    const storage = makeStorage(dir);
    // Segment text spans a newline; the escaped storage form would leak a
    // literal backslash-n into the snippet unless the scan decodes first.
    storeDay(storage, "limitless", "2026-06-10", ["Alpha part.\nBeta GAPWORD here."]);
    const service = makeService(storage);
    const results = await service.searchTranscripts("GAPWORD");
    assert.equal(results.length, 1);
    assert.equal(results[0].backend, "scan");
    assert.ok(results[0].snippet.includes("GAPWORD"));
    assert.ok(
      results[0].snippet.includes("Alpha part.\\nBeta") === false,
      "snippet has no escaped-newline leak",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
