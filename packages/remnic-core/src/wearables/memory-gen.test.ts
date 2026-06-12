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
    sourceTrust: 0.8,
    autoApproveTrust: 0.7,
    reviewTrust: 0.45,
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

function judgeReturning(
  kinds: Array<"accept" | "reject" | "defer">,
): NonNullable<Parameters<typeof generateWearableMemories>[5]["judgeFacts"]> {
  return async (candidates) => ({
    verdicts: new Map(
      candidates.map((_, index) => [
        index,
        {
          kind: kinds[index] ?? "accept",
          durable: (kinds[index] ?? "accept") === "accept",
          reason: "test",
        } as never,
      ]),
    ),
    cached: 0,
    judged: candidates.length,
    elapsed: 1,
    deferred: 0,
    deferredCappedToReject: 0,
  });
}

test("smart mode: judge verdicts gate active/review/drop with trust metadata", async () => {
  const { writer, writes } = makeWriter();
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }),
    REGISTRY,
    {
      extract: extractionReturning([
        { category: "decision", content: "Launch moved to September twelfth after the vendor call.", confidence: 0.9, tags: [] },
        { category: "fact", content: "Something the judge thinks is not durable at all.", confidence: 0.9, tags: [] },
        { category: "fact", content: "An ambiguous statement the judge wants to defer on.", confidence: 0.9, tags: [] },
      ]),
      writer,
      judgeFacts: judgeReturning(["accept", "reject", "defer"]),
    },
  );
  // accept @ 0.9*0.8 + 0.15 = 0.87 -> active; reject -> drop; defer -> review.
  assert.equal(result.created, 2);
  assert.equal(result.skippedByReason["judge-rejected"], 1);
  const byContent = new Map(writes.map((write) => [write.content, write]));
  const active = byContent.get("Launch moved to September twelfth after the vendor call.");
  assert.ok(active);
  assert.equal(active.options.status, "active");
  const attrs = active.options.structuredAttributes as Record<string, string>;
  assert.equal(attrs.judgeVerdict, "accept");
  assert.equal(attrs.trustDecision, "auto-approved");
  assert.ok(Number(attrs.trustScore) > 0.8);
  // trustScore persists rounded to 3 decimals; confidence carries the
  // raw float — compare within rounding tolerance.
  assert.ok(
    Math.abs((active.options.confidence as number) - Number(attrs.trustScore)) < 0.001,
  );
  const deferred = byContent.get("An ambiguous statement the judge wants to defer on.");
  assert.ok(deferred);
  assert.equal(deferred.options.status, "pending_review");
  assert.equal(
    (deferred.options.structuredAttributes as Record<string, string>).trustDecision,
    "judge-deferred",
  );
});

test("smart mode without a judge degrades to confidence x sourceTrust banding", async () => {
  const { writer, writes } = makeWriter();
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart", sourceTrust: 0.8 }),
    REGISTRY,
    {
      extract: extractionReturning([
        { category: "fact", content: "The vendor contract renews every October first.", confidence: 0.95, tags: [] },
        { category: "fact", content: "Someone mentioned maybe moving the standup earlier.", confidence: 0.7, tags: [] },
        { category: "fact", content: "A mumbled aside that was barely transcribed correctly.", confidence: 0.4, tags: [] },
      ]),
      writer,
    },
  );
  // 0.95*0.8=0.76 active; 0.7*0.8=0.56 review; 0.4*0.8=0.32 dropped.
  assert.equal(result.created, 2);
  assert.equal(result.skippedByReason["below-trust"], 1);
  const statuses = writes.map((write) => write.options.status).sort();
  assert.deepEqual(statuses, ["active", "pending_review"]);
});

test("smart mode: cross-device corroboration lifts a borderline fact to active", async () => {
  const { tokenizeDayBody } = await import("./trust.js");
  const fact = {
    category: "fact" as const,
    content: "The launch moved to September twelfth after the vendor call.",
    confidence: 0.75, // 0.75*0.8 = 0.6: review alone; +0.15 corroboration -> 0.75 active
    tags: [],
  };
  const beeDayTokens = tokenizeDayBody(
    "They said the launch moves to September twelfth right after that vendor call wrapped.",
  );

  const { writer: writerA, writes: writesA } = makeWriter();
  await generateWearableMemories(
    "limitless", "2026-06-10", [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }), REGISTRY,
    { extract: extractionReturning([fact]), writer: writerA },
  );
  const { writer: writerB, writes: writesB } = makeWriter();
  await generateWearableMemories(
    "limitless", "2026-06-10", [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }), REGISTRY,
    {
      extract: extractionReturning([fact]),
      writer: writerB,
      corroboration: {
        otherSourceDayTokens: new Map([["bee", beeDayTokens]]),
        existingMemories: [],
      },
    },
  );
  assert.equal(writesA[0].options.status, "pending_review", "uncorroborated stays in review");
  assert.equal(writesB[0].options.status, "active", "corroborated crosses the auto threshold");
  const attrs = writesB[0].options.structuredAttributes as Record<string, string>;
  assert.equal(attrs.corroboratedBySources, "bee");
});

