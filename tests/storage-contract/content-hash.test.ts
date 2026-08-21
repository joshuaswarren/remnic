/**
 * #1533 Phase A — rule 23 pin: write-side and dedup-side hash the SAME raw
 * content. `StorageManager.writeMemory` for `category: "fact"` records a
 * `contentHash` on the frontmatter and inserts it into the fact-hash index.
 * Both MUST be `ContentHashIndex.computeHash` over the sanitized raw body —
 * never over the citation-annotated persisted form. This test pins that
 * invariant; a regression here is the silent-dedup-failure class.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeFactContentHash, withScratchStorage } from "./helpers.js";

test("content-hash (rule 23): fact write records ContentHashIndex.computeHash(rawBody) on frontmatter", async () => {
  await withScratchStorage("hash-raw-body", async (storage) => {
    const rawBody = "The user's timezone is Australia/Sydney";
    const { id: id } = await storage.writeMemory("fact", rawBody, { confidence: 0.9 });

    const mem = await storage.getMemoryById(id);
    assert.ok(mem, "fact not found after write");
    assert.equal(
      mem!.frontmatter.contentHash,
      computeFactContentHash(rawBody),
      "frontmatter.contentHash must equal ContentHashIndex.computeHash(rawBody) — rule 23",
    );
  });
});

test("content-hash (rule 23): dedup index lookup hits on the raw body (same hash, not the cited form)", async () => {
  await withScratchStorage("hash-dedup-lookup", async (storage) => {
    const rawBody = "Project migration to MySQL completed in March 2026";
    await storage.writeMemory("fact", rawBody, { confidence: 0.9 });

    // The dedup-side lookup MUST hash the same raw string. A bug that hashes
    // the citation-annotated persisted form would miss this and re-extract.
    const hit = await storage.hasFactContentHash(rawBody);
    assert.equal(hit, true, "hasFactContentHash must hit on the raw body — rule 23");
  });
});

test("content-hash (rule 23): contentHashSource override indexes the raw fact, not the persisted body", async () => {
  await withScratchStorage("hash-source-override", async (storage) => {
    // Persisted body is a citation-annotated variant; the canonical raw fact
    // is supplied via contentHashSource. Both the frontmatter hash and the
    // dedup index MUST reflect the RAW fact so future extractions of the raw
    // form dedup correctly even when their citation timestamp differs.
    const rawFact = "The cache TTL is 5 minutes";
    const citedBody = `${rawFact} [cited: 2026-04-01T00:00:00Z]`;
    await storage.writeMemory("fact", citedBody, {
      confidence: 0.9,
      contentHashSource: rawFact,
    });

    // Dedup on the RAW fact (never the cited body).
    const rawHit = await storage.hasFactContentHash(rawFact);
    assert.equal(rawHit, true, "rawFact must hit in the dedup index");
    // The cited body — different string — must NOT independently hit (it's
    // never the keyed form). This is the regression: hashing the cited form
    // would make BOTH hit and hide the bug.
    const citedHit = await storage.hasFactContentHash(citedBody);
    assert.equal(citedHit, false, "cited body must NOT hit — only the raw form is keyed");
  });
});

test("content-hash (rule 23): non-fact categories do not record a contentHash (scope of the index)", async () => {
  await withScratchStorage("hash-non-fact-scope", async (storage) => {
    const { id: id } = await storage.writeMemory("preference", "prefers dark mode", {
      confidence: 0.9,
    });
    const mem = await storage.getMemoryById(id);
    assert.ok(mem);
    // The fact-hash index is scoped to category === "fact" (see writeMemory).
    // Other categories must not pollute it with a contentHash field — that
    // would make removeFactContentHashesForMemories churn on non-fact writes.
    assert.equal(
      mem!.frontmatter.contentHash,
      undefined,
      "non-fact categories must not set contentHash",
    );
  });
});

test("content-hash (rule 23): computeHash is deterministic and normalize-stable (lowercase, alnum-collapsed)", () => {
  // Pin the normalization contract so dedup survives cosmetic differences in
  // extraction (case, punctuation, whitespace) — the dedup class relies on it.
  const base = computeFactContentHash("The User's Timezone is Australia/Sydney");
  const lower = computeFactContentHash("the user's timezone is australia/sydney");
  const collapsed = computeFactContentHash("the  user's  timezone  is  australia sydney");
  assert.equal(base, lower, "computeHash must be case-insensitive");
  assert.equal(base, collapsed, "computeHash must collapse whitespace + punctuation identically");
});
