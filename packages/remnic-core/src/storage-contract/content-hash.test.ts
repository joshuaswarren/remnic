/**
 * Issue #1533 — Phase A contract test: content hash identity.
 *
 * Rule 23: the write-side and dedup-side MUST hash the same `rawContent`,
 * never the timestamped/cited form. `writeMemory` persists a `contentHash` on
 * the frontmatter for facts; `hasFactContentHash` queries the dedup index.
 * This test pins that the two sides agree so subsequent extractions of the
 * same logical fact are deduped correctly even when citation timestamps differ.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ContentHashIndex } from "../storage.js";
import { makeStorage } from "./harness.js";

test("content-hash: ContentHashIndex.computeHash is deterministic for the same input", () => {
  const a = ContentHashIndex.computeHash("the sky is blue");
  const b = ContentHashIndex.computeHash("the sky is blue");
  assert.equal(a, b);
  assert.notEqual(
    ContentHashIndex.computeHash("the sky is blue"),
    ContentHashIndex.computeHash("the sky is green"),
  );
});

test("content-hash: writeMemory for fact registers the hash so hasFactContentHash returns true", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const rawFact = "PostgreSQL is our primary database";
    await storage.writeMemory("fact", rawFact);

    const has = await storage.hasFactContentHash(rawFact);
    assert.equal(has, true, "hasFactContentHash must return true for a just-written fact");
  } finally {
    await cleanup();
  }
});

test("content-hash: contentHashSource overrides the persisted body for dedup (rule 23)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const rawFact = "We migrated to MySQL in March";
    // Persist a citation-annotated body, but index the RAW fact text
    await storage.writeMemory("fact", `${rawFact} [cited 2026-01-01]`, {
      contentHashSource: rawFact,
    });

    // Querying with the RAW fact (not the cited form) must hit
    assert.equal(
      await storage.hasFactContentHash(rawFact),
      true,
      "hasFactContentHash must match on the raw fact, not the cited body",
    );
    // The cited form should NOT be separately indexed (it has the citation suffix)
    assert.equal(
      await storage.hasFactContentHash(`${rawFact} [cited 2026-01-01]`),
      false,
      "the cited/timestamped form must not be the indexed hash",
    );
  } finally {
    await cleanup();
  }
});

test("content-hash: the authoritative rebuild dedups every active registered category, not just facts (#2016 round-15)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    await storage.writeMemory("decision", "we chose option B");
    // writeMemory only registers facts on the write hot path, but the
    // authoritative corpus rebuild (first hasFactContentHash use) indexes EVERY
    // active registered category (b866c735 / PR #2016) so a restart never
    // re-creates an identical decision/preference/commitment. The shared
    // content-hash index is therefore category-agnostic; over-inclusion is safe
    // because dedup consumers confirm the category with a corpus scan before
    // dropping a write.
    assert.equal(
      await storage.hasFactContentHash("we chose option B"),
      true,
      "the rebuilt shared content-hash index covers all active categories, not only facts",
    );
  } finally {
    await cleanup();
  }
});

test("content-hash: normalizeContent produces stable text for equivalent inputs", () => {
  const a = ContentHashIndex.normalizeContent("  Hello   World  ");
  const b = ContentHashIndex.normalizeContent("Hello World");
  assert.equal(a, b, "normalizeContent must collapse whitespace consistently");
});

test("content-hash: the frontmatter contentHash matches computeHash of the raw content", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const rawFact = "deterministic hash check";
    const { id: id } = await storage.writeMemory("fact", rawFact);
    const memory = await storage.getMemoryById(id);
    assert.ok(memory);
    assert.ok(memory!.frontmatter.contentHash, "frontmatter must carry a contentHash for facts");
    assert.equal(
      memory!.frontmatter.contentHash,
      ContentHashIndex.computeHash(rawFact),
      "frontmatter contentHash must equal computeHash of the raw content",
    );
  } finally {
    await cleanup();
  }
});
