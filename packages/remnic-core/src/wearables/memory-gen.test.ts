import assert from "node:assert/strict";
import { test } from "node:test";

import type { BufferTurn, ExtractionResult } from "../types.js";
import {
  buildExtractionTurns,
  generateWearableMemories,
  importNativeMemories,
  memoryStatusForMode,
  writeDailyDigestMemory,
  type WearableMemoryWriter,
} from "./memory-gen.js";
import { emptySpeakerRegistry } from "./speakers.js";
import type { WearableConversation, WearableSourceSettings } from "./types.js";

const REGISTRY = emptySpeakerRegistry();

function settings(
  overrides: Partial<WearableSourceSettings> = {},
): WearableSourceSettings {
  return {
    enabled: true,
    memoryMode: "review",
    minConfidence: 0.6,
    minImportance: "low",
    maxMemoriesPerDay: 20,
    importNativeMemories: "off",
    cleanup: {
      mergeSameSpeaker: true,
      stripFillers: true,
      collapseRepeats: true,
      dropLowQuality: true,
    },
    ...overrides,
  };
}

function conversation(
  id: string,
  texts: string[],
): WearableConversation {
  return {
    id,
    source: "limitless",
    title: "Planning chat",
    startIso: "2026-06-10T15:00:00Z",
    endIso: "2026-06-10T15:30:00Z",
    segments: texts.map((text, index) => ({
      speakerKey: index % 2 === 0 ? "user" : "Speaker 2",
      isWearer: index % 2 === 0,
      text,
    })),
  };
}

const LONG_CONVERSATION = conversation("conv-1", [
  "I decided we are moving the launch to September twelfth, that is final.",
  "Sounds good, I will tell the vendor about the new date tomorrow morning.",
  "Also remember that my daughter's recital is on Friday at six pm sharp.",
]);

interface WriteCall {
  category: string;
  content: string;
  options: Record<string, unknown>;
}

function makeWriter(existingHashes: string[] = []): {
  writer: WearableMemoryWriter;
  writes: WriteCall[];
} {
  const writes: WriteCall[] = [];
  const existing = new Set(existingHashes);
  return {
    writes,
    writer: {
      async writeMemory(category, content, options) {
        writes.push({ category, content, options: options as Record<string, unknown> });
        return `id-${writes.length}`;
      },
      async hasFactContentHash(content) {
        return existing.has(content);
      },
    },
  };
}

function extractionReturning(
  facts: ExtractionResult["facts"],
): (turns: BufferTurn[]) => Promise<ExtractionResult> {
  return async () => ({
    facts,
    profileUpdates: [],
    entities: [],
    questions: [],
  });
}

test("buildExtractionTurns labels speakers, marks the wearer, and chunks", () => {
  const turns = buildExtractionTurns("limitless", "2026-06-10", LONG_CONVERSATION, REGISTRY);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].role, "user");
  assert.match(turns[0].content, /Me \(you\): I decided we are moving the launch/);
  assert.match(turns[0].content, /Speaker 2: Sounds good/);
  assert.match(turns[0].content, /Wearable transcript \(limitless\) — 2026-06-10/);
  assert.equal(turns[0].sourceValidAt, "2026-06-10T15:00:00Z");
});

test("buildExtractionTurns skips conversations with no substance", () => {
  const turns = buildExtractionTurns(
    "limitless",
    "2026-06-10",
    conversation("tiny", ["ok", "yes"]),
    REGISTRY,
  );
  assert.equal(turns.length, 0);
});

test("memoryStatusForMode maps review to pending_review and auto to active", () => {
  assert.equal(memoryStatusForMode("review"), "pending_review");
  assert.equal(memoryStatusForMode("off"), "pending_review");
  assert.equal(memoryStatusForMode("auto"), "active");
});

test("mode off never extracts or writes", async () => {
  const { writer, writes } = makeWriter();
  let extracted = 0;
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "off" }),
    REGISTRY,
    {
      extract: async () => {
        extracted += 1;
        return { facts: [], profileUpdates: [], entities: [], questions: [] };
      },
      writer,
    },
  );
  assert.equal(extracted, 0);
  assert.equal(writes.length, 0);
  assert.equal(result.created, 0);
});

test("review mode writes pending_review with full wearable provenance", async () => {
  const { writer, writes } = makeWriter();
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings(),
    REGISTRY,
    {
      extract: extractionReturning([
        {
          category: "decision",
          content: "Launch moved to September 12.",
          confidence: 0.9,
          tags: ["launch"],
        },
      ]),
      writer,
    },
  );
  assert.equal(result.created, 1);
  assert.equal(writes.length, 1);
  const write = writes[0];
  assert.equal(write.category, "decision");
  assert.equal(write.options.status, "pending_review");
  assert.equal(write.options.source, "wearable:limitless");
  assert.equal(write.options.validAt, "2026-06-10T15:00:00Z");
  const attrs = write.options.structuredAttributes as Record<string, string>;
  assert.equal(attrs.wearableSource, "limitless");
  assert.equal(attrs.wearableDate, "2026-06-10");
  assert.equal(attrs.wearableConversationId, "conv-1");
  const tags = write.options.tags as string[];
  assert.ok(tags.includes("wearable"));
  assert.ok(tags.includes("wearable:limitless"));
  assert.ok(tags.includes("wearable-day:2026-06-10"));
});

