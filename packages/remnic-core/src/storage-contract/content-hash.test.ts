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

import { ContentHashIndex, StorageManager } from "../storage.js";
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

test("content-hash: the shared dedup index covers every active category, but hasFactContentHash stays fact-only (#2016)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    await storage.writeMemory("decision", "we chose option B");
    // writeMemory only registers facts on the write hot path, but the
    // authoritative corpus rebuild (first fact-hash use) indexes EVERY active
    // registered category (PR #2016) so a restart never re-creates an identical
    // decision/preference/commitment. The SHARED content-hash index is therefore
    // category-agnostic — probe it directly.
    const shared = await storage.getAuthoritativeFactHashIndex();
    assert.equal(
      shared.has("we chose option B"),
      true,
      "the shared dedup index must cover all active categories, not only facts",
    );
    // hasFactContentHash, however, is fact-ONLY (PR #2016): a non-fact body must
    // NOT satisfy a fact-hash check, or an unrelated decision/preference/note
    // would suppress a real fact candidate for direct consumers (wearable/native
    // writers, explicit-capture) that trust a hit before their own category or
    // source confirmation.
    assert.equal(
      await storage.hasFactContentHash("we chose option B"),
      false,
      "a decision body must not satisfy the fact-only hasFactContentHash",
    );
  } finally {
    await cleanup();
  }
});

test("content-hash: hasFactContentHash is fact-only — a non-fact body sharing a fact's content never suppresses the fact (#2016)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const body = "the launch window closes on friday";
    // An unrelated non-fact memory shares the normalized body.
    await storage.writeMemory("preference", body);
    const shared = await storage.getAuthoritativeFactHashIndex();
    assert.equal(
      shared.has(body),
      true,
      "the shared dedup index carries the non-fact hash (cross-category dedup preserved)",
    );
    assert.equal(
      await storage.hasFactContentHash(body),
      false,
      "a preference must not satisfy hasFactContentHash — a direct consumer would else skip a real fact",
    );
    // A genuine active fact with the same body DOES satisfy the fact-only check.
    await storage.writeMemory("fact", body);
    assert.equal(
      await storage.hasFactContentHash(body),
      true,
      "an active fact with the body satisfies the fact-only check",
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

test("content-hash: distinct Japanese facts keep distinct hashes", () => {
  assert.notEqual(
    ContentHashIndex.computeHash("利用者は紅茶を好む。"),
    ContentHashIndex.computeHash("利用者は珈琲を好む。"),
  );
});

test("content-hash: NFC and NFD forms share one hash", () => {
  const nfc = "Café au lait";
  const nfd = "Cafe\u0301 au lait";
  assert.equal(ContentHashIndex.computeHash(nfc), ContentHashIndex.computeHash(nfd));
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

test("content-hash: fact-only membership across write, supersede, and rebuild — no stale true (#2474)", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    const supersededBody = "the staging region retires on friday";
    const activeBody = "the production region stays";

    // Write: both facts register fact-only membership on the shared index.
    await storage.writeMemory("fact", supersededBody);
    await storage.writeMemory("fact", activeBody);
    assert.equal(
      await storage.hasFactContentHash(supersededBody),
      true,
      "write registers the fact-only hash",
    );
    assert.equal(await storage.hasFactContentHash(activeBody), true);

    // Supersede: the frontmatter rewrite runs syncFactHashIndexAfterRewrite →
    // removeFactContentHashesForMemories, which must drop BOTH the shared hash
    // and the fact-only partition. A stale partition entry is the PR #2016
    // stale-true bug class: wearable / explicit-capture / promotion callers
    // would skip a valid re-write.
    const mem = (await storage.readAllMemories()).find((m) =>
      (m.content ?? "").includes(supersededBody),
    );
    assert.ok(mem, "the fact to supersede must exist");
    const ok = await storage.writeMemoryFrontmatter(mem!, { status: "superseded" });
    assert.equal(ok, true, "frontmatter rewrite must succeed");
    assert.equal(
      await storage.hasFactContentHash(supersededBody),
      false,
      "no stale hasFactContentHash true after supersede",
    );
    assert.equal(
      await storage.hasFactContentHash(activeBody),
      true,
      "the untouched fact keeps its fact-only membership",
    );

    // Rebuild: a fresh instance repopulates the index from the corpus. The
    // superseded fact must stay out of the fact-only partition; the active
    // fact must survive.
    const reopened = new StorageManager(baseDir);
    await reopened.ensureDirectories();
    assert.equal(
      await reopened.hasFactContentHash(supersededBody),
      false,
      "superseded fact stays out of fact-only membership after rebuild",
    );
    assert.equal(
      await reopened.hasFactContentHash(activeBody),
      true,
      "active fact survives the rebuild",
    );
  } finally {
    await cleanup();
  }
});
