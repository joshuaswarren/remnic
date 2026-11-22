import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { pickFactEventTimeAnchor, resolveFactEventTime } from "./event-time.js";
import { ExtractionEngine } from "./extraction.js";
import { ExtractedFactSchema } from "./schemas.js";
import { StorageManager } from "./storage.js";



test("resolveFactEventTime: replay of a 2025 transcript anchors 'last March' to 2025-03, not today", () => {
  const anchor2025 = "2025-04-10T12:00:00.000Z";
  const result = resolveFactEventTime("last March", anchor2025);
  assert.equal(result.eventTimeSource, "extracted");
  assert.ok(result.validFrom, "validFrom must be set for a resolvable expression");
  assert.ok(result.validFrom!.startsWith("2025-03"), `expected 2025-03, got ${result.validFrom}`);
  assert.ok(!result.validFrom!.startsWith("2026"), "must not anchor to wall-clock");
  assert.equal(result.observedAt, anchor2025);
});

test("resolveFactEventTime: same expression, different anchors → different validFrom", () => {
  const old = resolveFactEventTime("yesterday", "2025-01-15T10:00:00.000Z");
  const recent = resolveFactEventTime("yesterday", "2026-07-05T10:00:00.000Z");
  assert.ok(old.validFrom!.startsWith("2025-01-14"), `got ${old.validFrom}`);
  assert.ok(recent.validFrom!.startsWith("2026-07-04"), `got ${recent.validFrom}`);
  assert.notEqual(old.validFrom, recent.validFrom);
});

test("resolveFactEventTime: absent expression → 'assumed' with validFrom = anchor", () => {
  const anchor = "2025-06-01T00:00:00.000Z";
  const result = resolveFactEventTime(undefined, anchor);
  assert.equal(result.eventTimeSource, "assumed");
  assert.equal(result.validFrom, anchor);
  assert.equal(result.observedAt, anchor);
  assert.equal(result.validUntil, undefined);
});

test("resolveFactEventTime: 'since 2024' → validFrom only (open-ended start)", () => {
  const result = resolveFactEventTime("since 2024", "2025-06-01T00:00:00.000Z");
  assert.equal(result.eventTimeSource, "extracted");
  assert.ok(result.validFrom!.startsWith("2024-01-01"));
  assert.equal(result.validUntil, undefined);
});

test("resolveFactEventTime: unresolvable garbage → 'assumed' fallback", () => {
  const anchor = "2025-06-01T00:00:00.000Z";
  const result = resolveFactEventTime("sometime maybe???", anchor);
  assert.equal(result.eventTimeSource, "assumed");
  assert.equal(result.validFrom, anchor);
});


function makeEngine(): ExtractionEngine {
  return new ExtractionEngine(
    { memoryDir: "/tmp" } as any,
    undefined, // profiler → safe default
    {} as any, // localLlm stub
    undefined, // gatewayConfig
    {} as any, // modelRegistry stub
  );
}

test("extraction normalization: camelCase 'eventTime' passes through to ExtractedFact", () => {
  const engine = makeEngine();
  const result = (engine as any).normalizeExtractionResultPayload({
    facts: [
      { content: "We moved offices in March.", category: "fact", eventTime: "last March" },
    ],
    entities: [],
  });
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].eventTime, "last March");
});

test("extraction normalization: snake_case 'event_time' also captured", () => {
  const engine = makeEngine();
  const result = (engine as any).normalizeExtractionResultPayload({
    facts: [
      { content: "Switched to PostgreSQL.", category: "fact", event_time: "2025-01-15" },
    ],
    entities: [],
  });
  assert.equal(result.facts[0].eventTime, "2025-01-15");
});

test("extraction normalization: absent eventTime → undefined (assumed deferred to write time)", () => {
  const engine = makeEngine();
  const result = (engine as any).normalizeExtractionResultPayload({
    facts: [{ content: "The sky is blue.", category: "fact" }],
    entities: [],
  });
  assert.equal(result.facts[0].eventTime, undefined);
});


test("ExtractedFactSchema: snake_case event_time survives schema parse (gateway strip-unknown fix)", () => {
  const parsed = ExtractedFactSchema.parse({
    content: "Switched to PostgreSQL.",
    category: "fact",
    confidence: 0.9,
    tags: [],
    event_time: "2025-01-15",
  });
  assert.equal(parsed.event_time, "2025-01-15");
});

test("ExtractedFactSchema: camelCase eventTime also survives schema parse (no regression)", () => {
  const parsed = ExtractedFactSchema.parse({
    content: "We moved offices in March.",
    category: "fact",
    confidence: 0.8,
    tags: [],
    eventTime: "2025-03",
  });
  assert.equal(parsed.eventTime, "2025-03");
});


