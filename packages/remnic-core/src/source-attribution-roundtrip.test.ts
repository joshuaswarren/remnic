import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { StorageManager } from "./storage.js";
import {
  attachCitation,
  hasCitation,
  parseCitation,
  stripCitation,
  stripCitationForTemplate,
  DEFAULT_CITATION_FORMAT,
} from "./source-attribution.js";

/**
 * Issue #369 — Inline source attribution round-trip.
 *
 * These tests verify that once a citation marker is embedded in the fact
 * body, it survives writing to disk and reading back via StorageManager —
 * which is the same path recall takes when it injects memories into a
 * prompt. The orchestrator-level `persistExtraction` is covered indirectly
 * through this round-trip: all three write sites (`writeMemory`,
 * `writeChunk`, `writeArtifact`) go through the same on-disk markdown file
 * and frontmatter parser.
 */

test("round-trip: citation-enriched fact content survives writeMemory → readAllMemories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-source-attr-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const factBody = "The foo service uses Redis for rate limiting.";
    const enriched = attachCitation(factBody, {
      agent: "planner",
      session: "agent:planner:main",
      ts: "2026-04-10T14:25:07Z",
    });

    assert.ok(hasCitation(enriched), "attachCitation must emit a marker");

    const { id: id } = await storage.writeMemory("fact", enriched, {
      confidence: 0.8,
      tags: ["test"],
    });
    assert.ok(id.length > 0);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written, "writeMemory output must be readable");
    assert.ok(
      hasCitation(written!.content),
      "citation marker must survive the on-disk round-trip",
    );

    const parsed = parseCitation(written!.content);
    assert.ok(parsed);
    assert.equal(parsed!.agent, "planner");
    assert.equal(parsed!.session, "main");
    assert.equal(parsed!.ts, "2026-04-10T14:25:07Z");

    // stripCitation must recover the original fact body verbatim so
    // downstream consumers that want raw text have a clean escape hatch.
    assert.equal(stripCitation(written!.content), factBody);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy fact memories without a citation marker still read cleanly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-source-attr-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const legacyBody = "Legacy fact without inline provenance.";
    const { id: id } = await storage.writeMemory("fact", legacyBody, {
      confidence: 0.8,
      tags: ["legacy"],
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(hasCitation(written!.content), false);
    // Plain content is unchanged by strip, so recall sees the exact body.
    assert.equal(stripCitation(written!.content), legacyBody);
    assert.equal(parseCitation(written!.content), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix #1 regression: Codex P2 — Canonicalize pre-tagged facts before hashing
// ---------------------------------------------------------------------------

test("stripCitationForTemplate: default template — strips citation and returns canonical body", () => {
  const body = "The auth service rotates tokens every 24 hours.";
  const cited = attachCitation(body, { agent: "planner", session: "agent:planner:main", ts: "2026-04-10T00:00:00Z" });
  assert.ok(hasCitation(cited), "setup: citation must be present");
  const result = stripCitationForTemplate(cited, DEFAULT_CITATION_FORMAT);
  assert.equal(result, body, "should recover canonical body");
});

test("stripCitationForTemplate: uncited text returned unchanged", () => {
  const body = "No citation here.";
  const result = stripCitationForTemplate(body, DEFAULT_CITATION_FORMAT);
  assert.equal(result, body);
});

test("stripCitationForTemplate: custom template — strips custom citation", () => {
  const body = "Cache TTL is 30 seconds.";
  const template = "[src:{agent}@{date}]";
  const cited = `${body} [src:scout@2026-04-11]`;
  const result = stripCitationForTemplate(cited, template);
  assert.equal(result, body);
});

// #2330 round N+8 (P2-C): a body tagged under the DEFAULT format can later
// receive a CUSTOM template marker after a config change. Canonicalization
// must strip BOTH recognized forms in either order — the default fast path
// alone left the custom marker inside the hash input.
test("stripCitationForTemplate: mixed default + custom markers — strips both, in either order", () => {
  const body = "Cache TTL is 30 seconds.";
  const template = "[src:{agent}@{date}]";
  const defaultCited = `[Source: agent=planner, session=main, ts=2026-04-10T00:00:00Z]`;
  const customCited = `[src:scout@2026-04-11]`;
  assert.equal(
    stripCitationForTemplate(`${body} ${defaultCited} ${customCited}`, template),
    body,
    "default marker first: both forms stripped",
  );
  assert.equal(
    stripCitationForTemplate(`${body} ${customCited} ${defaultCited}`, template),
    body,
    "custom marker first: both forms stripped",
  );
});

test("stripCitationForTemplate: all-placeholder template (no literal anchors) — text returned unchanged", () => {
  // A template with no literal prefix, suffix, or separator between
  // placeholders cannot produce a reliable matcher. hasCitationForTemplate
  // returns false for such templates, so stripCitationForTemplate passes the
  // text through unchanged — it cannot detect a citation to strip.
  const body = "Some fact plannermain";
  const template = "{agent}{sessionId}";
  const result = stripCitationForTemplate(body, template);
  assert.equal(result, body, "all-placeholder template: text should be returned unchanged");
});

// ---------------------------------------------------------------------------
// Fix #2 regression: Cursor Medium — legacy hash rebuild on ensureFactHashIndexAuthoritative
// ---------------------------------------------------------------------------

/**
 * Write a legacy-format fact file directly to disk — without a `contentHash`
 * frontmatter field, simulating a memory written before issue #369 introduced
 * that field. This lets tests exercise the rebuild recovery path in
 * `ensureFactHashIndexAuthoritative`.
 */
async function writeLegacyFactFile(
  storage: StorageManager,
  rawContent: string,
): Promise<void> {
  const { writeFile: wf, mkdir: mkd } = await import("node:fs/promises");
  const today = new Date().toISOString().slice(0, 10);
  const id = `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const frontmatter = [
    "---",
    `id: ${id}`,
    "category: fact",
    `created: ${new Date().toISOString()}`,
    `updated: ${new Date().toISOString()}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    'tags: []',
    "---",
  ].join("\n");
  // Deliberately omit contentHash to simulate a pre-#369 legacy fact.
  const factsDir = path.join((storage as any).baseDir, "facts", today);
  await mkd(factsDir, { recursive: true });
  await wf(path.join(factsDir, `${id}.md`), `${frontmatter}\n\n${rawContent}\n`, "utf-8");
}

test("legacy fact rebuild: ensureFactHashIndexAuthoritative indexes legacy facts via content stripping (default citation)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-legacy-rebuild-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Write a legacy fact WITH a default-format citation but WITHOUT a
    // contentHash frontmatter field, simulating a pre-#369 memory.
    const rawBody = "The production database uses connection pooling.";
    const citedBody = attachCitation(rawBody, {
      agent: "planner",
      session: "agent:planner:main",
      ts: "2026-01-01T00:00:00Z",
    });
    await writeLegacyFactFile(storage, citedBody);

    // Trigger rebuild: ensureFactHashIndexAuthoritative runs when the ready
    // marker is absent. There is no ready marker in a freshly created dir.
    const found = await storage.hasFactContentHash(rawBody);
    assert.equal(
      found,
      true,
      "hasFactContentHash should find the legacy fact after rebuild (citation stripped to canonical form)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy fact rebuild: facts without any citation are indexed by raw content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-legacy-rebuild-raw-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const rawBody = "No citation on this legacy fact.";
    await writeLegacyFactFile(storage, rawBody);

    const found = await storage.hasFactContentHash(rawBody);
    assert.equal(
      found,
      true,
      "hasFactContentHash should find a legacy fact without any citation",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