test("smart mode: a judge failure degrades with a warning instead of aborting", async () => {
  const { writer, writes } = makeWriter();
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }),
    REGISTRY,
    {
      extract: extractionReturning([
        { category: "fact", content: "The vendor contract renews every October first.", confidence: 0.95, tags: [] },
      ]),
      writer,
      judgeFacts: async () => {
        throw new Error("judge backend down");
      },
    },
  );
  assert.equal(result.created, 1);
  assert.equal(writes[0].options.status, "active");
  assert.ok(result.warnings.some((warning) => warning.includes("judge unavailable")));
});

test("smart mode: dropped facts never consume day-cap slots", async () => {
  const { writer, writes } = makeWriter();
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart", maxMemoriesPerDay: 1 }),
    REGISTRY,
    {
      extract: extractionReturning([
        // Highest trust but judge-rejected — must not occupy the only slot.
        { category: "fact", content: "A high-confidence fact the judge rejects as not durable.", confidence: 0.99, tags: [] },
        { category: "fact", content: "The vendor contract renews every October first as agreed.", confidence: 0.95, tags: [] },
      ]),
      writer,
      judgeFacts: judgeReturning(["reject", "accept"]),
    },
  );
  assert.equal(result.created, 1, "the surviving fact gets the slot");
  assert.equal(writes[0].content, "The vendor contract renews every October first as agreed.");
  assert.equal(result.skippedByReason["judge-rejected"], 1);
  assert.equal(result.skippedByReason["over-day-cap"], undefined, "no slot wasted on the drop");
});

test("a judge failure leaves the pass completed; extraction failure does not", async () => {
  const { writer } = makeWriter();
  const judgeDown = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }),
    REGISTRY,
    {
      extract: extractionReturning([
        { category: "fact", content: "The vendor contract renews every October first.", confidence: 0.95, tags: [] },
      ]),
      writer,
      judgeFacts: async () => {
        throw new Error("judge backend down");
      },
    },
  );
  assert.equal(judgeDown.completed, true, "degraded pass is still complete");
  assert.ok(judgeDown.warnings.length > 0);

  const extractDown = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }),
    REGISTRY,
    {
      extract: async () => {
        throw new Error("engine outage");
      },
      writer,
    },
  );
  assert.equal(extractDown.completed, false, "aborted extraction must retry");
});

test("smart native import: judge gates writes; dropped ids re-score on later syncs", async () => {
  const { writer, writes } = makeWriter();
  const result = await importNativeMemories(
    "omi",
    [
      { id: "n1", content: "User volunteers at the food bank every month with the team." },
      { id: "n2", content: "Garbage provider extraction that should never persist." },
    ],
    new Set(),
    settings({ memoryMode: "smart", importNativeMemories: "smart" }),
    {
      extract: extractionReturning([]),
      writer,
      judgeFacts: judgeReturning(["accept", "reject"]),
    },
  );
  // accept: 0.7 * (0.8*0.9) + 0.15 = 0.654 -> review band (no corroboration).
  assert.equal(result.imported, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.status, "pending_review");
  const attrs = writes[0].options.structuredAttributes as Record<string, string>;
  assert.equal(attrs.judgeVerdict, "accept");
  // Dropped facts are deliberately NOT tracked: later corpus or
  // corroboration support must be able to admit them on a re-fetch
  // (the judge verdict cache keeps repeated rejections cheap).
  assert.ok(!result.importedIds.includes("n2"), "dropped ids re-fetch and re-score later");
  assert.ok(result.importedIds.includes("n1"));
});

test("smart mode: new evidence promotes an earlier pending_review write in place", async () => {
  const borderline = "The launch moved to September twelfth after the vendor call.";
  const { writer, writes } = makeWriter([borderline]);
  let promotedWith: Record<string, string> | undefined;
  writer.findWearableMemoryByContent = async (content) =>
    content.trim() === borderline ? { id: "mem-old", status: "pending_review" } : null;
  writer.promoteWearableMemory = async (_id, attrs) => {
    promotedWith = attrs;
    return true;
  };
  const { tokenizeDayBody } = await import("./trust.js");
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }),
    REGISTRY,
    {
      // 0.75*0.8 = 0.6 (review band) + 0.15 cross-source = 0.75 -> active.
      extract: extractionReturning([
        { category: "fact", content: borderline, confidence: 0.75, tags: [] },
      ]),
      writer,
      corroboration: {
        otherSourceDayTokens: new Map([
          ["bee", tokenizeDayBody("They said the launch moves to September twelfth right after that vendor call wrapped.")],
        ]),
        existingMemories: [],
      },
    },
  );
  assert.equal(result.promoted, 1, "existing borderline write promoted");
  assert.equal(result.created, 0);
  assert.equal(writes.length, 0, "no duplicate write");
  assert.ok(promotedWith);
  assert.equal(promotedWith.trustDecision, "promoted-by-corroboration");
  assert.equal(promotedWith.corroboratedBySources, "bee");
});

