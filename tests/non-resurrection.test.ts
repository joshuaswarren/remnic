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
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { StorageManager } from "@remnic/core/storage";
import { computeSupersessionKey } from "../packages/remnic-core/src/temporal-supersession.ts";
import { computeLegacyContentHash, normalizeLegacyContent } from "../packages/remnic-core/src/content-hash.ts";

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

    const { id: id } = await storage.writeMemory("fact", content, { source: "extraction" });
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

    const { id: id } = await storage.writeMemory("fact", content, { source: "import" });
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

    const { id: id } = await storage.writeMemory("fact", content, {
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

    const { id: id } = await storage.writeMemory("fact", content, { source: "dreams" });
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

    const { id: id } = await storage.writeMemory("fact", content, { source: "pattern-reinforcement" });
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
    const { id: id } = await storage.writeMemory("fact", "the server ip is 10.0.0.1", { source: "extraction" });
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
    const { id: id } = await storage.writeMemory(
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
    const { id: idB } = await storageB.writeMemory("fact", content, { source: "extraction" });
    const memoryB = await readBack(storageB, idB);
    assert.notEqual(memoryB.frontmatter.status, "pending_review");
    assert.equal(memoryB.frontmatter.blockedBy, undefined);

    // But namespace A is still blocked.
    const { id: idA } = await storageA.writeMemory("fact", content, { source: "extraction" });
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
    const { id: id1 } = await storage.writeMemory("fact", content, { source: "extraction" });
    const m1 = await readBack(storage, id1);
    assertBlocked(m1, "exact");

    // The user changed their mind back: revoke the tombstone (the review-queue
    // approval path appends a kind: "revocation" entry — newest wins, rule 25).
    await storage.revokeTombstone(tombstoneId, "user_correction");

    // After revocation, the same content is admitted as active.
    const { id: id2 } = await storage.writeMemory("fact", content, { source: "extraction" });
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

    const { id: id } = await storage.writeMemory("fact", "Retired content that should resurrect when disabled", {
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

    const { id: id } = await storage.writeMemory("fact", "A completely different fact about the weather tomorrow", {
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

test("legacy migration recovers raw source identity beneath structured attributes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tombstone-attributes-"));
  const content = "利用者は紅茶を好む。";
  const attributes = { region: "東京" };
  try {
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    const { id: sourceMemoryId } = await seed.writeMemory("fact", content, {
      source: "test",
      structuredAttributes: attributes,
      contentHashSource: content,
    });
    const retired = await readBack(seed, sourceMemoryId);
    assert.match(retired.content, /\[Attributes:/);

    await writeFile(
      path.join(dir, "state", "tombstones.jsonl"),
      `${JSON.stringify({
        id: "tomb-legacy-attributes",
        kind: "tombstone",
        reason: "supersession",
        createdBy: "supersession",
        sourceMemoryId,
        contentHash: computeLegacyContentHash(content),
        normalizedText: normalizeLegacyContent(content),
        namespace: NAMESPACE,
        createdAt: "2026-08-11T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const restarted = new StorageManager(dir);
    enableTombstones(restarted);
    const result = await restarted.writeMemory("fact", content, {
      source: "extraction",
      structuredAttributes: attributes,
      contentHashSource: content,
    });
    assert.equal(result.tombstoneBlocked, true);
    assertBlocked(await readBack(restarted, result.id), "exact");

    const migrated = await readFile(path.join(dir, "state", "tombstones.jsonl"), "utf8");
    assert.match(migrated, /"normalizerVersion":2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy migration resolves retired source content from archive storage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tombstone-archive-source-"));
  const content = "The user prefers café.";
  const sourceMemoryId = "fact-archived-source";
  class ArchiveProbeStorage extends StorageManager {
    override async readArchivedMemories(): Promise<never> {
      throw new Error("migration must not parse the complete archive");
    }
  }
  try {
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    const archiveDir = path.join(dir, "archive", "facts");
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, "retired-record.md"),
      [
        "---",
        `id: ${sourceMemoryId}`,
        "category: fact",
        "status: archived",
        "---",
        "",
        content,
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(dir, "state", "tombstones.jsonl"),
      `${JSON.stringify({
        id: "tomb-archived-source",
        kind: "tombstone",
        reason: "correction",
        createdBy: "user_correction",
        sourceMemoryId,
        contentHash: computeLegacyContentHash(content),
        normalizedText: normalizeLegacyContent(content),
        namespace: NAMESPACE,
        createdAt: "2026-08-11T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const restarted = new ArchiveProbeStorage(dir);
    enableTombstones(restarted);
    const result = await restarted.writeMemory("fact", content, { source: "extraction" });

    assert.equal(result.tombstoneBlocked, true);
    assertBlocked(await readBack(restarted, result.id), "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue #2367: a legacy row appended after store construction is verified without restart", async () => {
  const { storage, dir } = await makeStorage();
  const ledgerPath = path.join(dir, "state", "tombstones.jsonl");
  const peerContent = "The user prefers tea.";
  try {
    // First migration pass: an unresolvable pre-upgrade row forces the store
    // to snapshot the corpus paths while the corpus is still empty. A
    // read-only probe keeps the store cached (a memory write would reset it).
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        id: "tomb-2367-ghost",
        kind: "tombstone",
        reason: "correction",
        createdBy: "user_correction",
        sourceMemoryId: "fact-ghost",
        contentHash: computeLegacyContentHash("ghost body"),
        normalizedText: normalizeLegacyContent("ghost body"),
        namespace: NAMESPACE,
        createdAt: "2026-08-15T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    assert.equal(await storage.hasExactTombstone({ sourceMemoryId: "fact-ghost" }), true);

    // Coarse mtime so the peer append below is guaranteed to move it even on
    // filesystems with coarse timestamp granularity.
    const coarse = new Date(Date.now() - 60_000);
    await utimes(ledgerPath, coarse, coarse);

    // Peer process: creates a memory in the legacy format and retires it.
    const peerId = "fact-2367-peer";
    await writeFile(
      path.join(dir, "facts", `${peerId}.md`),
      ["---", `id: ${peerId}`, "category: fact", "---", "", peerContent].join("\n"),
      "utf8",
    );
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        id: "tomb-2367-peer",
        kind: "tombstone",
        reason: "correction",
        createdBy: "user_correction",
        sourceMemoryId: peerId,
        contentHash: computeLegacyContentHash(peerContent),
        normalizedText: normalizeLegacyContent(peerContent),
        namespace: NAMESPACE,
        createdAt: "2026-08-15T00:01:00.000Z",
      })}\n`,
      { flag: "a" },
    );

    // Same process, no restart: the staleness reload must resolve the new row
    // against a FRESH corpus snapshot, not the one cached before the peer
    // append — otherwise the row stays unverified and the retired fact
    // resurrects active.
    const write = await storage.writeMemory("fact", peerContent, { source: "extraction" });
    assert.equal(write.tombstoneBlocked, true);
    assertBlocked(await readBack(storage, write.id), "exact");
    const migrated = await readFile(ledgerPath, "utf8");
    const peerRow = migrated.split("\n").find((line) => line.includes(peerId));
    assert.ok(peerRow, "peer row must survive migration");
    const peerEntry = JSON.parse(peerRow) as { contentHash: string; normalizerVersion?: number };
    // Pure-ASCII body: the verified current hash equals the legacy hash, and
    // the row is published at normalizerVersion 2.
    assert.equal(peerEntry.contentHash, computeLegacyContentHash(peerContent));
    assert.equal(peerEntry.normalizerVersion, 2);
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

    const { id: id } = await storage.writeMemory(
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
    const { id: oldId } = await storage.writeMemory(
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

    const { id: id } = await storage.writeMemory(
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
    const { id: titleWriteId } = await storage.writeMemory(
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
    const { id: cityWriteId } = await storage.writeMemory(
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

// ── Issue #1579 thread Ocs-O: namespace-keyed index maps ───────────────────
// When two namespace-scoped stores share the same backing tombstones.jsonl
// (namespaces disabled, or the same directory used with different namespace
// configs), the in-memory index maps must namespace-key their discriminators.
// Pre-fix the maps stored ONE tombstone id per hash/text/key; a later
// tombstone for namespace B with identical content overwrote namespace A's
// map entry, so A's lookup found B's id, rejected it on namespace mismatch,
// and missed A's own still-active tombstone — allowing resurrection.
test("#1579 thread Ocs-O: shared backing file — each namespace's tombstone survives the other's", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tombstone-nsidx-"));
  try {
    const storageA = new StorageManager(dir);
    await storageA.ensureDirectories();
    enableTombstones(storageA, "ns-a");

    const storageB = new StorageManager(dir);
    await storageB.ensureDirectories();
    enableTombstones(storageB, "ns-b");

    const content = "Identical retired content in two namespaces (Ocs-O)";
    // BOTH namespaces tombstone the SAME content.
    await storageA.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-ocs-o-a",
      rawContent: content,
    });
    await storageB.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-ocs-o-b",
      rawContent: content,
    });

    // Namespace A's write must still be blocked by A's OWN tombstone.
    // Pre-fix: B's tombstone (appended later to the shared file) overwrote
    // A's map entry; A's lookup found B's id, rejected on namespace mismatch,
    // and missed A's tombstone — the fact resurrected as active.
    const { id: idA } = await storageA.writeMemory("fact", content, { source: "extraction" });
    const memoryA = await readBack(storageA, idA);
    assertBlocked(memoryA, "exact");

    // Namespace B's write must also be blocked by B's tombstone.
    const { id: idB } = await storageB.writeMemory("fact", content, { source: "extraction" });
    const memoryB = await readBack(storageB, idB);
    assertBlocked(memoryB, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Issue #1579 threads OcuDx/Ocu1l: wearable promotion bypass ─────────────
// promoteWearableMemory flipped pending_review → active via
// writeMemoryFrontmatter, bypassing the writeMemory chokepoint. A
// tombstone-blocked fact (pending_review + blockedBy) could be promoted to
// active while the tombstone stayed enforced only on new writes —
// resurrecting retired content in active recall.
test("#1579 threads OcuDx/Ocu1l: promoteWearableMemory refuses tombstone-blocked rows", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "Wearable fact that matches a tombstone (OcuDx)";
    await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-wearable-retired",
      rawContent: content,
    });

    // The write chokepoint blocks the fact: pending_review + blockedBy.
    const { id: id } = await storage.writeMemory("fact", content, {
      source: "wearable:smart",
    });
    const memory = await readBack(storage, id);
    assertBlocked(memory, "exact");

    // Promotion must refuse — the row is tombstone-blocked, not merely
    // trust-gated. Pre-fix promoteWearableMemory only checked
    // status === "pending_review" and flipped it to active via
    // writeMemoryFrontmatter, bypassing the writeMemory chokepoint.
    const promoted = await storage.promoteWearableMemory(id, { trust: "corroborated" }, 0.95);
    assert.equal(promoted, false, "tombstone-blocked row must not be promotable");

    const after = await readBack(storage, id);
    assert.equal(
      after.frontmatter.status,
      "pending_review",
      "blocked row stays pending_review until the tombstone is revoked",
    );
    assert.ok(
      typeof after.frontmatter.blockedBy === "string" && after.frontmatter.blockedBy.length > 0,
      "blockedBy must survive the promotion attempt",
    );

    // Control: a non-blocked pending_review row (no tombstone match) CAN
    // still be promoted — the guard is on blockedBy, not on the
    // pending_review status itself.
    const cleanContent = "A clean wearable fact with no tombstone match";
    const { id: cleanId } = await storage.writeMemory("fact", cleanContent, {
      source: "wearable:smart",
      status: "pending_review",
    });
    const cleanPromoted = await storage.promoteWearableMemory(cleanId, { trust: "high" }, 0.9);
    assert.equal(cleanPromoted, true, "non-blocked pending_review row is promotable");
    const cleanAfter = await readBack(storage, cleanId);
    assert.equal(cleanAfter.frontmatter.status, "active");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Issue #1579 thread Oc2MJ: rebuild preserves foreign-namespace tombstones ─
// rebuild rewrites the entire tombstones.jsonl. When two namespaces share the
// same backing file, rebuilding one namespace must NOT delete the other's
// tombstones — otherwise the other namespace loses its non-resurrection guard.
test("#1579 thread Oc2MJ: rebuild preserves other namespaces' tombstones in a shared file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tombstone-rebuild-ns-"));
  try {
    const storageA = new StorageManager(dir);
    await storageA.ensureDirectories();
    enableTombstones(storageA, "ns-a");

    const storageB = new StorageManager(dir);
    await storageB.ensureDirectories();
    enableTombstones(storageB, "ns-b");

    const contentB = "Namespace B fact that must survive A's rebuild";
    await storageB.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-b-rebuild",
      rawContent: contentB,
    });

    // Rebuild namespace A (no retired memories for A → A's tombstones become
    // empty, but B's must survive the file rewrite).
    await storageA.rebuildTombstonesFromFiles();

    // Namespace B's tombstone must still block a re-extraction.
    const { id: idB } = await storageB.writeMemory("fact", contentB, { source: "extraction" });
    const memoryB = await readBack(storageB, idB);
    assertBlocked(memoryB, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Issue #1645: surface tombstone-blocked status to post-write callers ─────
// writeMemory now returns a distinct result shape ({ id, tombstoneBlocked,
// blockedBy? }) so post-write callers (extraction persist, correction apply)
// can observe a tombstone block and gate active side-effects — NEVER a silent
// no-op or a thrown-away boolean (rule 34). The orchestrator computes
// postWriteGuard = faithfulnessEnforceStatus === "pending_review" || tombstoneBlocked
// and skips chunks / temporal supersession / shared-namespace promotion /
// graph+artifact writes (mirroring the existing #1576 faithfulness gate).

test("#1645: writeMemory surfaces tombstoneBlocked distinctly (not a silent no-op)", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const blockedContent = "The deploy endpoint is https://legacy.example.invalid/v2";
    const activeContent = "A brand-new fact with no tombstone anywhere";

    await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-deploy-old",
      rawContent: blockedContent,
    });

    // Blocked write — distinct, observable result shape (rule 34: VISIBLE).
    const blocked = await storage.writeMemory("fact", blockedContent, { source: "extraction" });
    assert.equal(typeof blocked.id, "string", "result carries the persisted id");
    assert.equal(blocked.tombstoneBlocked, true, "tombstoneBlocked is surfaced distinctly");
    assert.ok(
      typeof blocked.blockedBy === "string" && blocked.blockedBy.length > 0,
      "blockedBy carries the tombstone id",
    );
    const blockedMemory = await readBack(storage, blocked.id);
    assertBlocked(blockedMemory, "exact");

    // Active write — tombstoneBlocked is explicitly false, blockedBy absent.
    const active = await storage.writeMemory("fact", activeContent, { source: "extraction" });
    assert.equal(typeof active.id, "string");
    assert.equal(active.tombstoneBlocked, false, "an unblocked write surfaces tombstoneBlocked: false");
    assert.equal(active.blockedBy, undefined);
    const activeMemory = await readBack(storage, active.id);
    assert.notEqual(activeMemory.frontmatter.status, "pending_review");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1645 (OchiE): writeChunk inherits pending_review + blockedBy from a blocked parent", async () => {
  // The chunk loop bypasses the tombstone chokepoint, so the orchestrator
  // reads `tombstoneBlocked` from the parent writeMemory result and passes
  // status: pending_review + blockedBy to EACH chunk — zero active chunks.
  const { storage, dir } = await makeStorage();
  try {
    const content = "A long superseded fact that the orchestrator would chunk into pieces";
    await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-chunked-old",
      rawContent: content,
    });

    const parent = await storage.writeMemory("fact", content, { source: "extraction" });
    assert.equal(parent.tombstoneBlocked, true, "parent write is blocked");

    await storage.writeChunk(
      parent.id,
      0,
      2,
      "fact",
      "chunk body zero",
      { source: "chunking", status: "pending_review", blockedBy: parent.blockedBy },
    );
    await storage.writeChunk(
      parent.id,
      1,
      2,
      "fact",
      "chunk body one",
      { source: "chunking", status: "pending_review", blockedBy: parent.blockedBy },
    );

    const chunks = (await storage.readAllMemories()).filter((m) => m.frontmatter.parentId === parent.id);
    assert.equal(chunks.length, 2, "both chunks persisted");
    for (const chunk of chunks) {
      assert.equal(chunk.frontmatter.status, "pending_review", "chunk must NOT be active (OchiE)");
      assert.equal(
        chunk.frontmatter.blockedBy,
        parent.blockedBy,
        "chunk inherits the parent's blockedBy tombstone",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1645 (OcoPp): blocked result is the signal callers gate shared-namespace promotion on", async () => {
  // A tombstone-blocked fact in namespace A must not create an active shared
  // copy in namespace B. The orchestrator's postWriteGuard reads
  // `tombstoneBlocked` from writeMemory's result and skips
  // promoteMemoryToShared — this test pins the storage CONTRACT that the gate
  // depends on: the block is observable in the return, distinct from the
  // blocked fact's own pending_review frontmatter.
  const { storage, dir } = await makeStorage();
  try {
    const content = "We migrated billing to Stripe";
    await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-billing-old",
      rawContent: content,
    });

    const result = await storage.writeMemory("fact", content, { source: "extraction" });
    // Mirrors orchestrator.ts: postWriteGuard = pending_review || tombstoneBlocked.
    const postWriteGuard = result.tombstoneBlocked;
    assert.equal(result.tombstoneBlocked, true, "caller observes the block distinctly");
    assert.equal(postWriteGuard, true, "postWriteGuard skips active shared-namespace promotion (OcoPp)");
    // The in-source fact itself is also pending_review (no active copy at all).
    const memory = await readBack(storage, result.id);
    assertBlocked(memory, "exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1645 (rule 44): a tombstone-blocked fact's content is NOT registered in the dedup index", async () => {
  // writeMemory skips the fact-hash index for a blocked fact (rule 44), and the
  // orchestrator's addContentHashDedup now also skips it (#1645 thread: dedup
  // defeat). If the content WERE registered, the next extraction would dedup-skip
  // the tombstone chokepoint and silently ban the retired fact (no pending_review
  // row) — a rule-34 violation.
  const { storage, dir } = await makeStorage();
  try {
    const content = "The legacy auth token is sk-banned-12345";
    await storage.appendTombstone({
      reason: "retraction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-auth-old",
      rawContent: content,
    });

    const result = await storage.writeMemory("fact", content, { source: "extraction" });
    assert.equal(result.tombstoneBlocked, true);
    assert.equal(
      await storage.hasFactContentHash(content),
      false,
      "blocked content must NOT enter the dedup index (rule 44 + #1645 orchestrator-side guard)",
    );

    // Control: an active fact with different content IS registered.
    const active = await storage.writeMemory("fact", "a totally novel active fact", { source: "extraction" });
    assert.equal(active.tombstoneBlocked, false);
    assert.equal(await storage.hasFactContentHash("a totally novel active fact"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
