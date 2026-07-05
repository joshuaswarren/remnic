import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { buildFactProvenance, type ProvenanceTurnInput } from "./provenance.js";
import { StorageManager } from "./storage.js";
import type { ProvenanceConfig } from "./types.js";

/**
 * Issue #1575 PR 2 — extraction-side post-parse validator + end-to-end
 * verified-span chain.
 *
 * Unit tests cover `buildFactProvenance` (the pure validator that locates
 * each fact's LLM-provided `quote` in the buffered turns). Integration tests
 * prove verified spans survive extraction → storage → readAllMemories (the
 * memory_get read path).
 *
 * Fixtures per the issue's PR 2 spec:
 *   - quote located exactly (exact substring → verified + offsets)
 *   - located after whitespace normalization (collapse runs → verified)
 *   - multi-source fact (two turns → two sources)
 *   - unicode (curly quotes, emoji) round-trip
 *   - quote not present in any turn → unverified
 *   - quote longer than cap → truncated with ellipsis marker
 *   - LLM omits quote → none, no crash
 *   - provenance disabled → no sources (byte-identical to pre-feature)
 */

const DEFAULT_CONFIG: ProvenanceConfig = {
  enabled: true,
  maxQuoteChars: 300,
  requireSpans: false,
};

function makeTurn(
  content: string,
  overrides: Partial<ProvenanceTurnInput> = {},
): ProvenanceTurnInput {
  return {
    content,
    sessionKey: "project/acme/2026-05-03T10:00:00Z",
    timestamp: "2026-05-03T10:01:30Z",
    turnId: "turn-42",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildFactProvenance — unit tests
// ---------------------------------------------------------------------------

test("buildFactProvenance: exact quote located → verified with offsets", () => {
  const turns = [makeTurn("We migrated the production database to pgBouncer yesterday.")];
  const result = buildFactProvenance(
    "migrated the production database to pgBouncer",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "verified");
  assert.ok(result.sources, "sources must be present");
  assert.equal(result.sources!.length, 1);
  const src = result.sources![0]!;
  assert.equal(src.sessionKey, "project/acme/2026-05-03T10:00:00Z");
  assert.equal(src.turnId, "turn-42");
  assert.equal(src.observedAt, "2026-05-03T10:01:30Z");
  assert.equal(src.quote, "migrated the production database to pgBouncer");
  assert.ok(typeof src.charStart === "number", "charStart must be located");
  assert.ok(typeof src.charEnd === "number", "charEnd must be located");
  assert.ok(src.charEnd! > src.charStart!, "half-open interval: end > start");
  // Verify the offsets actually point to the quote in the turn text.
  const slice = turns[0]!.content.slice(src.charStart, src.charEnd);
  assert.equal(slice, "migrated the production database to pgBouncer");
});

test("buildFactProvenance: whitespace-normalized match → verified", () => {
  const turns = [makeTurn("We   migrated  the\tproduction database to pgBouncer.")];
  const result = buildFactProvenance(
    "migrated the production database to pgBouncer",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "verified");
  assert.ok(result.sources);
  assert.equal(result.sources!.length, 1);
  // Offsets are best-effort for normalized matches — just verify verified tag.
  assert.equal(result.sources![0]!.quote, "migrated the production database to pgBouncer");
});

test("buildFactProvenance: case-insensitive match → verified", () => {
  const turns = [makeTurn("We Migrated The Production Database to pgBouncer.")];
  const result = buildFactProvenance(
    "migrated the production database to pgBouncer",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "verified");
  assert.ok(result.sources);
  assert.equal(result.sources!.length, 1);
});

test("buildFactProvenance: multi-source — same quote in two turns → two sources", () => {
  const turns = [
    makeTurn("The connection pool caps at 100.", { sessionKey: "s1", timestamp: "2026-05-03T10:00:00Z" }),
    makeTurn("The connection pool caps at 100, I confirmed it.", { sessionKey: "s2", timestamp: "2026-05-10T14:00:00Z" }),
  ];
  const result = buildFactProvenance(
    "The connection pool caps at 100",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "verified");
  assert.ok(result.sources);
  assert.equal(result.sources!.length, 2, "one source per matching turn");
  assert.equal(result.sources![0]!.sessionKey, "s1");
  assert.equal(result.sources![1]!.sessionKey, "s2");
});

test("buildFactProvenance: unicode (curly quotes, emoji) round-trip", () => {
  const turns = [makeTurn("I love the \u201cnew design\u201d \uD83D\uDE0A it looks great!")];
  const result = buildFactProvenance(
    "love the \u201cnew design\u201d \uD83D\uDE0A",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "verified");
  assert.ok(result.sources);
  assert.equal(result.sources![0]!.quote, "love the \u201cnew design\u201d \uD83D\uDE0A");
  // Offsets should be correct even with multi-byte characters (Array.from / code-point aware).
  const src = result.sources![0]!;
  assert.ok(typeof src.charStart === "number");
  assert.ok(typeof src.charEnd === "number");
  // indexOf works on UTF-16 code units, which is what charStart/charEnd are.
  const expectedIdx = turns[0]!.content.indexOf("love the \u201cnew design\u201d \uD83D\uDE0A");
  assert.equal(src.charStart, expectedIdx);
});

test("buildFactProvenance: quote not present in turns → unverified", () => {
  const turns = [makeTurn("The weather is nice today.")];
  const result = buildFactProvenance(
    "the production database runs on PostgreSQL 15",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "unverified");
  assert.ok(result.sources, "unverified still carries the quote as a source");
  assert.equal(result.sources!.length, 1);
  assert.equal(result.sources![0]!.quote, "the production database runs on PostgreSQL 15");
  assert.equal(result.sources![0]!.charStart, undefined, "no offsets when not located");
  assert.equal(result.sources![0]!.charEnd, undefined);
});

test("buildFactProvenance: quote longer than cap → truncated with ellipsis marker", () => {
  const longQuote = "A".repeat(500);
  const turns = [makeTurn(`Context ${longQuote} more text`)];
  const config: ProvenanceConfig = { ...DEFAULT_CONFIG, maxQuoteChars: 50 };
  const result = buildFactProvenance(longQuote, turns, config);
  assert.equal(result.provenance, "verified");
  assert.ok(result.sources);
  const storedQuote = result.sources![0]!.quote;
  assert.ok(storedQuote.length <= 51, "truncated + marker must be within cap + marker");
  assert.ok(storedQuote.endsWith("\u2026"), "must end with ellipsis marker");
});

test("buildFactProvenance: LLM omits quote → none, no crash", () => {
  const turns = [makeTurn("Some conversation content.")];
  const result = buildFactProvenance(undefined, turns, DEFAULT_CONFIG);
  assert.equal(result.provenance, "none");
  assert.equal(result.sources, undefined);
});

test("buildFactProvenance: empty/whitespace quote → none", () => {
  const turns = [makeTurn("Some conversation content.")];
  assert.equal(buildFactProvenance("", turns, DEFAULT_CONFIG).provenance, "none");
  assert.equal(buildFactProvenance("   ", turns, DEFAULT_CONFIG).provenance, "none");
  assert.equal(buildFactProvenance(null, turns, DEFAULT_CONFIG).provenance, "none");
});

test("buildFactProvenance: provenance disabled → no sources (byte-identical to pre-feature)", () => {
  const turns = [makeTurn("We migrated to pgBouncer.")];
  const disabledConfig: ProvenanceConfig = { ...DEFAULT_CONFIG, enabled: false };
  const result = buildFactProvenance("migrated to pgBouncer", turns, disabledConfig);
  assert.equal(result.provenance, "none");
  assert.equal(result.sources, undefined);
});

test("buildFactProvenance: empty turns array → unverified (quote survives)", () => {
  const result = buildFactProvenance("some quote", [], DEFAULT_CONFIG);
  assert.equal(result.provenance, "unverified");
  assert.ok(result.sources);
  assert.equal(result.sources!.length, 1);
  assert.equal(result.sources![0]!.sessionKey, "unknown");
});

test("buildFactProvenance: never throws on malformed input", () => {
  // Should never crash even on unexpected inputs.
  assert.doesNotThrow(() => buildFactProvenance("quote", [], DEFAULT_CONFIG));
  assert.doesNotThrow(() =>
    buildFactProvenance("quote", [{ content: "", timestamp: "", sessionKey: "s" }], DEFAULT_CONFIG),
  );
});

// ---------------------------------------------------------------------------
// End-to-end: extraction → storage → readAllMemories (verified spans survive)
// ---------------------------------------------------------------------------

test("end-to-end: fact with verified sources survives write → readAllMemories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-e2e-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Simulate what the extraction pipeline produces after the validator runs:
    // a fact with verified provenance sources + tag.
    const sources = [
      {
        sessionKey: "project/acme/2026-05-03T10:00:00Z",
        turnId: "turn-42",
        observedAt: "2026-05-03T10:01:30Z",
        quote: "we migrated the production database to pgBouncer",
        charStart: 12,
        charEnd: 60,
      },
    ];

    const memoryId = await storage.writeMemory("fact", "Production DB uses pgBouncer.", {
      confidence: 0.9,
      tags: ["infra"],
      sources,
      provenance: "verified",
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === memoryId);
    assert.ok(written, "fact must be discoverable after write");
    assert.equal(written!.frontmatter.provenance, "verified");
    const readSources = written!.frontmatter.sources;
    assert.ok(readSources, "sources must survive write → read");
    assert.equal(readSources!.length, 1);
    assert.equal(readSources![0]!.quote, "we migrated the production database to pgBouncer");
    assert.equal(readSources![0]!.sessionKey, "project/acme/2026-05-03T10:00:00Z");
    assert.equal(readSources![0]!.turnId, "turn-42");
    assert.equal(readSources![0]!.charStart, 12);
    assert.equal(readSources![0]!.charEnd, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end-to-end: fact without provenance fields is legacy-compatible (undefined)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const memoryId = await storage.writeMemory("fact", "A fact with no provenance.", {
      confidence: 0.9,
      tags: [],
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === memoryId);
    assert.ok(written);
    assert.equal(written!.frontmatter.sources, undefined);
    assert.equal(written!.frontmatter.provenance, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end-to-end: verified tag without sources downgrades to none on read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-invariant-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Write a fact with provenance="verified" but NO sources. The serialize
    // invariant (PR1) must downgrade to "none" so downstream surfaces never
    // see an ungrounded "verified" tag.
    const memoryId = await storage.writeMemory("fact", "A tagged fact with no evidence.", {
      confidence: 0.9,
      tags: [],
      provenance: "verified",
      // sources intentionally omitted
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === memoryId);
    assert.ok(written);
    // The verified-requires-evidence invariant downgrades to "none".
    assert.equal(written!.frontmatter.provenance, "none");
    assert.equal(written!.frontmatter.sources, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: cursor thread Ocveu — non-ISO turn timestamps must not drop sources
// ---------------------------------------------------------------------------

test("buildFactProvenance: non-strict-ISO turn timestamp is normalized (thread Ocveu)", () => {
  // Date-formatted timestamp that Date.parse accepts but isStrictIsoTimestamp
  // rejects — the pre-fix path copied it verbatim, so the write-path schema
  // dropped the source and downgraded the tag to "none".
  const turns = [
    makeTurn("We migrated the production database to pgBouncer.", {
      timestamp: "2026/05/03 10:01:30" as unknown as string,
    }),
  ];
  const result = buildFactProvenance(
    "migrated the production database to pgBouncer",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "verified", "verified source must survive timestamp normalization");
  assert.ok(result.sources, "sources must be present");
  assert.equal(result.sources!.length, 1);
  const observedAt = result.sources![0]!.observedAt;
  // The persisted timestamp must pass the same strict-ISO check the write-path
  // schema enforces — otherwise the source would be dropped at serialization.
  const isoRe = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  assert.match(observedAt, isoRe, "observedAt must be strict ISO-8601 after normalization");
  assert.notEqual(observedAt, "2026/05/03 10:01:30", "raw non-ISO timestamp must not leak through");
});

test("buildFactProvenance: unparseable timestamp falls back to epoch for unverified (thread Ocveu)", () => {
  // A turn whose timestamp neither passes strict ISO nor Date.parse can't back
  // a verifiable source. When the quote is NOT located (unverified path), the
  // fallback source still needs a schema-valid observedAt — epoch is the
  // documented last-resort (matches the empty-turns fallback).
  const turns = [
    makeTurn("Unrelated content with no match.", { timestamp: "not-a-date" }),
  ];
  const result = buildFactProvenance("a quote that is not present", turns, DEFAULT_CONFIG);
  assert.equal(result.provenance, "unverified");
  assert.ok(result.sources);
  const observedAt = result.sources![0]!.observedAt;
  const isoRe = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  assert.match(observedAt, isoRe, "unverified fallback observedAt must still be strict ISO");
});

test("end-to-end: verified source with non-ISO turn timestamp survives write → read (thread Ocveu)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-tsnorm-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Simulate extraction output: a verified source whose observedAt has been
    // normalized to strict ISO by buildFactProvenance (the fix). Pre-fix, the
    // raw "2026/05/03 10:01:30" would have been dropped by the write-path
    // ProvenanceSourceSchema, clearing sources and downgrading to "none".
    const turns = [
      makeTurn("We migrated the production database to pgBouncer.", {
        timestamp: "2026/05/03 10:01:30" as unknown as string,
      }),
    ];
    const built = buildFactProvenance(
      "migrated the production database to pgBouncer",
      turns,
      DEFAULT_CONFIG,
    );
    assert.equal(built.provenance, "verified");

    const memoryId = await storage.writeMemory("fact", "Production DB uses pgBouncer.", {
      confidence: 0.9,
      tags: ["infra"],
      sources: built.sources,
      provenance: built.provenance,
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === memoryId);
    assert.ok(written, "fact must be discoverable");
    assert.equal(written!.frontmatter.provenance, "verified", "tag must not downgrade to none");
    assert.ok(written!.frontmatter.sources, "sources must survive the round-trip");
    assert.equal(written!.frontmatter.sources!.length, 1);
    assert.equal(written!.frontmatter.sources![0]!.quote, "migrated the production database to pgBouncer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: cursor thread Ocver — normalized match must not drop verified source
// ---------------------------------------------------------------------------

test("buildFactProvenance: normalized match (case + whitespace) records a verified source with the quote (thread Ocver)", () => {
  // The quote matches the turn only after whitespace-collapse + casefold.
  // Pre-fix, locateQuoteOffsets could return undefined for the normalized
  // path's unrecoverable-offsets edge case, causing buildFactProvenance to
  // skip the turn and fall through to "unverified" despite the literal
  // substring being present in the buffered conversation.
  const turns = [makeTurn("We   Migrated  The	Production Database to pgBouncer.")];
  const result = buildFactProvenance(
    "migrated the production database to pgBouncer",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "verified", "normalized match must verify, never drop to unverified");
  assert.ok(result.sources, "a verified source must be recorded for the matching turn");
  assert.equal(result.sources!.length, 1);
  // The excerpt survives regardless of whether offsets were recovered.
  assert.equal(
    result.sources![0]!.quote,
    "migrated the production database to pgBouncer",
    "quote excerpt must survive even when offsets are best-effort",
  );
});

// ---------------------------------------------------------------------------
// Regression: cursor thread Oc3Z2 — quote carrying the prompt role prefix must still verify
// ---------------------------------------------------------------------------

test("buildFactProvenance: quote with a leading [role] prefix verifies against turn content (thread Oc3Z2)", () => {
  // The extraction prompt renders each turn as `[role] content`, so a faithful
  // LLM may include the label in its verbatim quote. buildFactProvenance
  // searches raw turn.content (no prefix) — pre-fix the quote never matched
  // and the fact stayed unverified despite valid evidence in the buffer.
  const turns = [makeTurn("We migrated the production database to pgBouncer yesterday.")];
  const result = buildFactProvenance(
    "[user] We migrated the production database to pgBouncer",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "verified", "role-prefixed quote must verify against the raw turn");
  assert.ok(result.sources, "a verified source must be recorded");
  assert.equal(result.sources!.length, 1);
  // The stored excerpt is the de-prefixed utterance, not the prompt formatting.
  assert.equal(
    result.sources![0]!.quote,
    "We migrated the production database to pgBouncer",
    "stored quote must be the utterance, not the [role]-prefixed prompt line",
  );
});

test("buildFactProvenance: quote with a [context role] prefix verifies (thread Oc3Z2)", () => {
  const turns = [makeTurn("The API rate limit is 100 requests per minute.")];
  const result = buildFactProvenance(
    "[context assistant] The API rate limit is 100 requests per minute",
    turns,
    DEFAULT_CONFIG,
  );
  assert.equal(result.provenance, "verified");
  assert.ok(result.sources);
  assert.equal(
    result.sources![0]!.quote,
    "The API rate limit is 100 requests per minute",
  );
});