test("storage: invalid_at round-trips through writeMemoryFrontmatter → readAllMemories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-et-invalidAt-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "Old stack was Node 18.", {
      validAt: "2025-01-01T00:00:00.000Z",
      observedAt: "2025-06-01T00:00:00.000Z",
      eventTimeSource: "extracted",
    });

    const before = await storage.readAllMemories();
    const mem = before.find((m) => m.frontmatter.id === id);
    assert.ok(mem);

    const ok = await storage.writeMemoryFrontmatter(mem!, {
      invalid_at: "2025-06-15T00:00:00.000Z",
    });
    assert.equal(ok, true);

    const after = await storage.readAllMemories();
    const patched = after.find((m) => m.frontmatter.id === id);
    assert.ok(patched, "patched fact must be readable");
    assert.equal(patched!.frontmatter.invalid_at, "2025-06-15T00:00:00.000Z");
    assert.equal(patched!.frontmatter.observedAt, "2025-06-01T00:00:00.000Z");
    assert.equal(patched!.frontmatter.eventTimeSource, "extracted");
    assert.equal(patched!.frontmatter.valid_at, "2025-01-01T00:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage: writeMemory accepts invalidAt directly (end-bound at extraction write time)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-et-writeMem-invalid-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id: id } = await storage.writeMemory("fact", "We used MongoDB until June 2025.", {
      validAt: "2024-01-01T00:00:00.000Z",
      invalidAt: "2025-06-01T00:00:00.000Z",
      observedAt: "2025-06-20T00:00:00.000Z",
      eventTimeSource: "extracted",
    });
    const mems = await storage.readAllMemories();
    const mem = mems.find((m) => m.frontmatter.id === id);
    assert.ok(mem);
    assert.equal(mem!.frontmatter.valid_at, "2024-01-01T00:00:00.000Z");
    assert.equal(mem!.frontmatter.invalid_at, "2025-06-01T00:00:00.000Z");
    assert.equal(mem!.frontmatter.observedAt, "2025-06-20T00:00:00.000Z");
    assert.equal(mem!.frontmatter.eventTimeSource, "extracted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveFactEventTime: 'through 2026' → validUntil only (open-ended end bound)", () => {
  const result = resolveFactEventTime("through 2026", "2025-06-20T00:00:00.000Z");
  assert.equal(result.eventTimeSource, "extracted");
  assert.equal(result.validFrom, undefined);
  assert.ok(result.validUntil, "validUntil must be set for an end-bound expression");
  assert.equal(result.validUntil, "2027-01-01T00:00:00.000Z");
});
test("storage: writeChunk propagates invalidAt/observedAt/eventTimeSource from the parent fact (#1578 PR2)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-et-chunk-invalid-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id: parentId } = await storage.writeMemory("fact", "We used MongoDB until June 2025.", {
      validAt: "2024-01-01T00:00:00.000Z",
      invalidAt: "2025-06-01T00:00:00.000Z",
      observedAt: "2025-06-20T00:00:00.000Z",
      eventTimeSource: "extracted",
    });
    const chunkId = await storage.writeChunk(
      parentId,
      0,
      1,
      "fact",
      "We used MongoDB until June 2025.",
      {
        validAt: "2024-01-01T00:00:00.000Z",
        invalidAt: "2025-06-01T00:00:00.000Z",
        observedAt: "2025-06-20T00:00:00.000Z",
        eventTimeSource: "extracted",
      },
    );
    const mems = await storage.readAllMemories();
    const chunk = mems.find((m) => m.frontmatter.id === chunkId);
    assert.ok(chunk, "chunk must be readable");
    assert.equal(chunk!.frontmatter.valid_at, "2024-01-01T00:00:00.000Z");
    assert.equal(chunk!.frontmatter.invalid_at, "2025-06-01T00:00:00.000Z",
      "chunk must carry the parent's end bound so it expires independently");
    assert.equal(chunk!.frontmatter.observedAt, "2025-06-20T00:00:00.000Z");
    assert.equal(chunk!.frontmatter.eventTimeSource, "extracted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("resolveFactEventTime: 'until 2025-06' (YYYY-MM) → invalidAt = start of following month (#1578 r3)", () => {
  const result = resolveFactEventTime("until 2025-06", "2025-06-20T00:00:00.000Z");
  assert.equal(result.eventTimeSource, "extracted");
  assert.equal(result.validFrom, undefined);
  assert.equal(result.validUntil, "2025-07-01T00:00:00.000Z",
    "YYYY-MM end bound must span the whole month, not fall back to assumed");
});