test("smart mode: duplicates without stronger evidence stay skipped, not promoted", async () => {
  const borderline = "The launch moved to September twelfth after the vendor call.";
  const { writer, writes } = makeWriter([borderline]);
  let promoteCalls = 0;
  writer.findWearableMemoryByContent = async () => ({ id: "mem-old", status: "pending_review" });
  writer.promoteWearableMemory = async () => {
    promoteCalls += 1;
    return true;
  };
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }),
    REGISTRY,
    {
      // 0.75*0.8 = 0.6 — still review band without corroboration.
      extract: extractionReturning([
        { category: "fact", content: borderline, confidence: 0.75, tags: [] },
      ]),
      writer,
    },
  );
  assert.equal(result.promoted, 0);
  assert.equal(promoteCalls, 0, "no promotion without crossing the auto threshold");
  assert.equal(result.skippedByReason["duplicate-existing"], 1);
  assert.equal(writes.length, 0);
});

test("smart mode: a fresh judge-reject retires an earlier pending_review write", async () => {
  const stale = "The launch moved to September twelfth after the vendor call.";
  const { writer, writes } = makeWriter([stale]);
  let demotedWith: Record<string, string> | undefined;
  writer.findWearableMemoryByContent = async (content) =>
    content.trim() === stale ? { id: "mem-old", status: "pending_review" } : null;
  writer.promoteWearableMemory = async () => {
    throw new Error("reject verdicts must never promote");
  };
  writer.demoteWearableMemory = async (_id, attrs) => {
    demotedWith = attrs;
    return true;
  };
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }),
    REGISTRY,
    {
      extract: extractionReturning([
        { category: "fact", content: stale, confidence: 0.9, tags: [] },
      ]),
      writer,
      judgeFacts: judgeReturning(["reject"]),
    },
  );
  assert.equal(result.demoted, 1, "judge-reject retires the pending row");
  assert.equal(result.promoted, 0);
  assert.equal(writes.length, 0);
  assert.equal(
    result.skippedByReason["duplicate-existing"],
    undefined,
    "demotion is an action, not a skip",
  );
  assert.ok(demotedWith);
  assert.equal(demotedWith.trustDecision, "demoted-by-rejection");
  assert.equal(demotedWith.judgeVerdict, "reject");
});

test("smart mode: judge-reject never touches an active row", async () => {
  const approved = "The launch moved to September twelfth after the vendor call.";
  const { writer, writes } = makeWriter([approved]);
  let demoteCalls = 0;
  writer.findWearableMemoryByContent = async () => ({ id: "mem-old", status: "active" });
  writer.promoteWearableMemory = async () => true;
  writer.demoteWearableMemory = async () => {
    demoteCalls += 1;
    return true;
  };
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    settings({ memoryMode: "smart" }),
    REGISTRY,
    {
      extract: extractionReturning([
        { category: "fact", content: approved, confidence: 0.9, tags: [] },
      ]),
      writer,
      judgeFacts: judgeReturning(["reject"]),
    },
  );
  assert.equal(result.demoted, 0);
  assert.equal(demoteCalls, 0, "operator-approved rows are not overturned by a re-verdict");
  assert.equal(result.skippedByReason["duplicate-existing"], 1);
  assert.equal(writes.length, 0);
});

test("smart mode: below-trust re-score without a reject verdict does not demote", async () => {
  const borderline = "The launch moved to September twelfth after the vendor call.";
  const { writer, writes } = makeWriter([borderline]);
  let demoteCalls = 0;
  writer.findWearableMemoryByContent = async () => ({ id: "mem-old", status: "pending_review" });
  writer.promoteWearableMemory = async () => true;
  writer.demoteWearableMemory = async () => {
    demoteCalls += 1;
    return true;
  };
  const result = await generateWearableMemories(
    "limitless",
    "2026-06-10",
    [LONG_CONVERSATION],
    // 0.62 * 0.5 = 0.31 < reviewTrust 0.45 -> drop band, verdict undefined.
    settings({ memoryMode: "smart", sourceTrust: 0.5 }),
    REGISTRY,
    {
      extract: extractionReturning([
        { category: "fact", content: borderline, confidence: 0.62, tags: [] },
      ]),
      writer,
    },
  );
  assert.equal(result.demoted, 0);
  assert.equal(
    demoteCalls,
    0,
    "a score-based drop is weaker evidence than an explicit reject — leave the row",
  );
  assert.equal(result.skippedByReason["duplicate-existing"], 1);
  assert.equal(writes.length, 0);
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
    settings({ importNativeMemories: "review" }),
    { extract: extractionReturning([]), writer },
  );
  // n1 imports; n2 dedups against existing storage; n3 dedups against
  // n1 within the run; n4 is empty; n5 was imported on a prior sync.
  assert.equal(result.imported, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.status, "pending_review");
  assert.equal(writes[0].options.source, "wearable:bee:native");
  assert.deepEqual(result.importedIds.sort(), ["n1", "n2", "n3"]);
});
