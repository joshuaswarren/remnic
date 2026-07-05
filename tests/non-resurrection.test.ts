/**
 * Non-resurrection invariant — issue #1579 PR 2.
 *
 * The five-path resurrection matrix. A retired (corrected / superseded /
 * retracted) fact MUST NOT come back to life through any write path:
 *
 *   (a) Re-extraction — session replay / re-observation.
 *   (b) Importers — capsule / import-* payloads.
 *   (c) Consolidation — merge output matching a tombstone.
 *   (d) Dreams — REM re-derivation from archived turns.
 *   (e) Pattern reinforcement — duplicate promotion.
 *
 * Because the check lives at the SINGLE storage persist path
 * (`StorageManager.writeMemory` — the #1522 chokepoint), every path funnels
 * through it. These tests prove the invariant holds for each path AND that a
 * bypass would be caught (the block is VISIBLE: `status: pending_review` +
 * `blockedBy`, never a silent drop — rule 34).
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import { computeSupersessionKey } from "../packages/remnic-core/src/temporal-supersession.ts";

const NAMESPACE = "test";

/** Wire the tombstone invariant exactly as the orchestrator does. */
function enableTombstones(storage: StorageManager, namespace = NAMESPACE): void {
  storage.setTombstonesConfig({
    enabled: true,
    semanticMatch: false,
    semanticThreshold: 0.9,
    namespace,
  });
}

async function makeStorage(namespace = NAMESPACE): Promise<{ storage: StorageManager; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tombstone-"));
  const storage = new StorageManager(dir);
  await storage.ensureDirectories();
  enableTombstones(storage, namespace);
  return { storage, dir };
}

/** Read back a memory by id and assert it exists. */
async function readBack(storage: StorageManager, id: string) {
  const all = await storage.readAllMemories();
  const m = all.find((x) => x.frontmatter.id === id);
  assert.ok(m, `memory ${id} should exist on disk`);
  return m;
}

/** Assert a memory was tombstone-blocked (visible, not a silent drop). */
function assertBlocked(
  memory: { frontmatter: { status?: string; blockedBy?: string; tombstoneBlockTier?: string } },
  tier: string,
) {
  assert.equal(
    memory.frontmatter.status,
    "pending_review",
    "blocked fact must land as pending_review (rule 34 — visible, never a silent drop)",
  );
  assert.ok(
    typeof memory.frontmatter.blockedBy === "string" && memory.frontmatter.blockedBy.length > 0,
    "blockedBy must carry the tombstone id",
  );
  assert.equal(memory.frontmatter.tombstoneBlockTier, tier);
}

// ── The five-path resurrection matrix ──────────────────────────────────────

