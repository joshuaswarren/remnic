import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { pickFactEventTimeAnchor, resolveFactEventTime } from "./event-time.js";
import { ExtractionEngine } from "./extraction.js";
import { ExtractedFactSchema } from "./schemas.js";
import { StorageManager } from "./storage.js";

/**
 * Issue #1578 PR 2 — extraction event-time wiring.
 *
 * Proves three contracts:
 *  1. resolveFactEventTime anchors to the SOURCE TURN timestamp, never
 *     wall-clock — replay/import of an old transcript yields old-era event
 *     times (the core bi-temporal invariant from the #1578 design).
 *  2. Extraction normalization passes the per-fact `eventTime` expression
 *     through from raw LLM JSON (camelCase and snake_case payloads) so the
 *     persist path can resolve it at write time.
 *  3. Storage round-trips `invalid_at` so the bi-temporal interval survives
 *     write → read (complementing PR 1's observedAt/eventTimeSource test).
 */

// ── 1. Replay anchoring ──────────────────────────────────────────────────

test("resolveFactEventTime: replay of a 2025 transcript anchors 'last March' to 2025-03, not today", () => {
  // The anchor is the source turn timestamp from an old (2025) transcript.
  const anchor2025 = "2025-04-10T12:00:00.000Z";
  const result = resolveFactEventTime("last March", anchor2025);
  assert.equal(result.eventTimeSource, "extracted");
  assert.ok(result.validFrom, "validFrom must be set for a resolvable expression");
  // "last March" relative to April 2025 → March 2025.
  assert.ok(result.validFrom!.startsWith("2025-03"), `expected 2025-03, got ${result.validFrom}`);
  // Critical bi-temporal invariant: NOT anchored to today's wall-clock.
  assert.ok(!result.validFrom!.startsWith("2026"), "must not anchor to wall-clock");
  assert.equal(result.observedAt, anchor2025);
});

test("resolveFactEventTime: same expression, different anchors → different validFrom", () => {
  // The identical phrase resolves differently depending on the anchor —
  // proving the resolver is anchor-driven, not Date.now()-driven.
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

// ── 2. Extraction normalization passes eventTime through ─────────────────

function makeEngine(): ExtractionEngine {
  // Minimal construction: the facts normalizer is a pure data transform
  // (no LLM / I/O). Stub the optional deps so the constructor doesn't
  // spin up real clients.
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

// ── 2b. Schema preserves snake_case event_time (gateway fix, chatgpt-codex) ─

test("ExtractedFactSchema: snake_case event_time survives schema parse (gateway strip-unknown fix)", () => {
  // Zod .object() strips unknown keys by default. Before the event_time alias
  // was added, the gateway fallback path (parseWithSchemaDetailed → schema.parse)
  // silently dropped event_time, losing the temporal bound (#1578).
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

// ── 3. Storage round-trips invalid_at ────────────────────────────────────

test("storage: invalid_at round-trips through writeMemoryFrontmatter → readAllMemories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-et-invalidAt-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = await storage.writeMemory("fact", "Old stack was Node 18.", {
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
    // Bi-temporal provenance preserved through the frontmatter patch.
    assert.equal(patched!.frontmatter.observedAt, "2025-06-01T00:00:00.000Z");
    assert.equal(patched!.frontmatter.eventTimeSource, "extracted");
    assert.equal(patched!.frontmatter.valid_at, "2025-01-01T00:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage: writeMemory accepts invalidAt directly (end-bound at extraction write time)", async () => {
  // Proves Fix C: writeMemory now accepts invalidAt so "until X" expressions
  // persist invalid_at at write time without a separate updateMemoryFrontmatter call.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-et-writeMem-invalid-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await storage.writeMemory("fact", "We used MongoDB until June 2025.", {
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
  // "through 2026" → exclusive end = start of 2027.
  assert.equal(result.validUntil, "2027-01-01T00:00:00.000Z");
});
test("storage: writeChunk propagates invalidAt/observedAt/eventTimeSource from the parent fact (#1578 PR2)", async () => {
  // Proves the cursor-bugbot fix: an independently-surfaced chunk expires at the
  // same invalid_at window as its parent so recall's isValidityExpiredNow check
  // fires on chunks too, not just the chunked parent write.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-et-chunk-invalid-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const parentId = await storage.writeMemory("fact", "We used MongoDB until June 2025.", {
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

// ── #1670: per-fact source-turn anchor selection ─────────────────────────

test("pickFactEventTimeAnchor: explicit sourceTurnTimestamp wins over batch anchor", () => {
  // A buffered batch's latest turn is 2025-04-12, but the fact was extracted
  // from an earlier turn on 2025-04-10. The per-fact timestamp must win.
  const anchor = pickFactEventTimeAnchor(
    { sourceTurnTimestamp: "2025-04-10T12:00:00.000Z" },
    "2025-04-12T12:00:00.000Z",
  );
  assert.equal(anchor, "2025-04-10T12:00:00.000Z");
});

test("pickFactEventTimeAnchor: earliest provenance span observedAt used when no sourceTurnTimestamp", () => {
  // A fact backed by spans from two turns: the EARLIEST span's observedAt is
  // the turn where the claim was first uttered — the correct anchor for a
  // relative expression like "yesterday".
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
  // Simulates the exact scenario from the issue: a buffered conversation
  // spanning a date boundary. The fact carries provenance from the early turn.
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
  // Without per-fact provenance, "yesterday" resolves against the batch
  // (latest turn = 2025-01-17 → 2025-01-16). With provenance from the early
  // turn (2025-01-15), it resolves to 2025-01-14. The two must differ.
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