test("auto mode writes active status", async () => {
  const { writer, writes } = makeWriter();
  await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "auto" }),
    REGISTRY,
    {
      extract: extractionReturning([
        { category: "fact", content: "Vendor call happens tomorrow morning.", confidence: 0.8, tags: [] },
      ]),
      writer,
    },
  );
  assert.equal(writes[0].options.status, "active");
});

test("gates: confidence floor, importance floor, dedup, and unsupported categories", async () => {
  const { writer, writes } = makeWriter(["Already stored fact about the vendor."]);
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ minConfidence: 0.7, minImportance: "low" }),
    REGISTRY,
    {
      extract: extractionReturning([
        { category: "fact", content: "Low confidence rumor.", confidence: 0.3, tags: [] },
        { category: "fact", content: "ok", confidence: 0.9, tags: [] },
        { category: "procedure", content: "Step one do thing.", confidence: 0.9, tags: [] },
        { category: "fact", content: "Already stored fact about the vendor.", confidence: 0.9, tags: [] },
        { category: "fact", content: "Recital is Friday at 6pm.", confidence: 0.9, tags: [] },
        { category: "fact", content: "Recital is Friday at 6pm.", confidence: 0.9, tags: [] },
      ]),
      writer,
    },
  );
  assert.equal(result.created, 1);
  assert.equal(writes[0].content, "Recital is Friday at 6pm.");
  assert.equal(result.skippedByReason["below-confidence"], 1);
  assert.equal(result.skippedByReason["below-importance"], 1);
  assert.equal(result.skippedByReason["unsupported-category"], 1);
  assert.equal(result.skippedByReason["duplicate-existing"], 1);
  assert.equal(result.skippedByReason["duplicate-in-run"], 1);
});

test("day cap keeps the most important candidates; 0 disables the cap", async () => {
  const facts = [
    { category: "fact" as const, content: "I prefer the aisle seat on long flights always.", confidence: 0.9, tags: [] },
    { category: "decision" as const, content: "Critical: I decided to sign the ACME contract.", confidence: 0.95, tags: [] },
    { category: "fact" as const, content: "We talked about the weather being warm lately.", confidence: 0.9, tags: [] },
  ];
  {
    const { writer, writes } = makeWriter();
    const result = await generateWearableMemories(
      "limitless",
      "2026-06-10",
      [LONG_CONVERSATION],
      settings({ maxMemoriesPerDay: 1 }),
      REGISTRY,
      { extract: extractionReturning(facts), writer },
    );
    assert.equal(result.created, 1);
    assert.equal(result.skippedByReason["over-day-cap"], 2);
    assert.match(writes[0].content, /ACME contract/);
  }
  {
    const { writer, writes } = makeWriter();
    await generateWearableMemories(
      "limitless",
      "2026-06-10",
      [LONG_CONVERSATION],
      settings({ maxMemoriesPerDay: 0 }),
      REGISTRY,
      { extract: extractionReturning(facts), writer },
    );
    assert.equal(writes.length, 3, "cap of 0 must disable the limit");
  }
});

test("an extraction failure aborts with one warning instead of hammering the engine", async () => {
  const { writer, writes } = makeWriter();
  let calls = 0;
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [conversation("a", [LONG_CONVERSATION.segments[0].text, LONG_CONVERSATION.segments[1].text, LONG_CONVERSATION.segments[2].text]), LONG_CONVERSATION],
    settings(),
    REGISTRY,
    {
      extract: async () => {
        calls += 1;
        throw new Error("provider exploded");
      },
      writer,
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.warnings.length, 1);
  // Foreign error text is reduced to the error class (project-standard
  // displayErrorDetail semantics) — the message itself never surfaces.
  assert.match(result.warnings[0], /extraction failed for limitless\/2026-06-10/);
  assert.ok(!result.warnings[0].includes("provider exploded"));
  assert.equal(writes.length, 0);
});

test("daily digest writes one deterministic episode memory and dedups", async () => {
  const { writer, writes } = makeWriter();
  const wrote = await writeDailyDigestMemory(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings(),
    REGISTRY,
    writer,
  );
  assert.equal(wrote, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].category, "moment");
  assert.equal(writes[0].options.memoryKind, "episode");
  assert.match(writes[0].content, /Wearable day digest — limitless, 2026-06-10/);
  assert.match(writes[0].content, /Planning chat \(2 speakers\)/);

  const { writer: writer2, writes: writes2 } = makeWriter([writes[0].content]);
  const wroteAgain = await writeDailyDigestMemory(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings(),
    REGISTRY,
    writer2,
  );
  assert.equal(wroteAgain, false);
  assert.equal(writes2.length, 0);
});

test("native memories always import as pending_review and respect prior imports", async () => {
  const { writer, writes } = makeWriter(["Provider fact already in Remnic."]);
  const result = await importNativeMemories(
    "bee",
    [
      { id: "n1", content: "User enjoys morning runs by the lake." },
      { id: "n2", content: "Provider fact already in Remnic." },
      { id: "n3", content: "User enjoys morning runs by the lake. " },
      { id: "n4", content: "" },
      { id: "n5", content: "Previously imported." },
    ],
    new Set(["n5"]),
    writer,
  );
  // n1 imports; n2 dedups against existing storage; n3 dedups against
  // n1 within the run; n4 is empty; n5 was imported on a prior sync.
  assert.equal(result.imported, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.status, "pending_review");
  assert.equal(writes[0].options.source, "wearable:bee:native");
  assert.deepEqual(result.importedIds.sort(), ["n1", "n2", "n3"]);
});