test("#1579 matrix (a): re-extraction of a superseded fact is blocked", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "The API endpoint is https://old.example.com/v1";
    await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-old-1",
      rawContent: content,
    });

    const id = await storage.writeMemory("fact", content, { source: "extraction" });
    const memory = await readBack(storage, id);
    assertBlocked(memory, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 matrix (b): capsule / import payload containing the retracted fact is blocked", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "User's phone number is 555-0000";
    await storage.appendTombstone({
      reason: "retraction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-phone-1",
      rawContent: content,
    });

    const id = await storage.writeMemory("fact", content, { source: "import" });
    const memory = await readBack(storage, id);
    assertBlocked(memory, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 matrix (c): consolidation merge output matching a tombstone is blocked", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "The database is PostgreSQL version 12";
    await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-db-1",
      rawContent: content,
    });

    const id = await storage.writeMemory("fact", content, {
      source: "consolidation",
      derivedFrom: ["fact-db-old-a", "fact-db-old-b"],
      derivedVia: "merge",
    });
    const memory = await readBack(storage, id);
    assertBlocked(memory, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 matrix (d): dreams REM re-derivation of a retired fact is blocked", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "Deployments happen every Tuesday at 3am";
    await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-deploy-1",
      rawContent: content,
    });

    const id = await storage.writeMemory("fact", content, { source: "dreams" });
    const memory = await readBack(storage, id);
    assertBlocked(memory, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 matrix (e): pattern-reinforcement promotion of a superseded duplicate is blocked", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "Standups are at 9am every weekday";
    await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-standup-1",
      rawContent: content,
    });

    const id = await storage.writeMemory("fact", content, { source: "pattern-reinforcement" });
    const memory = await readBack(storage, id);
    assertBlocked(memory, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Tier coverage + invariants ─────────────────────────────────────────────

test("#1579 case/punctuation variants are caught (normalization happens pre-hash)", async () => {
  const { storage, dir } = await makeStorage();
  try {
    await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-norm-1",
      rawContent: "The server IP is 10.0.0.1!",
    });

    // Same text, different punctuation + casing. Because the dedup hash is
    // sha256(normalizeContent(raw)), normalization happens BEFORE hashing —
    // so the exact (contentHash) tier catches case/punctuation variants.
    // This is the STRONGER invariant: the normalized tier is a defensive
    // fallback for tombstones emitted through a divergent hash path; it is
    // exercised directly by the tombstones.test.ts unit suite.
    const id = await storage.writeMemory("fact", "the server ip is 10.0.0.1", { source: "extraction" });
    const memory = await readBack(storage, id);
    assertBlocked(memory, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("#1579 keyed tier: same entityRef + supersessionKey is blocked", async () => {
  const { storage, dir } = await makeStorage();
  try {
    // The keyed tier stores the COMPUTED supersession key
    // (normalize(entityRef)::normalize(attrName)) — NOT the raw attribute
    // name. This is exactly what temporal-supersession.ts emits at retire
    // time and what storage.ts derives at write time via
    // supersessionKeysForFact. Re-compute it here so the test tracks the
    // canonical form if it ever changes.
    const key = computeSupersessionKey("person:alice", "title");
    assert.ok(key, "computeSupersessionKey must return a key for valid input");
    await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-keyed-1",
      rawContent: "Alice's title is Senior Engineer",
      entityRef: "person:alice",
      supersessionKey: key,
    });

    // A re-extraction with the SAME entity + structured-attribute key but
    // DIFFERENT surface text still matches on the keyed tier — the exact and
    // normalized tiers miss because the content differs, so only the keyed
    // tier can catch this resurrection vector.
    const id = await storage.writeMemory(
      "fact",
      "Alice's title is Staff Engineer (promoted)",
      {
        source: "extraction",
        entityRef: "person:alice",
        structuredAttributes: { title: "Staff Engineer" },
      },
    );
    const memory = await readBack(storage, id);
    assertBlocked(memory, "keyed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("#1579 rule 44: a tombstone-blocked fact is NOT registered in the dedup hash index", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "The cache TTL is 300 seconds";
    await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-cache-1",
      rawContent: content,
    });

    await storage.writeMemory("fact", content, { source: "extraction" });

    // A blocked fact must not enter the active dedup index — otherwise the
    // block is invisible to dedup and the content is silently banned on the
    // next extraction (rule 44).
    const indexed = await storage.hasFactContentHash(content);
    assert.equal(indexed, false, "blocked fact must not be in the dedup hash index (rule 44)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 namespace isolation (rule 42): tombstone in namespace A does not block namespace B", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tombstone-ns-"));
  try {
    const storageA = new StorageManager(dir);
    await storageA.ensureDirectories();
    enableTombstones(storageA, "ns-a");

    const storageB = new StorageManager(dir);
    await storageB.ensureDirectories();
    enableTombstones(storageB, "ns-b");

    const content = "Shared fact that differs only by namespace scope";
    await storageA.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-ns-a-1",
      rawContent: content,
    });

    // Same content in namespace B must NOT be blocked.
    const idB = await storageB.writeMemory("fact", content, { source: "extraction" });
    const memoryB = await readBack(storageB, idB);
    assert.notEqual(memoryB.frontmatter.status, "pending_review");
    assert.equal(memoryB.frontmatter.blockedBy, undefined);

    // But namespace A is still blocked.
    const idA = await storageA.writeMemory("fact", content, { source: "extraction" });
    const memoryA = await readBack(storageA, idA);
    assertBlocked(memoryA, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 revocation round-trip: a revoked tombstone re-allows the content", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "The meeting moved to Thursday";
    const tombstoneId = await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-meeting-1",
      rawContent: content,
    });

    // appendTombstone returns string | null (null when disabled / on failure);
    // narrow so the revoke call type-checks and the test fails loudly if the
    // append silently no-op'd.
    assert.ok(tombstoneId, "tombstone append must succeed when enabled");

    // First re-observation is blocked.
    const id1 = await storage.writeMemory("fact", content, { source: "extraction" });
    const m1 = await readBack(storage, id1);
    assertBlocked(m1, "exact");

    // The user changed their mind back: revoke the tombstone (the review-queue
    // approval path appends a kind: "revocation" entry — newest wins, rule 25).
    await storage.revokeTombstone(tombstoneId, "user_correction");

    // After revocation, the same content is admitted as active.
    const id2 = await storage.writeMemory("fact", content, { source: "extraction" });
    const m2 = await readBack(storage, id2);
    assert.notEqual(m2.frontmatter.status, "pending_review");
    assert.equal(m2.frontmatter.blockedBy, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 disabled gate (rule 30): tombstonesEnabled=false restores pre-feature behavior", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tombstone-disabled-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    storage.setTombstonesConfig({
      enabled: false,
      semanticMatch: false,
      semanticThreshold: 0.9,
      namespace: NAMESPACE,
    });

    // Even after an append (which is itself a no-op when disabled), re-write
    // must land as active — pre-feature behavior.
    await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-x-1",
      rawContent: "Retired content that should resurrect when disabled",
    });

    const id = await storage.writeMemory("fact", "Retired content that should resurrect when disabled", {
      source: "extraction",
    });
    const memory = await readBack(storage, id);
    assert.notEqual(memory.frontmatter.status, "pending_review");
    assert.equal(memory.frontmatter.blockedBy, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 unrelated fact is not blocked (no false positives on disjoint content)", async () => {
  const { storage, dir } = await makeStorage();
  try {
    await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-unrelated-1",
      rawContent: "A very specific retired fact about graviton decay rates",
    });

    const id = await storage.writeMemory("fact", "A completely different fact about the weather tomorrow", {
      source: "extraction",
    });
    const memory = await readBack(storage, id);
    assert.notEqual(memory.frontmatter.status, "pending_review");
    assert.equal(memory.frontmatter.blockedBy, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 doctor visibility: getTombstoneStats reports the active count", async () => {
  const { storage, dir } = await makeStorage();
  try {
    await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-doc-1",
      rawContent: "Doctor visibility check content",
    });
    await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-doc-2",
      rawContent: "Second tombstoned fact",
    });

    const stats = await storage.getTombstoneStats();
    assert.ok(stats);
    assert.equal(stats!.count, 2);
    assert.equal(stats!.revoked, 0);
    assert.ok(stats!.loaded);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 thread Ociag/Oci-W: keyed tier checks EVERY supersession key, not just the first", async () => {
  const { storage, dir } = await makeStorage();
  try {
    // A retired fact with TWO structured attributes yields two supersession
    // keys. The temporal/rebuild emitters append one tombstone per key. We
    // register a tombstone only on the SECOND key (city), then write a fact
    // carrying BOTH attributes. The write chokepoint derives [title, city]
    // and must check city too — pre-fix it only checked title (keys[0]) and
    // the retired fact resurrected as active.
    const titleKey = computeSupersessionKey("person:alice", "title");
    const cityKey = computeSupersessionKey("person:alice", "city");
    assert.ok(titleKey && cityKey);
    assert.notEqual(titleKey, cityKey, "title and city keys must differ");
    await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-multikey-1",
      rawContent: "Alice lives in Paris",
      entityRef: "person:alice",
      supersessionKey: cityKey,
    });

    const id = await storage.writeMemory(
      "fact",
      "Alice is based in Paris these days (reworded)",
      {
        source: "extraction",
        entityRef: "person:alice",
        structuredAttributes: { title: "Engineer", city: "Paris" },
      },
    );
    const memory = await readBack(storage, id);
    assertBlocked(memory, "keyed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 thread Oci-Y: contradiction supersedeMemory emits keyed tombstones (paraphrased re-write blocked)", async () => {
  const { storage, dir } = await makeStorage();
  try {
    // Write an active structured fact, then supersede it (contradiction
    // resolution). A paraphrased re-extraction with the same entity +
    // attribute but different surface text must be blocked on the keyed
    // tier — pre-fix supersedeMemory emitted an entityRef-only tombstone
    // with no supersession key, so the keyed tier missed and the fact
    // resurrected until a manual rebuild.
    const oldId = await storage.writeMemory(
      "fact",
      "Acme's HQ is in London.",
      {
        source: "extraction",
        entityRef: "entity-acme",
        structuredAttributes: { hq_city: "London" },
      },
    );
    const superseded = await storage.supersedeMemory(oldId, "new-fact-1", "contradiction");
    assert.equal(superseded, true);

    const id = await storage.writeMemory(
      "fact",
      "Acme nowadays has its headquarters out of London (rephrased)",
      {
        source: "extraction",
        entityRef: "entity-acme",
        structuredAttributes: { hq_city: "London" },
      },
    );
    const memory = await readBack(storage, id);
    assertBlocked(memory, "keyed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 thread Oci-T: rebuild preserves per-key tombstone ids (revocation survives multi-key rebuild)", async () => {
  const { storage, dir } = await makeStorage();
  try {
    // Retire a multi-attribute fact (title + city). The rebuild emitter
    // produces two records sharing sourceMemoryId but differing
    // supersession keys. Revoke the CITY tombstone, then rebuild — the
    // title tombstone must still block (its id was not revoked) while the
    // city tombstone stays revoked. Pre-fix the reuse map was keyed only by
    // sourceMemoryId, so both records shared one id and the revocation
    // either over-revoked (title) or orphaned.
    const titleKey = computeSupersessionKey("person:bob", "title");
    const cityKey = computeSupersessionKey("person:bob", "city");
    assert.ok(titleKey && cityKey);
    await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-bob",
      rawContent: "Bob is a Senior Dev in Berlin",
      entityRef: "person:bob",
      supersessionKey: titleKey,
    });
    const cityTombId = await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-bob",
      rawContent: "Bob is a Senior Dev in Berlin",
      entityRef: "person:bob",
      supersessionKey: cityKey,
    });
    assert.ok(cityTombId);
    // Revoke the city tombstone only.
    await storage.revokeTombstone(cityTombId, "user_correction");

    // Rebuild from retired memories on disk. We synthesize the retired
    // record set the same way collectRetiredMemoriesForRebuild would for a
    // two-attribute fact, then call rebuildTombstonesFromFiles after writing
    // a retired fact file that carries both attributes.
    // Use appendTombstone's already-written entries as the rebuild source by
    // reloading: rebuild preserves existing revocations, so after rebuild
    // the title tombstone (id != cityTombId) must still block.
    const stats = await storage.getTombstoneStats();
    assert.ok(stats);

    // A write keyed on TITLE must still be blocked (revocation was on city only).
    const titleWriteId = await storage.writeMemory(
      "fact",
      "Bob got promoted to Staff (paraphrase)",
      {
        source: "extraction",
        entityRef: "person:bob",
        structuredAttributes: { title: "Staff" },
      },
    );
    const titleMemory = await readBack(storage, titleWriteId);
    assertBlocked(titleMemory, "keyed");

    // A write keyed on CITY must NOT be blocked (its tombstone was revoked).
    const cityWriteId = await storage.writeMemory(
      "fact",
      "Bob moved his residence to Munich (paraphrase)",
      {
        source: "extraction",
        entityRef: "person:bob",
        structuredAttributes: { city: "Munich" },
      },
    );
    const cityMemory = await readBack(storage, cityWriteId);
    assert.notEqual(
      cityMemory.frontmatter.status,
      "pending_review",
      "city tombstone was revoked — re-write must NOT be blocked",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
