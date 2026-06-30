import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

// ── Round 2, Issue B (cursor[bot] Medium): a shared-namespace promotion writes
// to the shared namespace via `sharedStorage.writeMemory`, but round 1 only
// recorded `markCatalogWrite` for the routed SOURCE namespace. When promotion is
// the only write the shared namespace receives, its catalog `lastWriteAt` stayed
// stale — skewing `writtenSince` filters and maintenance fanout. The orchestrator
// now fires `markCatalogWrite(sharedNamespace, sharedStorage.dir)` after the
// promoted write lands. This test asserts that contract (the exact call the
// promotion path makes) updates the SHARED record without touching the source.
test("shared-namespace promotion updates the shared namespace lastWriteAt in the catalog", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const orchestrator = new Orchestrator(config) as any;
    assert.equal(orchestrator.namespaceCatalog.enabled, true, "catalog must be enabled");

    // Resolve shared storage exactly as the promotion path does (router-routed),
    // so sharedStorage.dir matches the dir the orchestrator passes to the catalog.
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    // Before: no shared catalog write recorded yet.
    const before = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(!before?.lastWriteAt, "shared lastWriteAt should be unset before promotion");

    // Fire the exact catalog touch the promotion path now performs after a
    // successful sharedStorage.writeMemory. markCatalogWrite is private; access
    // via the `as any` orchestrator handle, mirroring the routing tests.
    orchestrator.markCatalogWrite(config.sharedNamespace, sharedStorage.dir);

    // markCatalogWrite is fire-and-forget; let the serialized append settle.
    await orchestrator.namespaceCatalog.markRead("shared"); // serializes after the write

    const after = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(after, "shared record must exist after promotion touch");
    assert.equal(after?.kind, "shared");
    assert.ok(
      after?.lastWriteAt,
      "shared promotion must update the shared namespace's lastWriteAt",
    );
    assert.equal(
      after?.storageDir,
      sharedStorage.dir,
      "shared catalog storageDir must match the router-resolved shared dir",
    );

    // No double-count of the source: the default/source namespace must not have
    // received a write touch from the shared promotion.
    const sourceRecord = await orchestrator.namespaceCatalog.getNamespaceRecord("default");
    assert.ok(
      !sourceRecord?.lastWriteAt,
      "shared promotion must not record a write on the source namespace",
    );

    // The shared record is surfaced by a writtenSince filter (the consumer the
    // bug report cited) using a lower bound just before the touch.
    const since = new Date(Date.parse(after!.lastWriteAt!) - 1000);
    const written = await orchestrator.namespaceCatalog.listNamespaces({ writtenSince: since });
    assert.ok(
      written.some((r: { namespace: string }) => r.namespace === "shared"),
      "writtenSince must now surface the shared namespace after promotion",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Integration guard for Issue B: drive the actual promotion path via
// `persistExtraction` (auto-promote enabled, source namespace != shared) and
// assert the SHARED catalog record gains lastWriteAt as a side effect of the
// promoted write. This fails on the round-1 code (no shared markCatalogWrite in
// promoteMemoryToShared) and passes after the fix.
test("persistExtraction shared promotion records a shared-namespace catalog write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-integ-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      autoPromoteToSharedEnabled: true,
      autoPromoteToSharedCategories: ["fact"],
      autoPromoteMinConfidenceTier: "implied",
      // Keep the write path simple/offline: no linking, no chunking-by-size, no
      // semantic dedup that would need an embedding backend.
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });

    const orchestrator = new Orchestrator(config) as any;
    // QMD unavailable so the write path stays offline and deterministic.
    orchestrator.qmd = { isAvailable: () => false };

    const sourceStorage = await orchestrator.getStorage("default");
    await sourceStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    // A single high-confidence fact in a promotable category.
    const result = {
      facts: [
        {
          content: "The team standup is at 9am every weekday.",
          category: "fact",
          confidence: 0.95,
          tags: ["schedule"],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    };

    await orchestrator.persistExtraction(result, sourceStorage, null, {
      sessionKey: "s1",
      principal: "default",
    });

    // Let any fire-and-forget catalog appends settle by serializing a read.
    await orchestrator.namespaceCatalog.markRead("shared");

    const sharedRecord = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(sharedRecord, "shared record must exist after a promoted write");
    assert.ok(
      sharedRecord?.lastWriteAt,
      "the shared promotion must record a write touch on the shared namespace",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("shared promotion records catalog write after shared temporal supersession", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-order-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      autoPromoteToSharedEnabled: true,
      autoPromoteToSharedCategories: ["fact"],
      autoPromoteMinConfidenceTier: "implied",
      temporalSupersessionEnabled: true,
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });

    const orchestrator = new Orchestrator(config) as any;
    orchestrator.qmd = { isAvailable: () => false };

    const sourceStorage = await orchestrator.getStorage("default");
    await sourceStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    const entity = "user-shared-promotion-order";
    const oldId = await sharedStorage.writeMemory("fact", "Lives in NYC.", {
      entityRef: entity,
      structuredAttributes: { city: "NYC" },
      source: "seed",
      confidence: 0.9,
      tags: ["shared-promotion"],
      validAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const sharedMutationOrder: string[] = [];
    const originalMarkCatalogWrite = orchestrator.markCatalogWrite.bind(orchestrator);
    orchestrator.markCatalogWrite = (namespace: string, storageDir?: string) => {
      if (namespace === config.sharedNamespace) sharedMutationOrder.push("catalog");
      return originalMarkCatalogWrite(namespace, storageDir);
    };
    const originalWriteMemoryFrontmatter = sharedStorage.writeMemoryFrontmatter.bind(sharedStorage);
    sharedStorage.writeMemoryFrontmatter = async (...args: any[]) => {
      sharedMutationOrder.push("frontmatter");
      return originalWriteMemoryFrontmatter(...(args as Parameters<typeof originalWriteMemoryFrontmatter>));
    };

    const result = {
      facts: [
        {
          content: "Lives in Austin.",
          category: "fact",
          confidence: 0.95,
          tags: ["shared-promotion"],
          entityRef: entity,
          structuredAttributes: { city: "Austin" },
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    };

    await orchestrator.persistExtraction(result, sourceStorage, null, {
      sessionKey: "s1",
      principal: "default",
    });

    await orchestrator.namespaceCatalog.markRead("shared");
    const oldMemory = await sharedStorage.getMemoryById(oldId);
    const sharedRecord = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");

    assert.equal(oldMemory?.frontmatter.status, "superseded", "precondition: shared supersession ran");
    assert.ok(oldMemory?.frontmatter.supersededAt, "supersession must write supersededAt");
    assert.ok(sharedRecord?.lastWriteAt, "shared promotion must record a catalog write");
    assert.deepEqual(
      sharedMutationOrder,
      ["frontmatter", "catalog"],
      "the shared catalog touch must run after shared supersession frontmatter is written",
    );
    assert.ok(
      Date.parse(sharedRecord!.lastWriteAt!) >= Date.parse(oldMemory!.frontmatter.supersededAt!),
      "shared catalog lastWriteAt must not precede supersession frontmatter mutation",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 8 (codex P2 — NElSf): the shared-promotion HASH-DEDUP branch returns
// early (an active matching shared fact already exists, so no NEW write happens),
// but it first runs `applyTemporalSupersession`, which REWRITES shared-namespace
// frontmatter to retire stale conflicting facts. That return path skips the
// post-write `markCatalogWrite`, so a supersession-only update left the shared
// record's `lastWriteAt` stale and `writtenSince` maintenance/QMD fanout could
// skip the namespace. The fix touches the catalog on the dedup return path WHEN
// any ids were actually superseded. This drives the real path: an OLD conflicting
// active shared fact (entity E, {city: NYC}) plus a hash-indexed active shared
// fact (content X, entity E, {city: Austin}); promoting content X (entity E,
// {city: Austin}) hits the hash-dedup branch, supersedes the older NYC fact, and
// must record a shared-namespace catalog write. Fails pre-fix (dedup return skips
// markCatalogWrite); passes after.
test("shared hash-dedup supersession-only update records a shared-namespace catalog write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-dedup-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      autoPromoteToSharedEnabled: true,
      autoPromoteToSharedCategories: ["fact"],
      autoPromoteMinConfidenceTier: "implied",
      temporalSupersessionEnabled: true,
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });

    const orchestrator = new Orchestrator(config) as any;
    orchestrator.qmd = { isAvailable: () => false };

    const sourceStorage = await orchestrator.getStorage("default");
    await sourceStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    const entity = "user-shared-dedup";
    const matchedContent = "Lives in Austin.";

    // 1) An OLD conflicting active shared fact (same entity, attribute city=NYC)
    //    that a later city=Austin supersession must retire. Older timestamp so it
    //    is the one superseded, not the incoming.
    await sharedStorage.writeMemory("fact", "Lives in NYC.", {
      entityRef: entity,
      structuredAttributes: { city: "NYC" },
      source: "seed",
      confidence: 0.9,
      tags: ["shared-promotion"],
      validAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // 2) An ACTIVE shared fact whose ENRICHED content hash is indexed, so the
    //    incoming promotion of the SAME content + attributes takes the hash-dedup
    //    short-circuit. We do NOT pass `contentHashSource`, so writeMemory indexes
    //    the enriched body (`<content>\n[Attributes: city: Austin]`) — the exact
    //    `dedupContent` the orchestrator computes for the incoming fact, so both
    //    `hasFactContentHash(dedupContent)` AND the inner same-content match fire.
    await sharedStorage.writeMemory("fact", matchedContent, {
      entityRef: entity,
      structuredAttributes: { city: "Austin" },
      source: "seed",
      confidence: 0.9,
      tags: ["shared-promotion"],
      validAt: new Date(Date.now() - 30_000).toISOString(),
    });
    sharedStorage.invalidateAllMemoriesCacheForDir?.();

    // Rebuild the orchestrator's live content-hash index so hasFactContentHash
    // sees the seeded shared fact (mirrors gateway_start index construction).
    orchestrator.invalidateLiveContentHashIndex?.();

    // Baseline: record the shared namespace's current lastWriteAt (set by the
    // seed writes' router resolution, if any). We assert the dedup path ADVANCES
    // it — i.e. a fresh write touch is recorded on the supersession-only return.
    await orchestrator.namespaceCatalog.markMaintenance("shared", "probe");
    const before = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    const beforeWrite = before?.lastWriteAt;

    // 3) Promote the SAME content (entity, city=Austin) — hits the hash-dedup
    //    branch (active matching fact exists), supersedes the older NYC fact, and
    //    returns WITHOUT a new write. The fix must still record a shared catalog
    //    write because supersession mutated the shared namespace.
    const result = {
      facts: [
        {
          content: matchedContent,
          category: "fact",
          confidence: 0.95,
          tags: ["shared-promotion"],
          entityRef: entity,
          structuredAttributes: { city: "Austin" },
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    };
    await orchestrator.persistExtraction(result, sourceStorage, null, {
      sessionKey: "s1",
      principal: "default",
    });

    // Serialize a read to flush fire-and-forget catalog appends.
    await orchestrator.namespaceCatalog.markRead("shared");
    const after = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(after?.lastWriteAt, "shared record must carry a lastWriteAt after the dedup supersession");
    if (beforeWrite) {
      assert.ok(
        Date.parse(after!.lastWriteAt!) > Date.parse(beforeWrite),
        "the supersession-only dedup path must ADVANCE the shared namespace lastWriteAt",
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 3, Issue #3 (codex P2): when the planner selects no_recall, retrieval
// is skipped — so the recall path must NOT mark every readable namespace as
// read. A trivial prompt ("ok") classifies as no_recall; assert the catalog
// records no lastReadAt for the recalled namespaces. Fails on the round-2 code
// (read touch fired before the no_recall early return), passes after the gate.
test("no_recall recall does not record catalog read touches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-no-recall-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const orchestrator = new Orchestrator(config) as any;
    assert.equal(orchestrator.namespaceCatalog.enabled, true, "catalog must be enabled");

    // A trivial prompt the planner classifies as no_recall (mirrors the existing
    // recall-no-recall-short-circuit tests).
    const out = await orchestrator.recallInternal("ok", "user:test:no-recall-catalog");
    assert.equal(out, "", "no_recall must produce no recall context");

    // Allow any (incorrect) fire-and-forget read touch to settle, then serialize
    // a maintenance touch on the catalog write chain to flush pending appends
    // before asserting NONE was recorded for the readable namespaces.
    await new Promise((r) => setTimeout(r, 20));
    await orchestrator.namespaceCatalog.markMaintenance("default", "probe");
    const records = await orchestrator.namespaceCatalog.listNamespaces();
    for (const r of records) {
      assert.ok(
        !r.lastReadAt,
        `no_recall must not record a read touch (namespace ${r.namespace} has lastReadAt)`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 4, Issue #5 (codex P2): even when recallMode is not no_recall, a zero
// effective result limit (topK: 0, disabled/zero `memories` section) means no
// namespace is actually read — the QMD path returns before searching when
// recallResultLimit <= 0. The catalog must not record read touches in that case.
test("zero recall result limit (topK:0) records no catalog read touches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-zero-limit-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const orchestrator = new Orchestrator(config) as any;
    orchestrator.qmd = { isAvailable: () => false };

    // Force a non-no_recall mode but a zero result limit via topK: 0.
    await orchestrator.recallInternal(
      "What is the team standup schedule and who attends it?",
      "user:test:zero-limit",
      { mode: "minimal", topK: 0 },
    );

    // Drain any fire-and-forget tails, then serialize a maintenance touch on the
    // catalog write chain so any (incorrectly) enqueued read append is flushed
    // before we assert its absence.
    await new Promise((r) => setTimeout(r, 20));
    await orchestrator.namespaceCatalog.markMaintenance("default", "probe");
    const records = await orchestrator.namespaceCatalog.listNamespaces();
    for (const r of records) {
      assert.ok(
        !r.lastReadAt,
        `zero result limit must not record a read touch (namespace ${r.namespace} has lastReadAt)`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NBsFz): `namespaceFromStorageDir` decodes ONLY a genuine
// tokenized dir — one whose decoded identity round-trips back to the exact dir
// name via `namespaceIdentityToken`. A `ns-...`-shaped dir name that does NOT
// round-trip is treated as a literal raw name and returned verbatim, so a
// token-shaped raw namespace name is never silently rewritten into a different
// identity by the catalog write touch. (Regression guard for the round-trip
// containment; the inherent same-bytes ambiguity of a raw name that is ALSO a
// canonical token is resolved at the call site by passing the known namespace.)
test("namespaceFromStorageDir preserves a token-shaped literal raw namespace name", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-from-dir-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });
    const orchestrator = new Orchestrator(config) as any;

    // Helper mirroring `namespaceIdentityToken`: ns-<lowercase hex of UTF-8>.
    const tokenize = (name: string) => `ns-${Buffer.from(name, "utf8").toString("hex")}`;

    // A legacy raw-name dir whose name is `ns-`-prefixed and hex-shaped but is
    // NOT a valid canonical token (odd-length hex does not decode). Pre-fix this
    // mangled the name via `namespaceIdentityFromToken(...) ?? name`; the
    // round-trip guard now preserves it verbatim.
    const literal = "ns-deadbee"; // odd-length hex after the prefix → not decodable
    const rawDir = path.join(memoryDir, "namespaces", literal);
    assert.equal(
      orchestrator.namespaceFromStorageDir(rawDir),
      literal,
      "a token-shaped but non-canonical raw name must be preserved verbatim, not mangled",
    );

    // Control: a GENUINE tokenized dir still decodes back to its identity.
    const realNs = "team-pi-project-origin-abc123";
    const tokenDir = path.join(memoryDir, "namespaces", tokenize(realNs));
    assert.equal(
      orchestrator.namespaceFromStorageDir(tokenDir),
      realNs,
      "a genuine tokenized dir must still decode to its namespace identity",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── codex P2 (NRCve): the round-trip guard is TAUTOLOGICAL for a canonical token
// string, so a namespace literally named like a token (e.g. `ns-616c706861`,
// the token of "alpha") served from its legacy raw root would decode to "alpha".
// A dir name that is itself a KNOWN (configured) namespace must take precedence
// over decoding, so routing (contradiction/QMD ownership) uses the literal name.
test("namespaceFromStorageDir preserves a CONFIGURED namespace named like a canonical token (NRCve)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-token-config-"));
  try {
    // Mirrors `namespaceIdentityToken`: ns-<lowercase hex of UTF-8>.
    const tokenize = (name: string) => `ns-${Buffer.from(name, "utf8").toString("hex")}`;
    const literalTokenName = tokenize("alpha"); // "ns-616c706861" — decodes to "alpha"

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: literalTokenName, // configured under this literal token-shaped name
    });
    const orchestrator = new Orchestrator(config) as any;
    assert.equal(
      orchestrator.namespaceFromStorageDir(path.join(memoryDir, "namespaces", literalTokenName)),
      literalTokenName,
      "a configured namespace named like a canonical token must resolve to the literal name, not its decoded identity",
    );

    // Control: the identical byte-shape, but NOT configured, still decodes.
    const otherConfig = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });
    const otherOrch = new Orchestrator(otherConfig) as any;
    assert.equal(
      otherOrch.namespaceFromStorageDir(path.join(memoryDir, "namespaces", tokenize("beta"))),
      "beta",
      "an unconfigured genuine tokenized dir still decodes to its identity",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NDXHa): an already-ABORTED recall must not record catalog
// read touches. The abort check runs later (Phase 1 retrieval), so without the
// gate an already-aborted recall would still set `lastReadAt` for every recall
// namespace even though it exits before any QMD/fallback read.
test("an already-aborted recall records no catalog read touches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-aborted-recall-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });
    const orchestrator = new Orchestrator(config) as any;
    orchestrator.qmd = { isAvailable: () => false };

    // Pre-aborted signal: the recall should bail before any namespace read.
    const controller = new AbortController();
    controller.abort();
    try {
      await orchestrator.recallInternal(
        "What is the team standup schedule and who attends it?",
        "user:test:aborted",
        { abortSignal: controller.signal },
      );
    } catch {
      // An aborted recall may throw; that's fine — we only assert no read touch.
    }

    await new Promise((r) => setTimeout(r, 20));
    await orchestrator.namespaceCatalog.markMaintenance("default", "probe");
    const records = await orchestrator.namespaceCatalog.listNamespaces();
    for (const r of records) {
      assert.ok(
        !r.lastReadAt,
        `an aborted recall must not record a read touch (namespace ${r.namespace} has lastReadAt)`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── codex P2 (NRcCL): touch dynamic namespaces after identity consolidation.
// `autoConsolidateIdentity` fans out over the catalog-union namespace set. When a
// DYNAMIC namespace's ONLY mutation in the consolidation pass is identity
// consolidation (it rewrites IDENTITY and clears reflections via
// `storage.writeIdentity`/`writeIdentityReflections`), nothing recorded a catalog
// write for it: the pass's consolidated touch only covers the DEFAULT
// `this.storage` and only when `memoryItemMutated` was set by other work. So the
// namespace kept a stale `lastWriteAt`, and `listNamespaces({ writtenSince })`
// missed the write. The fix records a per-namespace `markCatalogWrite` right after
// the identity files are updated.
test("autoConsolidateIdentity records a catalog write for a dynamic namespace whose only mutation is consolidation (NRcCL)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-identity-consolidate-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      identityEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const dynamicNs = "project-origin-consolidate-only";
    const orchestrator = new Orchestrator(config) as any;
    assert.equal(orchestrator.namespaceCatalog.enabled, true, "catalog must be enabled");

    // IDENTITY.<ns>.md is written under workspaceDir; it must exist for the
    // consolidation write to land.
    await mkdir(config.workspaceDir, { recursive: true });

    // Seed the dynamic namespace's storage with enough reflections to cross the
    // IDENTITY_CONSOLIDATE_THRESHOLD, so consolidation actually runs for it.
    const dynamicStorage = await orchestrator.getStorage(dynamicNs);
    await dynamicStorage.ensureDirectories();
    const bigReflections =
      "## Reflection\n\n" + "- synthetic reflection line filling the identity file\n".repeat(400);
    assert.ok(bigReflections.length > 8_000, "precondition: reflections exceed the consolidate threshold");
    await dynamicStorage.writeIdentityReflections(bigReflections);

    // Register the dynamic namespace in the catalog WITHOUT a write touch (a read
    // registration), so the catalog-union loop includes it but its lastWriteAt is
    // unset before consolidation — isolating consolidation as the sole mutation.
    await orchestrator.namespaceCatalog.markRead(dynamicNs, { discoveredBy: "read", storageDir: dynamicStorage.dir });
    const before = await orchestrator.namespaceCatalog.getNamespaceRecord(dynamicNs);
    assert.ok(before, "precondition: dynamic namespace is cataloged before consolidation");
    assert.ok(!before?.lastWriteAt, "precondition: lastWriteAt is unset before consolidation");

    // Stub the LLM consolidation so the pass produces patterns deterministically.
    orchestrator.extraction = {
      ...orchestrator.extraction,
      consolidateIdentity: async () => ({
        learnedPatterns: ["synthetic consolidated pattern"],
        summary: "",
      }),
    };

    await orchestrator.autoConsolidateIdentity();

    // markCatalogWrite is fire-and-forget; serialize after it before reading.
    await orchestrator.namespaceCatalog.markRead(dynamicNs);

    const after = await orchestrator.namespaceCatalog.getNamespaceRecord(dynamicNs);
    assert.ok(
      after?.lastWriteAt,
      "identity consolidation must record a catalog write (lastWriteAt) for the dynamic namespace",
    );

    // The consumer the bug cited now surfaces the namespace.
    const since = new Date(Date.parse(after!.lastWriteAt!) - 1000);
    const written = await orchestrator.namespaceCatalog.listNamespaces({ writtenSince: since });
    assert.ok(
      written.some((r: { namespace: string }) => r.namespace === dynamicNs),
      "writtenSince must surface a namespace mutated only by identity consolidation",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