test("resolveFactEventTime: bare '2025-03' (YYYY-MM) → validFrom = first of month (#1578 r3)", () => {
  const result = resolveFactEventTime("2025-03", "2025-06-20T00:00:00.000Z");
  assert.equal(result.eventTimeSource, "extracted");
  assert.equal(result.validFrom, "2025-03-01T00:00:00.000Z");
  assert.equal(result.validUntil, undefined);
});


test("pickFactEventTimeAnchor: explicit sourceTurnTimestamp wins over batch anchor", () => {
  const anchor = pickFactEventTimeAnchor(
    { sourceTurnTimestamp: "2025-04-10T12:00:00.000Z" },
    "2025-04-12T12:00:00.000Z",
  );
  assert.equal(anchor, "2025-04-10T12:00:00.000Z");
});

test("pickFactEventTimeAnchor: earliest provenance span observedAt used when no sourceTurnTimestamp", () => {
  const anchor = pickFactEventTimeAnchor(
    {
      sources: [
        { observedAt: "2025-04-11T08:00:00.000Z" },
        { observedAt: "2025-04-10T08:00:00.000Z" },
        { observedAt: "2025-04-12T08:00:00.000Z" },
      ],
    },
    "2025-04-12T08:00:00.000Z",
  );
  assert.equal(anchor, "2025-04-10T08:00:00.000Z");
});

test("pickFactEventTimeAnchor: sourceTurnTimestamp takes precedence over provenance spans", () => {
  const anchor = pickFactEventTimeAnchor(
    {
      sourceTurnTimestamp: "2025-04-09T00:00:00.000Z",
      sources: [{ observedAt: "2025-04-11T00:00:00.000Z" }],
    },
    "2025-04-12T00:00:00.000Z",
  );
  assert.equal(anchor, "2025-04-09T00:00:00.000Z");
});

test("pickFactEventTimeAnchor: falls back to batch anchor when no per-fact signal", () => {
  const anchor = pickFactEventTimeAnchor({}, "2025-04-12T12:00:00.000Z");
  assert.equal(anchor, "2025-04-12T12:00:00.000Z");
});

test("pickFactEventTimeAnchor: returns undefined when no signal and no batch anchor", () => {
  const anchor = pickFactEventTimeAnchor({}, undefined);
  assert.equal(anchor, undefined);
});

test("pickFactEventTimeAnchor: ignores corrupt sourceTurnTimestamp, falls through to provenance", () => {
  const anchor = pickFactEventTimeAnchor(
    {
      sourceTurnTimestamp: "not-a-timestamp",
      sources: [{ observedAt: "2025-04-10T08:00:00.000Z" }],
    },
    "2025-04-12T08:00:00.000Z",
  );
  assert.equal(anchor, "2025-04-10T08:00:00.000Z");
});

test("pickFactEventTimeAnchor: ignores corrupt provenance observedAt entries, falls through to batch", () => {
  const anchor = pickFactEventTimeAnchor(
    { sources: [{ observedAt: "garbage" }, { observedAt: "also-bad" }] },
    "2025-04-12T08:00:00.000Z",
  );
  assert.equal(anchor, "2025-04-12T08:00:00.000Z");
});

test("#1670 integration: 'yesterday' on an early-turn fact resolves against the early turn, not the batch", () => {
  const earlyAnchor = pickFactEventTimeAnchor(
    { sources: [{ observedAt: "2025-01-15T10:00:00.000Z" }] },
    "2025-01-17T10:00:00.000Z", // batch latest = 3 days later
  );
  assert.ok(earlyAnchor, "anchor must resolve from provenance");
  const result = resolveFactEventTime("yesterday", earlyAnchor);
  assert.ok(result.validFrom!.startsWith("2025-01-14"),
    `yesterday relative to early turn should be 2025-01-14, got ${result.validFrom}`);
});

test("#1670 integration: same expression, batch vs source-turn anchor → different validFrom", () => {
  const batchAnchor = pickFactEventTimeAnchor({}, "2025-01-17T10:00:00.000Z");
  assert.ok(batchAnchor);
  const batchResult = resolveFactEventTime("yesterday", batchAnchor);
  const provenanceAnchor = pickFactEventTimeAnchor(
    { sources: [{ observedAt: "2025-01-15T10:00:00.000Z" }] },
    "2025-01-17T10:00:00.000Z",
  );
  assert.ok(provenanceAnchor);
  const provenanceResult = resolveFactEventTime("yesterday", provenanceAnchor);
  assert.notEqual(batchResult.validFrom, provenanceResult.validFrom);
  assert.ok(batchResult.validFrom!.startsWith("2025-01-16"));
  assert.ok(provenanceResult.validFrom!.startsWith("2025-01-14"));
});
