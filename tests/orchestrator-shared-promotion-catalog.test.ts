import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import { resolveScopeProfilePlan } from "../packages/remnic-core/src/namespaces/scope-profiles.js";

// ── Round 2, Issue B (cursor[bot] Medium): a shared-namespace promotion writes
// to the shared namespace via `sharedStorage.writeMemory`, but round 1 only
// recorded a catalog write for the routed SOURCE namespace. When promotion is
// the only write the shared namespace receives, its catalog `lastWriteAt` stayed
// stale — skewing `writtenSince` filters and maintenance fanout. The orchestrator
// now records a catalog write for the shared namespace after the
// promoted write lands. This test asserts that contract (the exact call the
// promotion path makes) updates the SHARED record without touching the source.
test("shared-namespace promotion updates the shared namespace lastWriteAt in the catalog", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-catalog-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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

    // #1522: the catalog touch is now recorded at the storage chokepoint via
    // storageRouter.recordWrite, which fires catalog.markWrite. Simulate the
    // exact touch the promotion path performs after a successful
    // sharedStorage.writeMemory.
    orchestrator.storageRouter.recordWrite(config.sharedNamespace, sharedStorage.dir);
    await orchestrator.storageRouter.whenWriteTouchesSettled();

    // recordWrite is fire-and-forget; let the serialized append settle.
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
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// Integration guard for Issue B: drive the actual promotion path via
// `persistExtraction` (auto-promote enabled, source namespace != shared) and
// assert the SHARED catalog record gains lastWriteAt as a side effect of the
// promoted write. This fails on the round-1 code (no shared catalog write in
// promoteMemoryToShared) and passes after the fix.
test("persistExtraction shared promotion records a shared-namespace catalog write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-integ-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("scope profile shared reads do not imply automatic shared promotion", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-scope-profile-promo-gate-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
      namespacePolicies: [
        { name: "default", readPrincipals: ["default"], writePrincipals: ["default"] },
        { name: "shared", readPrincipals: ["default"], writePrincipals: ["default"] },
      ],
      defaultScopeProfile: "hosted",
      scopeProfiles: {
        hosted: {
          readOrder: ["userGlobal", "serverShared"],
          writeDefault: "userGlobal",
          promotionTargets: ["serverShared"],
          autoPromote: { enabled: false, targets: ["serverShared"] },
        },
      },
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });

    const orchestrator = new Orchestrator(config) as any;
    orchestrator.qmd = { isAvailable: () => false };

    const sourceStorage = await orchestrator.getStorage("default");
    await sourceStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    const scopeProfileWritePlan = resolveScopeProfilePlan({
      config,
      principal: "default",
      codingContext: null,
      codingOverlay: null,
    });
    assert.ok(scopeProfileWritePlan);

    await orchestrator.persistExtraction(
      {
        facts: [
          {
            content: "Profile-gated promotion should stay private.",
            category: "fact",
            confidence: 0.95,
            tags: ["scope-profile"],
          },
        ],
        entities: [],
        questions: [],
        profileUpdates: [],
      },
      sourceStorage,
      null,
      { sessionKey: "s1", principal: "default" },
      scopeProfileWritePlan.baseNamespace,
      scopeProfileWritePlan,
    );

    await orchestrator.namespaceCatalog.markRead("shared");

    const sharedRecord = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(
      !sharedRecord?.lastWriteAt,
      "shared read/write access must not bypass the active profile autoPromote gate",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("scope profile auto-promotion does not require legacy global promotion", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-scope-profile-promo-enabled-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [
        { name: "default", readPrincipals: ["default"], writePrincipals: ["default"] },
        { name: "shared", readPrincipals: ["default"], writePrincipals: ["default"] },
      ],
      defaultScopeProfile: "hosted",
      scopeProfiles: {
        hosted: {
          readOrder: ["userGlobal", "serverShared"],
          writeDefault: "userGlobal",
          promotionTargets: ["serverShared"],
          autoPromote: {
            enabled: true,
            targets: ["serverShared"],
            categories: ["fact"],
            minConfidenceTier: "implied",
          },
        },
      },
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });
    assert.equal(config.autoPromoteToSharedEnabled, false, "legacy promotion remains disabled");

    const orchestrator = new Orchestrator(config) as any;
    orchestrator.qmd = { isAvailable: () => false };

    const sourceStorage = await orchestrator.getStorage("default");
    await sourceStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    const scopeProfileWritePlan = resolveScopeProfilePlan({
      config,
      principal: "default",
      codingContext: null,
      codingOverlay: null,
    });
    assert.ok(scopeProfileWritePlan);

    await orchestrator.persistExtraction(
      {
        facts: [
          {
            content: "Profile-native promotion should reach shared.",
            category: "fact",
            confidence: 0.95,
            tags: ["scope-profile"],
          },
        ],
        entities: [],
        questions: [],
        profileUpdates: [],
      },
      sourceStorage,
      null,
      { sessionKey: "s1", principal: "default" },
      scopeProfileWritePlan.baseNamespace,
      scopeProfileWritePlan,
    );

    await orchestrator.namespaceCatalog.markRead("shared");

    const sharedRecord = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(
      sharedRecord?.lastWriteAt,
      "active scope profile autoPromote.enabled should promote without the legacy global flag",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("shared promotion records catalog write after shared temporal supersession", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-order-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
    const { id: oldId } = await sharedStorage.writeMemory("fact", "Lives in NYC.", {
      entityRef: entity,
      structuredAttributes: { city: "NYC" },
      source: "seed",
      confidence: 0.9,
      tags: ["shared-promotion"],
      validAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const sharedMutationOrder: string[] = [];
    const originalMarkWrite = orchestrator.namespaceCatalog.markWrite.bind(orchestrator.namespaceCatalog);
    orchestrator.namespaceCatalog.markWrite = (
      ...args: Parameters<typeof originalMarkWrite>
    ) => {
      const [namespace] = args;
      if (namespace === config.sharedNamespace) sharedMutationOrder.push("catalog");
      return originalMarkWrite(...args);
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
    // #1522: with the storage chokepoint, multiple catalog write touches fire
    // during the shared promotion (each storage write fires its own touch).
    // The key invariant: at least one shared catalog touch lands AFTER the
    // supersession frontmatter write, so lastWriteAt covers the mutation.
    const frontmatterIdx = sharedMutationOrder.indexOf("frontmatter");
    const catalogAfterFrontmatter = sharedMutationOrder.indexOf("catalog", frontmatterIdx);
    assert.notEqual(frontmatterIdx, -1, "precondition: shared supersession frontmatter was written");
    assert.notEqual(
      catalogAfterFrontmatter,
      -1,
      `a shared catalog touch must land after the supersession frontmatter write; saw ${sharedMutationOrder.join(" -> ")}`,
    );
    assert.ok(
      Date.parse(sharedRecord!.lastWriteAt!) >= Date.parse(oldMemory!.frontmatter.supersededAt!),
      "shared catalog lastWriteAt must not precede supersession frontmatter mutation",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── Round 8 (codex P2 — NElSf): the shared-promotion HASH-DEDUP branch returns
// early (an active matching shared fact already exists, so no NEW write happens),
// but it first runs `applyTemporalSupersession`, which REWRITES shared-namespace
// frontmatter to retire stale conflicting facts. That return path skips the
// post-write storage chokepoint touch, so a supersession-only update left the shared
// record's `lastWriteAt` stale and `writtenSince` maintenance/QMD fanout could
// skip the namespace. The fix touches the catalog on the dedup return path WHEN
// any ids were actually superseded. This drives the real path: an OLD conflicting
// active shared fact (entity E, {city: NYC}) plus a hash-indexed active shared
// fact (content X, entity E, {city: Austin}); promoting content X (entity E,
// {city: Austin}) hits the hash-dedup branch, supersedes the older NYC fact, and
// must record a shared-namespace catalog write. Fails pre-fix (dedup return skips
// chokepoint touch); passes after.
test("shared hash-dedup supersession-only update records a shared-namespace catalog write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-dedup-catalog-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── Round 7 (codex P2 — NBsFz): `storageDirNamespace` decodes ONLY a genuine
// tokenized dir — one whose decoded identity round-trips back to the exact dir
// name via `namespaceIdentityToken`. A `ns-...`-shaped dir name that does NOT
// round-trip is treated as a literal raw name and returned verbatim, so a
// token-shaped raw namespace name is never silently rewritten into a different
// identity by the catalog write touch. (Regression guard for the round-trip
// containment; the inherent same-bytes ambiguity of a raw name that is ALSO a
// canonical token is resolved at the call site by passing the known namespace.)
test("storageDirNamespace preserves a token-shaped literal raw namespace name", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-from-dir-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
      orchestrator.storageDirNamespace(rawDir),
      literal,
      "a token-shaped but non-canonical raw name must be preserved verbatim, not mangled",
    );

    // Control: a GENUINE tokenized dir still decodes back to its identity.
    const realNs = "team-pi-project-origin-abc123";
    const tokenDir = path.join(memoryDir, "namespaces", tokenize(realNs));
    assert.equal(
      orchestrator.storageDirNamespace(tokenDir),
      realNs,
      "a genuine tokenized dir must still decode to its namespace identity",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── codex P2 (NRCve): the round-trip guard is TAUTOLOGICAL for a canonical token
// string, so a namespace literally named like a token (e.g. `ns-616c706861`,
// the token of "alpha") served from its legacy raw root would decode to "alpha".
// A dir name that is itself a KNOWN (configured) namespace must take precedence
// over decoding, so routing (contradiction/QMD ownership) uses the literal name.
test("storageDirNamespace preserves a CONFIGURED namespace named like a canonical token (NRCve)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-token-config-"));
  try {
    // Mirrors `namespaceIdentityToken`: ns-<lowercase hex of UTF-8>.
    const tokenize = (name: string) => `ns-${Buffer.from(name, "utf8").toString("hex")}`;
    const literalTokenName = tokenize("alpha"); // "ns-616c706861" — decodes to "alpha"

    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
      orchestrator.storageDirNamespace(path.join(memoryDir, "namespaces", literalTokenName)),
      literalTokenName,
      "a configured namespace named like a canonical token must resolve to the literal name, not its decoded identity",
    );

    // Control: the identical byte-shape, but NOT configured, still decodes.
    const otherConfig = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
      otherOrch.storageDirNamespace(path.join(memoryDir, "namespaces", tokenize("beta"))),
      "beta",
      "an unconfigured genuine tokenized dir still decodes to its identity",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("storageDirNamespace preserves a CATALOGED dynamic namespace named like a canonical token", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-token-catalog-"));
  try {
    const tokenize = (name: string) => `ns-${Buffer.from(name, "utf8").toString("hex")}`;
    const literalTokenName = tokenize("alpha");
    const rawDir = path.join(memoryDir, "namespaces", literalTokenName);
    await mkdir(path.join(rawDir, "facts"), { recursive: true });

    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });
    const seedOrchestrator = new Orchestrator(config) as any;
    await seedOrchestrator.namespaceCatalog.markRead(literalTokenName, {
      discoveredBy: "read",
      storageDir: rawDir,
    });

    const freshOrchestrator = new Orchestrator(config) as any;
    assert.equal(
      freshOrchestrator.storageDirNamespace(rawDir),
      literalTokenName,
      "a cataloged dynamic namespace named like a canonical token must resolve to the literal name, not its decoded identity",
    );

    assert.equal(
      freshOrchestrator.storageDirNamespace(path.join(memoryDir, "namespaces", tokenize("beta"))),
      "beta",
      "an uncataloged genuine tokenized dir still decodes to its identity",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("storageDirNamespace ignores catalog hints whose storageDir belongs to another namespace", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-hint-owner-"));
  try {
    const tokenize = (name: string) => `ns-${Buffer.from(name, "utf8").toString("hex")}`;
    const betaRoot = path.join(memoryDir, "namespaces", tokenize("beta"));
    await mkdir(path.join(betaRoot, "facts"), { recursive: true });
    await mkdir(path.join(memoryDir, "state"), { recursive: true });

    const now = new Date().toISOString();
    await writeFile(
      path.join(memoryDir, "state", "namespaces.jsonl"),
      `${JSON.stringify({
        version: 1,
        namespace: "alpha",
        identityToken: tokenize("alpha"),
        kind: "project",
        createdAt: now,
        updatedAt: now,
        storageDir: betaRoot,
        discoveredBy: "write",
      })}\n`,
      "utf8",
    );

    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });
    const freshOrchestrator = new Orchestrator(config) as any;

    assert.equal(
      freshOrchestrator.storageDirNamespace(betaRoot),
      "beta",
      "a catalog row for alpha must not claim beta's tokenized storage root",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("storageDirNamespace compacts catalog hints before choosing token-root owner", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-hint-compact-"));
  try {
    const tokenize = (name: string) => `ns-${Buffer.from(name, "utf8").toString("hex")}`;
    const literalTokenName = tokenize("alpha");
    const alphaRoot = path.join(memoryDir, "namespaces", literalTokenName);
    await mkdir(path.join(alphaRoot, "facts"), { recursive: true });
    await mkdir(path.join(memoryDir, "state"), { recursive: true });

    const now = new Date().toISOString();
    await writeFile(
      path.join(memoryDir, "state", "namespaces.jsonl"),
      `${JSON.stringify({
        version: 1,
        namespace: literalTokenName,
        identityToken: tokenize(literalTokenName),
        kind: "project",
        createdAt: now,
        updatedAt: now,
        storageDir: alphaRoot,
        discoveredBy: "write",
      })}\n${JSON.stringify({
        version: 1,
        namespace: "alpha",
        identityToken: literalTokenName,
        kind: "explicit",
        createdAt: now,
        updatedAt: now,
        storageDir: alphaRoot,
        discoveredBy: "write",
      })}\n`,
      "utf8",
    );

    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [
        {
          name: "alpha",
          readPrincipals: [],
          writePrincipals: [],
        },
      ],
    });
    const freshOrchestrator = new Orchestrator(config) as any;

    assert.equal(
      freshOrchestrator.storageDirNamespace(alphaRoot),
      "alpha",
      "configured namespace alpha must own its tokenized root over a stale literal ns-* alias",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("persistExtraction records non-fact catalog touch when a later non-fact write fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-nonfact-finally-catalog-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });
    const orchestrator = new Orchestrator(config) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const events: string[] = [];
    const originalWriteEntity = storage.writeEntity.bind(storage);
    storage.writeEntity = async (...args: Parameters<typeof storage.writeEntity>) => {
      const id = await originalWriteEntity(...args);
      events.push("entity");
      return id;
    };
    storage.appendToProfile = async () => {
      events.push("profile");
      throw new Error("profile boom");
    };
    const originalMarkWrite = orchestrator.namespaceCatalog.markWrite.bind(orchestrator.namespaceCatalog);
    orchestrator.namespaceCatalog.markWrite = (
      ...args: Parameters<typeof originalMarkWrite>
    ) => {
      events.push("touch");
      return originalMarkWrite(...args);
    };

    await assert.rejects(
      () =>
        orchestrator.persistExtraction(
          {
            facts: [],
            entities: [
              {
                name: "Namespace Catalog",
                type: "system",
                facts: ["tracks durable non-fact writes"],
              },
            ],
            relationships: [],
            questions: [],
            profileUpdates: ["User cares about catalog recency."],
          },
          storage,
          null,
        ),
      /profile boom/,
    );
    // Let fire-and-forget catalog touches settle before cleanup.
    await orchestrator.storageRouter.whenWriteTouchesSettled();

    const entityIndex = events.indexOf("entity");
    const touchIndex = events.indexOf("touch");
    assert.notEqual(entityIndex, -1, "precondition: entity write succeeded");
    // #1522: the catalog touch fires at the storage chokepoint during the
    // entity write, before the profile append runs — so it is already recorded
    // when the profile error escapes.
    assert.notEqual(touchIndex, -1, "catalog touch must fire before the later write error escapes");
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
// missed the write. The fix records a per-namespace catalog write right after
// the identity files are updated.
test("autoConsolidateIdentity records a catalog write for a dynamic namespace whose only mutation is consolidation (NRcCL)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-identity-consolidate-catalog-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
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

    // Register the dynamic namespace in the catalog. The reflections write above
    // already fired the storage chokepoint (#1522), so lastWriteAt may be set —
    // record the before value and verify consolidation ADVANCES it.
    await orchestrator.namespaceCatalog.markRead(dynamicNs, { discoveredBy: "read", storageDir: dynamicStorage.dir });
    await orchestrator.storageRouter.whenWriteTouchesSettled();
    const before = await orchestrator.namespaceCatalog.getNamespaceRecord(dynamicNs);
    assert.ok(before, "precondition: dynamic namespace is cataloged before consolidation");
    const beforeWriteAt = before?.lastWriteAt;

    // Stub the LLM consolidation so the pass produces patterns deterministically.
    orchestrator.extraction = {
      ...orchestrator.extraction,
      consolidateIdentity: async () => ({
        learnedPatterns: ["synthetic consolidated pattern"],
        summary: "",
      }),
    };

    await orchestrator.autoConsolidateIdentity();

    // recordWrite is fire-and-forget; serialize after it before reading.
    await orchestrator.namespaceCatalog.markRead(dynamicNs);

    const after = await orchestrator.namespaceCatalog.getNamespaceRecord(dynamicNs);
    assert.ok(
      after?.lastWriteAt,
      "identity consolidation must record a catalog write (lastWriteAt) for the dynamic namespace",
    );
    if (beforeWriteAt) {
      assert.ok(
        Date.parse(after!.lastWriteAt!) > Date.parse(beforeWriteAt),
        "identity consolidation must advance lastWriteAt past the pre-consolidation value",
      );
    }

    // The consumer the bug cited now surfaces the namespace.
    const since = new Date(Date.parse(after!.lastWriteAt!) - 1000);
    const written = await orchestrator.namespaceCatalog.listNamespaces({ writtenSince: since });
    assert.ok(
      written.some((r: { namespace: string }) => r.namespace === dynamicNs),
      "writtenSince must surface a namespace mutated only by identity consolidation",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── codex P2 (NY-dK): semantic consolidation writes the canonical memory before
// archiving the source cluster. If archival throws, the cluster catch swallows the
// failure and continues, but the canonical write is already durable. The catalog
// touch must still run so writtenSince/QMD maintenance sees the namespace.
test("semantic consolidation records a catalog write when archival fails after canonical write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-semantic-partial-catalog-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      semanticConsolidationEnabled: true,
      semanticConsolidationModel: "fast",
      semanticConsolidationThreshold: 0,
      semanticConsolidationMinClusterSize: 2,
      semanticConsolidationMaxPerRun: 10,
      semanticConsolidationExcludeCategories: [],
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });

    const dynamicNs = "project-origin-semantic-partial";
    const orchestrator = new Orchestrator(config) as any;
    const dynamicStorage = await orchestrator.getStorage(dynamicNs);
    await dynamicStorage.ensureDirectories();

    for (let i = 0; i < 10; i++) {
      await dynamicStorage.writeMemory(
        "fact",
        `Partial consolidation source ${i} repeats the same stable project namespace catalog detail.`,
        {
          source: "test",
          confidence: 0.9,
          tags: ["semantic-partial"],
          created: new Date(Date.now() - i * 1000).toISOString(),
        },
      );
    }

    await orchestrator.namespaceCatalog.markRead(dynamicNs, {
      discoveredBy: "read",
      storageDir: dynamicStorage.dir,
    });
    // #1522: the writeMemory calls above fired the storage chokepoint, so
    // lastWriteAt may already be set. Record the before value and verify the
    // canonical write advances it.
    await orchestrator.storageRouter.whenWriteTouchesSettled();
    const before = await orchestrator.namespaceCatalog.getNamespaceRecord(dynamicNs);
    assert.ok(before, "precondition: dynamic namespace is cataloged before consolidation");
    const beforeWriteAt = before?.lastWriteAt;

    orchestrator.fastLlm = {
      async chatCompletion() {
        return { content: "Canonical partial consolidation memory." };
      },
    };

    let archiveCalls = 0;
    dynamicStorage.archiveMemory = async () => {
      archiveCalls++;
      throw new Error("synthetic archive failure after canonical write");
    };

    const result = await orchestrator.runSemanticConsolidation({
      force: true,
      storage: dynamicStorage,
      thresholdOverride: 0,
    });

    assert.equal(result.memoriesConsolidated, 1, "precondition: canonical write completed");
    assert.equal(result.errors, 1, "precondition: archival failure was swallowed as a cluster error");
    assert.equal(archiveCalls, 1, "precondition: archival was attempted after the canonical write");

    await orchestrator.namespaceCatalog.markRead(dynamicNs);

    const after = await orchestrator.namespaceCatalog.getNamespaceRecord(dynamicNs);
    assert.ok(
      after?.lastWriteAt,
      "partial semantic consolidation must record a catalog write for the durable canonical memory",
    );
    if (beforeWriteAt) {
      assert.ok(
        Date.parse(after!.lastWriteAt!) > Date.parse(beforeWriteAt),
        "canonical write must advance lastWriteAt past the pre-consolidation value",
      );
    }

    const since = new Date(Date.parse(after!.lastWriteAt!) - 1000);
    const written = await orchestrator.namespaceCatalog.listNamespaces({ writtenSince: since });
    assert.ok(
      written.some((r: { namespace: string }) => r.namespace === dynamicNs),
      "writtenSince must surface the namespace after a partial semantic consolidation write",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── codex P2 (NZYYR): the non-chunked extraction path writes graph edges and
// optional verbatim artifacts after the primary memory write. The source
// namespace catalog touch must run after those later mutations, not between the
// primary memory and the derived writes.
test("persistExtraction records non-chunked source catalog touch after graph and artifact writes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-nonchunk-touch-order-"));
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: true,
      verbatimArtifactsEnabled: true,
      verbatimArtifactCategories: ["fact"],
      verbatimArtifactsMinConfidence: 0,
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });

    const orchestrator = new Orchestrator(config) as any;
    cleanup = () => orchestrator.destroy();
    const ns = "project-origin-nonchunk-order";
    const storage = await orchestrator.getStorage(ns);
    await storage.ensureDirectories();

    const events: string[] = [];
    orchestrator.buildGraphEdge = async () => {
      events.push("graph");
    };
    const originalWriteArtifact = storage.writeArtifact.bind(storage);
    storage.writeArtifact = async (...args: Parameters<typeof storage.writeArtifact>) => {
      const id = await originalWriteArtifact(...args);
      events.push("artifact");
      return id;
    };
    const originalMarkWrite = orchestrator.namespaceCatalog.markWrite.bind(orchestrator.namespaceCatalog);
    orchestrator.namespaceCatalog.markWrite = (
      ...args: Parameters<typeof originalMarkWrite>
    ) => {
      events.push("touch");
      return originalMarkWrite(...args);
    };

    await orchestrator.persistExtraction(
      {
        facts: [
          {
            content: "The non-chunked catalog ordering fact is short.",
            category: "fact",
            confidence: 0.95,
            tags: ["catalog-order"],
          },
        ],
        entities: [],
        relationships: [],
        questions: [],
        profileUpdates: [],
      },
      storage,
      null,
      undefined,
      ns,
    );

    const graphIndex = events.indexOf("graph");
    const artifactIndex = events.indexOf("artifact");
    const touchCount = events.filter((e) => e === "touch").length;
    assert.notEqual(graphIndex, -1, "precondition: graph edge write was attempted");
    assert.notEqual(artifactIndex, -1, "precondition: artifact write completed");
    // #1522: the catalog touch now fires at the storage chokepoint during each
    // durable storage write (memory + artifact), recording the namespace write
    // automatically via the StorageManager's onCatalogWrite hook.
    assert.ok(
      touchCount > 0,
      `catalog write touch must fire via the storage chokepoint during non-chunked extraction; saw ${events.join(" -> ")}`,
    );
  } finally {
    await cleanup?.().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── codex P2 (NZYYT): a dynamic namespace created only by a read touch has no
// durable memory data. Maintenance must not create or keep QMD collections for
// those absent catalog-only rows, while still including real data roots that lack
// a historical write touch.
test("maintenanceNamespaces skips absent catalog-only read rows but includes existing data roots", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-maintenance-catalog-read-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const orchestrator = new Orchestrator(config) as any;
    const ns = "project-origin-empty-read";
    await orchestrator.namespaceCatalog.markRead(ns, { discoveredBy: "read" });

    const before = await orchestrator.maintenanceNamespaces();
    assert.ok(
      !before.includes(ns),
      "catalog-only read rows without storage data must not enter maintenance fanout",
    );

    const storage = await orchestrator.getStorage(ns);
    await storage.ensureDirectories();
    await storage.writeMemory("fact", "A real dynamic namespace memory exists.", {
      source: "test",
      confidence: 0.9,
      tags: ["maintenance"],
    });
    await orchestrator.namespaceCatalog.markRead(ns, {
      discoveredBy: "read",
      storageDir: storage.dir,
    });

    // #1522: writeMemory fires the storage chokepoint, so the catalog row now
    // carries lastWriteAt. The test still verifies the key invariant: a
    // namespace with an existing data root enters maintenance fanout.
    const record = await orchestrator.namespaceCatalog.getNamespaceRecord(ns);
    assert.ok(record, "precondition: namespace remains cataloged");

    const after = await orchestrator.maintenanceNamespaces();
    assert.ok(
      after.includes(ns),
      "read-only catalog rows with an existing data root must still enter maintenance fanout",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── codex P2 (Na71-): `lastWriteAt` proves a namespace was written sometime in
// the past, not that its storage root is still live. If a dynamic tokenized root
// is deleted before maintenance runs, the catalog row must not keep feeding that
// stale namespace into QMD maintenance.
test("maintenanceNamespaces skips catalog write rows whose storage root was deleted", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-maintenance-deleted-write-"));
  try {
    const config = parseConfig({
    namespacesCatalogWriteTouchCoalesceMs: 0,
    namespacesCatalogReadTouchCoalesceMs: 0,
    namespacesCatalogTouchStateWrites: true,
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const orchestrator = new Orchestrator(config) as any;
    const ns = "project-origin-deleted-write";
    const storage = await orchestrator.getStorage(ns);
    await storage.ensureDirectories();
    await storage.writeMemory("fact", "This dynamic namespace root will be deleted.", {
      source: "test",
      confidence: 0.9,
      tags: ["maintenance"],
    });
    await orchestrator.namespaceCatalog.markWrite(ns, {
      discoveredBy: "write",
      storageDir: storage.dir,
    });

    const before = await orchestrator.maintenanceNamespaces();
    assert.ok(before.includes(ns), "precondition: live write root enters maintenance fanout");

    await rm(storage.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const record = await orchestrator.namespaceCatalog.getNamespaceRecord(ns);
    assert.ok(record?.lastWriteAt, "precondition: stale catalog row still carries lastWriteAt");

    const after = await orchestrator.maintenanceNamespaces();
    assert.ok(
      !after.includes(ns),
      "a deleted dynamic write root must not enter maintenance fanout just because lastWriteAt is set",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
