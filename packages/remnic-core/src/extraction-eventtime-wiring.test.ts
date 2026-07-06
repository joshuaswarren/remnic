import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { resolveFactEventTime } from "./event-time.js";
import { ExtractionEngine } from "./extraction.js";
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
