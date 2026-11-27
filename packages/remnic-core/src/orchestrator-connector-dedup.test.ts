
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { clearMemoryCache } from "./memory-cache.js";
import { ContentHashIndex, StorageManager } from "./storage.js";
import type { ExtractionResult, ExtractedFact, MemoryFile, MemoryCategory } from "./types.js";
import type { ResolvedScopeProfilePlan } from "./namespaces/scope-profiles.js";
import { buildProcedurePersistBody } from "./procedural/procedure-types.js";
import type { PersistExtractionFn } from "./testing/orchestrator-lite.js";

// persistExtraction is private; cast through unknown to reach it without `any`.

interface OrchestratorTestSurface {
  persistExtraction: PersistExtractionFn;
  getStorage: (namespace: string) => Promise<StorageManager>;
  contentHashIndex: ContentHashIndex | null;
  addContentHashDedup: (targetStorage: StorageManager, content: string) => Promise<void>;
  hasContentHashDedup: (targetStorage: StorageManager, content: string) => Promise<boolean>;
  removeContentHashForMemory: (
    targetStorage: StorageManager,
    memory: MemoryFile,
    context: string,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function makeFact(content: string): ExtractedFact {
  return {
    content,
    category: "fact",
    tags: [],
    confidence: 0.9,
  };
}

function factResult(content: string): ExtractionResult {
  return {
    facts: [makeFact(content)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };
}

async function makeDedupOrchestrator(
  overrides: Record<string, unknown> = {},
): Promise<{
  orchestrator: OrchestratorTestSurface;
  storage: StorageManager;
  memoryDir: string;
  hashIndex: ContentHashIndex;
}> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-connector-dedup-"),
  );
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
    factDeduplicationEnabled: true,
    ...overrides,
  });
  const orchestrator = new Orchestrator(
    config,
  ) as unknown as OrchestratorTestSurface;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();

  const stateDir = path.join(memoryDir, "state");
  await mkdir(stateDir, { recursive: true });
  const hashIndex = new ContentHashIndex(stateDir);
  await hashIndex.load();
  orchestrator.contentHashIndex = hashIndex;

  return { orchestrator, storage, memoryDir, hashIndex };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("connector dedup (QOjlB): same content + same connector dedupes", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator();
  const body =
    "The deployment pipeline runs canary checks every fifteen minutes before promoting to production.";

  const { persistedIds: ids1 } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first write must succeed");

  const { persistedIds: ids2 } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids2.length, 0, "same-connector duplicate must be deduped");

  const all = await storage.readAllMemories();
  const matching = all.filter((m: MemoryFile) => m.content.includes(body));
  assert.equal(matching.length, 1, "only one memory on disk");
});

test("connector dedup (QOjlB): same content + different connector does NOT dedupe", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator();
  const body =
    "The staging environment uses isolated feature flags per tenant for safer rollouts.";

  const { persistedIds: ids1 } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first write must succeed");

  const { persistedIds: ids2 } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "codex-cli" },
  );
  assert.equal(ids2.length, 1, "cross-connector fact must NOT be deduped");

  const all = await storage.readAllMemories();
  const chatgptMems = all.filter(
    (m: MemoryFile) => m.frontmatter.sourceConnector === "chatgpt",
  );
  const codexMems = all.filter(
    (m: MemoryFile) => m.frontmatter.sourceConnector === "codex-cli",
  );
  assert.equal(chatgptMems.length, 1, "one chatgpt memory on disk");
  assert.equal(codexMems.length, 1, "one codex-cli memory on disk");
});

test("connector dedup (QOjlB): stale hash with no matching memory writes through", async () => {
  const { orchestrator, storage, hashIndex } = await makeDedupOrchestrator();
  const body =
    "The QMD index rebuilds incrementally after each extraction batch completes.";

  hashIndex.add(body);

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids.length, 1, "stale hash with no memory must write through");

  const all = await storage.readAllMemories();
  const matching = all.filter((m: MemoryFile) => m.content.includes(body));
  assert.equal(matching.length, 1, "fact must be persisted on disk");
});

test("connector dedup (QOjlB): readAllMemories throws → writes through (fail open)", async () => {
  const { orchestrator, storage, hashIndex } = await makeDedupOrchestrator();
  const body =
    "The redaction engine compiles regex patterns defensively to avoid ReDoS.";

  hashIndex.add(body);

  // Override readAllMemories to simulate a scan failure. With the test
  // config (no embedding fallback, no graph, no namespaces) the dedup
  // scan at extraction-persist.ts:1592 is the ONLY readAllMemories call
  // during persistExtraction, so this override targets it precisely.
  const originalReadAllMemories = storage.readAllMemories.bind(storage);
  storage.readAllMemories = async (): Promise<MemoryFile[]> => {
    throw new Error("simulated readAllMemories failure");
  };

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids.length, 1, "scan failure must fail open to write");

  storage.readAllMemories = originalReadAllMemories;
  const all = await storage.readAllMemories();
  const matching = all.filter((m: MemoryFile) => m.content.includes(body));
  assert.equal(matching.length, 1, "fact must be persisted despite scan failure");
});

// ---------------------------------------------------------------------------
//
//
// ---------------------------------------------------------------------------

const PROMOTION_TARGET_NS = "user-promotarget";

function makePromotionScopePlan(): ResolvedScopeProfilePlan {
  return {
    profileId: "test-promotion",
    profile: {
      readOrder: ["userProject", "userGlobal"],
      writeDefault: "userProject",
      promotionTargets: ["userGlobal"],
      autoPromote: {
        enabled: true,
        targets: ["userGlobal"],
        categories: ["fact"],
        minConfidenceTier: "speculative",
      },
    },
    baseNamespace: "default",
    writeLayer: "userProject",
    writeNamespace: "default",
    readNamespaces: ["default", PROMOTION_TARGET_NS],
    layers: [
      {
        id: "userProject",
        kind: "user-project",
        namespace: "default",
        readable: true,
        writable: true,
        promotable: false,
        reason: "test",
      },
      {
        id: "userGlobal",
        kind: "user-global",
        namespace: PROMOTION_TARGET_NS,
        readable: true,
        writable: true,
        promotable: true,
        reason: "test",
      },
    ],
    promotionTargets: [
      {
        target: "userGlobal",
        namespace: PROMOTION_TARGET_NS,
        authorized: true,
        reason: "test",
      },
    ],
    warnings: [],
  };
}

async function makePromotionOrchestrator(): Promise<{
  orchestrator: OrchestratorTestSurface;
  storage: StorageManager;
  targetStorage: StorageManager;
}> {
  const dedup = await makeDedupOrchestrator({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
  });
  const targetStorage = await dedup.orchestrator.getStorage(PROMOTION_TARGET_NS);
  await targetStorage.ensureDirectories();
  return {
    orchestrator: dedup.orchestrator,
    storage: dedup.storage,
    targetStorage,
  };
}

test("promotion dedup (QOjlD): same content + same connector skips promotion", async () => {
  const { orchestrator, storage, targetStorage } = await makePromotionOrchestrator();
  const scopePlan = makePromotionScopePlan();
  const body = "The Galileo service rotates TLS certificates every ninety days.";

  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  const targetMems = await targetStorage.readAllMemories();
  assert.equal(
    targetMems.length,
    1,
    "promotion must be skipped for same-connector duplicate",
  );
});

test("promotion dedup (QOjlD): same content + different connector promotes", async () => {
  const { orchestrator, storage, targetStorage } = await makePromotionOrchestrator();
  const scopePlan = makePromotionScopePlan();
  const body = "The staging cluster uses dedicated namespaces per service tier.";

  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "codex-cli" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  const targetMems = await targetStorage.readAllMemories();
  assert.equal(
    targetMems.length,
    2,
    "promotion must proceed for different-connector content",
  );
  const connectors = targetMems.map(
    (m: MemoryFile) => m.frontmatter.sourceConnector ?? undefined,
  );
  assert.ok(
    connectors.includes("chatgpt"),
    "pre-written chatgpt copy must remain",
  );
  assert.ok(
    connectors.includes("codex-cli"),
    "promoted codex-cli copy must exist",
  );
});

test("promotion dedup (QOjlD): connector vs operator promotes", async () => {
  const { orchestrator, storage, targetStorage } = await makePromotionOrchestrator();
  const scopePlan = makePromotionScopePlan();
  const body = "The observability stack ingests traces at one-second granularity.";

  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    undefined,
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  const targetMems = await targetStorage.readAllMemories();
  assert.equal(
    targetMems.length,
    2,
    "promotion must proceed when only one side has a connector",
  );
});

test("promotion dedup (QOjlD): operator vs operator skips promotion", async () => {
  const { orchestrator, storage, targetStorage } = await makePromotionOrchestrator();
  const scopePlan = makePromotionScopePlan();
  const body = "The incident channel escalates pages within five minutes of detection.";

  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
  });

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    undefined,
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  const targetMems = await targetStorage.readAllMemories();
  assert.equal(
    targetMems.length,
    1,
    "promotion must be skipped for operator-vs-operator duplicate",
  );
});

test("promotion dedup (QOjlD): readAllMemories throws on target → promotion proceeds (fail open)", async () => {
  const { orchestrator, storage, targetStorage } = await makePromotionOrchestrator();
  const scopePlan = makePromotionScopePlan();
  const body = "The rate limiter resets token buckets every two hundred milliseconds.";

  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  await targetStorage.isFactContentHashAuthoritative();

  assert.ok(
    await targetStorage.hasFactContentHash(body),
    "pre-write must register the content hash in the target index",
  );

  const originalReadAllMemories = targetStorage.readAllMemories.bind(targetStorage);
  targetStorage.readAllMemories = async (): Promise<MemoryFile[]> => {
    throw new Error("simulated target readAllMemories failure");
  };

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  targetStorage.readAllMemories = originalReadAllMemories;
  const targetMems = await targetStorage.readAllMemories();
  assert.equal(
    targetMems.length,
    2,
    "promotion must proceed (fail open) when target scan throws",
  );
});

test("promotion dedup (QOjlD): cited fact canonicalized before connector-aware dedup", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator({
    inlineSourceAttributionEnabled: true,
  });
  const rawBody =
    "The deployment manifest pins container digests for reproducible builds.";

  const { persistedIds: firstIds } = await orchestrator.persistExtraction(
    factResult(rawBody),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(firstIds.length, 1, "first write must succeed");

  const memories = await storage.readAllMemories();
  const firstMemory = memories.find(
    (m: MemoryFile) => m.frontmatter.id === firstIds[0],
  );
  assert.ok(firstMemory, "first memory must be readable");
  assert.notEqual(
    firstMemory.content,
    rawBody,
    "content must have a citation appended",
  );

  const { persistedIds: secondIds } = await orchestrator.persistExtraction(
    factResult(firstMemory.content),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(
    secondIds.length,
    0,
    "cited duplicate must be deduped after canonicalization",
  );

  const all = await storage.readAllMemories();
  assert.equal(all.length, 1, "only one memory on disk");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function makeProcedureFact(
  title: string,
  steps: Array<{ intent: string; expectedOutcome?: string }>,
): ExtractedFact {
  return {
    content: title,
    category: "procedure",
    tags: [],
    confidence: 0.9,
    procedureSteps: steps.map((s, i) => ({
      order: i + 1,
      intent: s.intent,
      expectedOutcome: s.expectedOutcome,
    })),
  };
}

function procedureResult(
  title: string,
  steps: Array<{ intent: string; expectedOutcome?: string }>,
): ExtractionResult {
  return {
    facts: [makeProcedureFact(title, steps)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };
}

test("connector dedup (QPDE5): same-connector procedure with steps dedupes", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator();
  const title = "Workflow to deploy the canary service to staging";
  const steps = [
    { intent: "Build the container image", expectedOutcome: "Image tagged and pushed" },
    { intent: "Update the Helm chart values", expectedOutcome: "Values file committed" },
  ];

  const { persistedIds: ids1 } = await orchestrator.persistExtraction(
    procedureResult(title, steps),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first procedure write must succeed");

  const { persistedIds: ids2 } = await orchestrator.persistExtraction(
    procedureResult(title, steps),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids2.length, 0, "same-connector procedure must be deduped");

  const all = await storage.readAllMemories();
  const procs = all.filter((m: MemoryFile) => m.frontmatter.category === "procedure");
  assert.equal(procs.length, 1, "only one procedure memory on disk");
});

test("connector dedup (QPDE5): same procedure + different connector does NOT dedupe", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator();
  const title = "Recipe for rotating database credentials securely";
  const steps = [
    { intent: "Generate new credentials in vault" },
    { intent: "Update application configuration" },
    { intent: "Verify connectivity with new credentials" },
  ];

  const { persistedIds: ids1 } = await orchestrator.persistExtraction(
    procedureResult(title, steps),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first procedure write must succeed");

  const { persistedIds: ids2 } = await orchestrator.persistExtraction(
    procedureResult(title, steps),
    storage,
    null,
    { sourceConnector: "codex-cli" },
  );
  assert.equal(ids2.length, 1, "cross-connector procedure must NOT be deduped");

  const all = await storage.readAllMemories();
  const procs = all.filter((m: MemoryFile) => m.frontmatter.category === "procedure");
  assert.equal(procs.length, 2, "two procedure memories on disk");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function makeEnrichedFact(
  content: string,
  attrs: Record<string, string>,
): ExtractedFact {
  return {
    content,
    category: "fact",
    tags: [],
    confidence: 0.9,
    structuredAttributes: attrs,
    entityRef: "test-entity",
  };
}

function enrichedResult(
  content: string,
  attrs: Record<string, string>,
): ExtractionResult {
  return {
    facts: [makeEnrichedFact(content, attrs)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };
}

test("connector dedup (QO42V): same-connector fact with structuredAttributes dedupes", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator();
  const body = "The primary database runs on PostgreSQL version sixteen.";
  const attrs = { dbEngine: "postgresql", version: "16" };

  // First write with connector "chatgpt" — must succeed.
  const { persistedIds: ids1 } = await orchestrator.persistExtraction(
    enrichedResult(body, attrs),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first enriched fact write must succeed");

  const { persistedIds: ids2 } = await orchestrator.persistExtraction(
    enrichedResult(body, attrs),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids2.length, 0, "same-connector enriched fact must be deduped");

  const all = await storage.readAllMemories();
  const facts = all.filter(
    (m: MemoryFile) => m.frontmatter.category === "fact" && m.frontmatter.status !== "superseded",
  );
  assert.equal(facts.length, 1, "only one active fact memory on disk");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function makeSharedPromotionScopePlan(): ResolvedScopeProfilePlan {
  return {
    profileId: "test-shared-promotion",
    profile: {
      readOrder: ["userProject", "serverShared"],
      writeDefault: "userProject",
      promotionTargets: ["serverShared"],
      autoPromote: {
        enabled: true,
        targets: ["serverShared"],
        categories: ["fact"],
        minConfidenceTier: "speculative",
      },
    },
    baseNamespace: "default",
    writeLayer: "userProject",
    writeNamespace: "default",
    readNamespaces: ["default", "shared"],
    layers: [
      {
        id: "userProject",
        kind: "user-project",
        namespace: "default",
        readable: true,
        writable: true,
        promotable: false,
        reason: "test",
      },
      {
        id: "serverShared",
        kind: "server-shared",
        namespace: "shared",
        readable: true,
        writable: true,
        promotable: true,
        reason: "test",
      },
    ],
    promotionTargets: [
      {
        target: "serverShared",
        namespace: "shared",
        authorized: true,
        reason: "test",
      },
    ],
    warnings: [],
  };
}

test("shared promotion (QPAn-): different-connector fact promotes when supersession is off", async () => {
  const { orchestrator, storage } = await makePromotionOrchestrator();
  const scopePlan = makeSharedPromotionScopePlan();
  const body =
    "The backup scheduler retains snapshots for thirty days before pruning.";

  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "codex-cli" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  const sharedMems = await sharedStorage.readAllMemories();
  const connectors = sharedMems.map(
    (m: MemoryFile) => m.frontmatter.sourceConnector ?? undefined,
  );
  assert.ok(
    connectors.includes("chatgpt"),
    "pre-written chatgpt shared copy must remain",
  );
  assert.ok(
    connectors.includes("codex-cli"),
    "promoted codex-cli shared copy must exist",
  );
});

test("shared promotion (QPAn-): same-connector fact skips promotion when supersession is off", async () => {
  const { orchestrator, storage } = await makePromotionOrchestrator();
  const scopePlan = makeSharedPromotionScopePlan();
  const body =
    "The log aggregator compacts segments every six hours to reclaim disk space.";

  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  const sharedMems = await sharedStorage.readAllMemories();
  assert.equal(
    sharedMems.length,
    1,
    "same-connector shared promotion must be skipped",
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("shared backfill: different-connector shared fact is NOT temporal-patched", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    temporalBiTemporal: true,
  });
  const scopePlan = makeSharedPromotionScopePlan();
  const body =
    "The CDN edge cache invalidates stale assets every forty-five minutes.";

  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  const sharedBefore = await sharedStorage.readAllMemories();
  const preFact = sharedBefore.find((m: MemoryFile) => m.frontmatter.sourceConnector === "chatgpt");
  assert.ok(preFact, "pre-written chatgpt fact exists");
  assert.equal(preFact!.frontmatter.invalid_at, undefined, "no invalid_at before extraction");

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    {
      facts: [{
        content: body,
        category: "fact" as const,
        tags: [],
        confidence: 0.9,
        eventTime: "until 2025-06",
      }],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    },
    storage,
    null,
    { sourceConnector: "codex-cli", validAt: "2025-07-01T00:00:00.000Z" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  const sharedAfter = await sharedStorage.readAllMemories();
  const chatgptFact = sharedAfter.find(
    (m: MemoryFile) => m.frontmatter.sourceConnector === "chatgpt",
  );
  assert.ok(chatgptFact, "chatgpt shared fact still exists");
  assert.equal(
    chatgptFact!.frontmatter.invalid_at,
    undefined,
    "chatgpt fact must NOT get invalid_at from codex-li backfill",
  );

  const codexFact = sharedAfter.find(
    (m: MemoryFile) => m.frontmatter.sourceConnector === "codex-cli",
  );
  assert.ok(codexFact, "codex-li shared copy was promoted");
  assert.ok(
    codexFact!.frontmatter.invalid_at,
    "codex-li shared copy has temporal bounds from its own extraction",
  );
});

test("shared backfill: same-connector shared fact IS temporal-patched", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    temporalBiTemporal: true,
  });
  const scopePlan = makeSharedPromotionScopePlan();
  const body =
    "The feature flag service polls configuration updates every ninety seconds.";

  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  await orchestrator.persistExtraction(
    {
      facts: [{
        content: body,
        category: "fact" as const,
        tags: [],
        confidence: 0.9,
        eventTime: "until 2025-03",
      }],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    },
    storage,
    null,
    { sourceConnector: "chatgpt", validAt: "2025-07-01T00:00:00.000Z" },
    "default",
    scopePlan,
  );

  const sharedAfter = await sharedStorage.readAllMemories();
  const chatgptFact = sharedAfter.find(
    (m: MemoryFile) => m.frontmatter.sourceConnector === "chatgpt",
  );
  assert.ok(chatgptFact, "chatgpt shared fact exists");
  assert.ok(
    chatgptFact!.frontmatter.invalid_at,
    "same-connector shared fact must get invalid_at backfilled",
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("shared backfill: operator (no-connector) extraction must NOT patch a connector-tagged duplicate", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    temporalBiTemporal: true,
  });
  const scopePlan = makeSharedPromotionScopePlan();
  const body =
    "The rate limiter resets its token bucket every two hundred milliseconds.";

  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    // No sourceConnector — connectorless, the only kind eligible for
    // operator/no-connector backfill.
  });

  const sharedBefore = await sharedStorage.readAllMemories();
  const taggedBefore = sharedBefore.find(
    (m: MemoryFile) => m.frontmatter.sourceConnector === "chatgpt",
  );
  assert.ok(taggedBefore, "pre-written chatgpt fact exists");
  assert.equal(taggedBefore!.frontmatter.invalid_at, undefined);

  const { persistedIds: ids } = await orchestrator.persistExtraction(
    {
      facts: [{
        content: body,
        category: "fact" as const,
        tags: [],
        confidence: 0.9,
        eventTime: "until 2025-06",
      }],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    },
    storage,
    null,
    { validAt: "2025-07-01T00:00:00.000Z" },
    "default",
    scopePlan,
  );
  assert.ok(ids.length >= 1, "extraction must proceed");

  const sharedAfter = await sharedStorage.readAllMemories();
  const taggedAfter = sharedAfter.find(
    (m: MemoryFile) => m.frontmatter.sourceConnector === "chatgpt",
  );
  assert.ok(taggedAfter, "chatgpt fact still exists");
  assert.equal(
    taggedAfter!.frontmatter.invalid_at,
    undefined,
    "tagged fact must NOT get invalid_at from connectorless/operator backfill",
  );
});
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("#1909: with factDeduplicationEnabled=false, extraction writes flush the fact-hash index immediately", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-defer-dedup-off-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
    factDeduplicationEnabled: false,
  });
  const orchestrator = new Orchestrator(config) as unknown as OrchestratorTestSurface;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();
  assert.equal(await storage.hasFactContentHash("warm"), false);

  const body = "The billing service retries failed charges with exponential backoff.";
  const { persistedIds: ids } = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(ids.length, 1, "the fact is written");

  const restarted = new StorageManager(memoryDir);
  assert.equal(
    await restarted.hasFactContentHash(body),
    true,
    "the fact hash was flushed immediately despite the batch saver being a no-op",
  );
});
test("#2016 SD-nH: fact dedup disabled never suppresses a write via the authority/corpus-confirm path", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-dedup-off-nosuppress-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: false,
    });
    const orchestrator = new Orchestrator(config) as unknown as OrchestratorTestSurface;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const body = "The billing service retries failed charges with exponential backoff.";
    const source = { sourceConnector: "slack" };

    const first = await orchestrator.persistExtraction(factResult(body), storage, null, source);
    assert.equal(first.persistedIds.length, 1, "first write lands");

    // isFactContentHashAuthoritative is a real method on StorageManager; the
    // cast only reaches it as an overridable slot for this test.
    const authorityStub = storage as unknown as {
      isFactContentHashAuthoritative: () => Promise<boolean>;
    };
    authorityStub.isFactContentHashAuthoritative = async () => false;
    clearMemoryCache();

    const second = await orchestrator.persistExtraction(factResult(body), storage, null, source);
    assert.equal(
      second.persistedIds.length,
      1,
      "dedup disabled must not suppress the write via the authority/corpus-confirm path",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("#1909 round 11: deferred persist writes no ready marker and a restart rebuild still dedups", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-defer-window-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
    factDeduplicationEnabled: true,
  });
  const orchestrator = new Orchestrator(config) as unknown as OrchestratorTestSurface;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();
  const readyPath = path.join(memoryDir, "state", "fact-hashes.ready");

  const body = "The scheduler batches webhook deliveries into 250ms windows.";
  const { persistedIds: ids } = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(ids.length, 1, "the fact is written");
  assert.equal(existsSync(readyPath), false, "no ready marker is ever written (round 11)");

  const restarted = new StorageManager(memoryDir);
  assert.equal(await restarted.hasFactContentHash(body), true);
  assert.equal(existsSync(readyPath), false, "still no marker after the restart rebuild");
});
test("#1909: a deferred fact stays durable when addContentHashDedup throws", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-defer-regfail-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
    factDeduplicationEnabled: true,
  });
  const orchestrator = new Orchestrator(config) as unknown as OrchestratorTestSurface;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();
  assert.equal(await storage.hasFactContentHash("warm"), false); // warm + create marker

  orchestrator.addContentHashDedup = async () => {
    throw new Error("simulated registration failure");
  };

  const body = "The queue drains oldest-first under sustained backpressure.";
  const { persistedIds: ids } = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(ids.length, 1, "the fact is written despite the registration failure");

  const restarted = new StorageManager(memoryDir);
  assert.equal(
    await restarted.hasFactContentHash(body),
    true,
    "the deferred hash reached disk independent of addContentHashDedup",
  );
});

test("#1909: two interleaved persist runs both land on disk (merge, no clobber)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-defer-interleave-"));
  const makeConfig = () =>
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
    });
  const orchA = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const orchB = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storageA = await orchA.getStorage("default");
  const storageB = await orchB.getStorage("default");
  await storageA.ensureDirectories();

  await orchA.hasContentHashDedup(storageA, "noop-a");
  await orchB.hasContentHashDedup(storageB, "noop-b");

  await orchA.persistExtraction(factResult("alpha interleaved fact"), storageA, null);
  await orchB.persistExtraction(factResult("beta interleaved fact"), storageB, null);

  const fresh = new StorageManager(memoryDir);
  assert.equal(await fresh.hasFactContentHash("alpha interleaved fact"), true, "A's fact survived");
  assert.equal(await fresh.hasFactContentHash("beta interleaved fact"), true, "B's fact survived");
});
test("#1909 round 11: the restart rebuild reflects the current corpus (archived fact is not re-deduped)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-corpus-reflect-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
    factDeduplicationEnabled: true,
  });
  const orchestrator = new Orchestrator(config) as unknown as OrchestratorTestSurface;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();

  const body = "The nightly job compacts cold storage at 02:00 UTC.";
  await orchestrator.persistExtraction(factResult(body), storage, null);
  const readyPath = path.join(memoryDir, "state", "fact-hashes.ready");
  assert.equal(existsSync(readyPath), false, "no ready marker is ever written (round 11)");

  const before = new StorageManager(memoryDir);
  assert.equal(await before.hasFactContentHash(body), true);

  const mem = (await storage.readAllMemories()).find((m: MemoryFile) => m.content.includes(body));
  assert.ok(mem, "persisted fact is readable");
  await rm(mem.path);
  clearMemoryCache(memoryDir);

  const after = new StorageManager(memoryDir);
  assert.equal(
    await after.hasFactContentHash(body),
    false,
    "archived fact is not deduped after the restart rebuild",
  );
});
test("#1909 round 11 finding 2: destroy() flushes the debounced buffer BEFORE catalog touches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-destroy-order-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
  });
  const orchestrator = new Orchestrator(config);
  const priv = orchestrator as unknown as {
    buffer: { flushPendingSave: () => Promise<void> };
    namespaceCatalog: { flushPendingTouches: () => Promise<void> };
    destroy: () => Promise<void>;
  };
  const order: string[] = [];
  const realFlushSave = priv.buffer.flushPendingSave.bind(priv.buffer);
  priv.buffer.flushPendingSave = async () => {
    order.push("buffer");
    return realFlushSave();
  };
  const realFlushTouch = priv.namespaceCatalog.flushPendingTouches.bind(priv.namespaceCatalog);
  priv.namespaceCatalog.flushPendingTouches = async () => {
    order.push("catalog");
    return realFlushTouch();
  };

  await priv.destroy();
  assert.deepEqual(
    order.filter((step) => step === "catalog"),
    ["catalog"],
    "the catalog-touch flush runs exactly once",
  );
  assert.equal(order.at(-1), "catalog", "no buffer flush may run after the catalog-touch flush");
  assert.ok(order.includes("buffer"), "destroy() flushes the buffer");
});
test("#1909 round 14: destroy() surfaces a buffer flush failure and still completes teardown", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-destroy-fail-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
  });
  const orchestrator = new Orchestrator(config);
  const priv = orchestrator as unknown as {
    buffer: { flushPendingSave: (opts?: { throwOnFailure?: boolean }) => Promise<void> };
    namespaceCatalog: { flushPendingTouches: () => Promise<void> };
    destroy: () => Promise<void>;
  };
  const flushErr = new Error("simulated shutdown buffer write failure");
  priv.buffer.flushPendingSave = async () => {
    throw flushErr;
  };
  let catalogFlushed = false;
  const realFlushTouch = priv.namespaceCatalog.flushPendingTouches.bind(priv.namespaceCatalog);
  priv.namespaceCatalog.flushPendingTouches = async () => {
    catalogFlushed = true;
    return realFlushTouch();
  };

  await assert.rejects(
    priv.destroy(),
    (err: unknown) => err === flushErr,
    "destroy() must surface the buffer flush failure instead of swallowing it",
  );
  assert.equal(
    catalogFlushed,
    true,
    "teardown (catalog flush) must still run in the finally block despite the flush failure",
  );
});
test("#1909 round 12: after a crash before the batch save, the orchestrator dedup sees the fact (corpus rebuild)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-orch-rebuild-"));
  const body = "The deploy pipeline gates on a green smoke suite.";

  {
    const seed = new StorageManager(memoryDir);
    await seed.ensureDirectories();
    await seed.writeMemory("fact", body, { source: "extraction", deferHashIndexSave: true });
    // CRASH: no saveContentHashIndexes → fact-hashes.txt never got the hash.
  }
  clearMemoryCache(memoryDir); // model a fresh process

  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
    factDeduplicationEnabled: true,
  });
  const orchestrator = new Orchestrator(config) as unknown as OrchestratorTestSurface;
  const storage = await orchestrator.getStorage("default");

  assert.equal(
    await orchestrator.hasContentHashDedup(storage, body),
    true,
    "orchestrator dedup sees the crashed-but-durable fact via the corpus rebuild",
  );
  const { persistedIds: ids } = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(ids.length, 0, "the fact is deduped on re-extraction — not re-created");
});

test("#1909 round 13: startup rebuild preserves PROCEDURE hashes as well as fact hashes across restart", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-rebuild-"));
  const factBody = "The staging deploy gates on a green smoke suite.";
  const procTitle = "When you cut a hotfix release, follow the checklist";
  const procSteps = [
    { intent: "Branch from main and cherry-pick the fix" },
    { intent: "Run CI and tag the release" },
  ];
  const procBody = buildProcedurePersistBody(
    procTitle,
    procSteps.map((s, i) => ({ order: i + 1, intent: s.intent })),
  );

  const makeConfig = () =>
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
      // procedural.enabled defaults to true.
    });

  {
    const orch = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
    const storage = await orch.getStorage("default");
    const { persistedIds: factIds } = await orch.persistExtraction(factResult(factBody), storage, null);
    assert.equal(factIds.length, 1, "fact persisted in phase 1");
    const { persistedIds: procIds } = await orch.persistExtraction(
      procedureResult(procTitle, procSteps),
      storage,
      null,
    );
    assert.equal(procIds.length, 1, "procedure persisted in phase 1");
  }
  clearMemoryCache(memoryDir); // model a fresh process

  const orch2 = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storage2 = await orch2.getStorage("default");

  assert.equal(
    await orch2.hasContentHashDedup(storage2, factBody),
    true,
    "fact hash survives the corpus rebuild",
  );
  assert.equal(
    await orch2.hasContentHashDedup(storage2, procBody),
    true,
    "PROCEDURE hash survives the corpus rebuild (round 13 fix)",
  );

  const { persistedIds: factReIds } = await orch2.persistExtraction(factResult(factBody), storage2, null);
  assert.equal(factReIds.length, 0, "fact is deduped on restart");
  const { persistedIds: procReIds } = await orch2.persistExtraction(
    procedureResult(procTitle, procSteps),
    storage2,
    null,
  );
  assert.equal(
    procReIds.length,
    0,
    "procedure is deduped on restart (would be re-created without the round 13 fix)",
  );

  const all = await storage2.readAllMemories();
  assert.equal(
    all.filter((m: MemoryFile) => m.frontmatter.category === "fact").length,
    1,
    "one fact on disk",
  );
  assert.equal(
    all.filter((m: MemoryFile) => m.frontmatter.category === "procedure").length,
    1,
    "one procedure on disk",
  );

  await rm(memoryDir, { recursive: true, force: true });
});

test("#1909 round 15 (PR #2016): startup rebuild preserves EVERY registered category hash across restart", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cat-rebuild-"));
  const prefContent = "The user prefers dark mode across every surface.";
  const decisionContent = "We standardized on pnpm for all workspace installs.";
  const attrContent = "The user's working timezone is America/Chicago.";
  const attrs: Record<string, string> = { timezone: "America/Chicago", trust: "high" };

  const categoryResult = (
    content: string,
    category: MemoryCategory,
    structuredAttributes?: Record<string, string>,
  ): ExtractionResult => ({
    facts: [
      {
        content,
        category,
        tags: [],
        confidence: 0.9,
        ...(structuredAttributes ? { structuredAttributes } : {}),
      } as ExtractedFact,
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  });

  const makeConfig = () =>
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
    });

  {
    const orch = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
    const storage = await orch.getStorage("default");
    assert.equal(
      (await orch.persistExtraction(categoryResult(prefContent, "preference"), storage, null)).persistedIds.length,
      1,
      "preference persisted in phase 1",
    );
    assert.equal(
      (await orch.persistExtraction(categoryResult(decisionContent, "decision"), storage, null)).persistedIds.length,
      1,
      "decision persisted in phase 1",
    );
    assert.equal(
      (await orch.persistExtraction(categoryResult(attrContent, "preference", attrs), storage, null)).persistedIds.length,
      1,
      "attributed preference persisted in phase 1",
    );
  }
  clearMemoryCache(memoryDir); // model a fresh process

  const orch2 = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storage2 = await orch2.getStorage("default");

  assert.equal(
    await orch2.hasContentHashDedup(storage2, prefContent),
    true,
    "preference hash survives the corpus rebuild (PR #2016 fix)",
  );
  assert.equal(
    await orch2.hasContentHashDedup(storage2, decisionContent),
    true,
    "decision hash survives the corpus rebuild (PR #2016 fix)",
  );
  assert.equal(
    await orch2.hasContentHashDedup(storage2, attrContent),
    true,
    "attributed preference hash survives the rebuild (attributes suffix stripped)",
  );

  assert.equal(
    (await orch2.persistExtraction(categoryResult(prefContent, "preference"), storage2, null)).persistedIds.length,
    0,
    "preference is deduped on restart (would be re-created without the fix)",
  );
  assert.equal(
    (await orch2.persistExtraction(categoryResult(decisionContent, "decision"), storage2, null)).persistedIds.length,
    0,
    "decision is deduped on restart (would be re-created without the fix)",
  );
  assert.equal(
    (await orch2.persistExtraction(categoryResult(attrContent, "preference", attrs), storage2, null)).persistedIds.length,
    0,
    "attributed preference is deduped on restart (would be re-created without the fix)",
  );

  const all = await storage2.readAllMemories();
  assert.equal(
    all.filter((m: MemoryFile) => m.frontmatter.category === "preference").length,
    2,
    "two preferences on disk (plain + attributed), none duplicated",
  );
  assert.equal(
    all.filter((m: MemoryFile) => m.frontmatter.category === "decision").length,
    1,
    "one decision on disk, not duplicated",
  );

  await rm(memoryDir, { recursive: true, force: true });
});

test("#1909 (PR #2016): a fact demoted to cold is not re-created as a duplicate hot copy after restart", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cold-dedup-"));
  const body =
    "The disaster-recovery drill runs on the first Sunday of every quarter.";

  const makeConfig = () =>
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
    });

  {
    const orch = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
    const storage = await orch.getStorage("default");
    const { persistedIds: ids } = await orch.persistExtraction(factResult(body), storage, null, {
      sourceConnector: "chatgpt",
    });
    assert.equal(ids.length, 1, "fact persisted to hot in phase 1");

    const [hotMemory] = await storage.readAllMemories();
    assert.ok(hotMemory, "the persisted fact is readable from the hot tier");
    const { changed } = await storage.migrateMemoryToTier(hotMemory, "cold");
    assert.equal(changed, true, "the fact was demoted to cold");

    assert.equal(
      (await storage.readAllMemories()).length,
      0,
      "no active copy remains in the hot tier after demotion",
    );
    const cold = await storage.readAllColdMemories();
    assert.equal(cold.length, 1, "the demoted fact is now in the cold tier");
    assert.equal(
      cold[0]?.frontmatter.status ?? "active",
      "active",
      "the cold copy is still active",
    );
  }
  clearMemoryCache(memoryDir); // model a fresh process

  const orch2 = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storage2 = await orch2.getStorage("default");
  assert.equal(
    await orch2.hasContentHashDedup(storage2, body),
    true,
    "the demoted fact's hash survives the hot+cold rebuild",
  );

  const { persistedIds: reIds } = await orch2.persistExtraction(factResult(body), storage2, null, {
    sourceConnector: "chatgpt",
  });
  assert.equal(
    reIds.length,
    0,
    "cold-only active copy suppresses the duplicate hot write (would be 1 without the fix)",
  );

  assert.equal(
    (await storage2.readAllMemories()).filter((m: MemoryFile) => m.content.includes(body))
      .length,
    0,
    "no duplicate hot copy was written",
  );
  assert.equal(
    (await storage2.readAllColdMemories()).filter((m: MemoryFile) => m.content.includes(body))
      .length,
    1,
    "the single cold copy remains the only copy of the fact",
  );

  await rm(memoryDir, { recursive: true, force: true });
});

test("#1909 (PR #2016) review: an authoritative instance still confirms a fact a peer flushed after its rebuild (no duplicate)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-peer-fresh-"));
  const makeConfig = () =>
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
    });
  const orchA = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const orchB = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storageA = await orchA.getStorage("default");
  const storageB = await orchB.getStorage("default");
  await storageA.ensureDirectories();

  const body = "The incident bridge auto-pages the on-call SRE after five minutes.";

  assert.equal(
    await storageA.isFactContentHashAuthoritative(),
    true,
    "A's fact-hash index rebuilt authoritative",
  );
  assert.equal(
    await orchA.hasContentHashDedup(storageA, body),
    false,
    "A has no such fact before B writes it",
  );

  const { persistedIds: bIds } = await orchB.persistExtraction(factResult(body), storageB, null);
  assert.equal(bIds.length, 1, "B persisted the fact");

  assert.equal(
    await orchA.hasContentHashDedup(storageA, body),
    true,
    "A sees B's flushed fact via the freshness-gated rebuild (stale-miss without the fix)",
  );
  assert.equal(
    await storageA.hasFactContentHash(body),
    true,
    "A's fact-only membership also reflects B's flushed fact",
  );

  const { persistedIds: aIds } = await orchA.persistExtraction(factResult(body), storageA, null);
  assert.equal(aIds.length, 0, "A does not re-create B's fact (would be 1 without the fix)");
  const all = await new StorageManager(memoryDir).readAllMemories();
  assert.equal(
    all.filter((m: MemoryFile) => m.content.includes(body)).length,
    1,
    "exactly one copy of the fact exists on disk",
  );

  await rm(memoryDir, { recursive: true, force: true });
});

test("#1909 (PR #2016): a re-extracted duplicate backfills temporal bounds onto a COLD-only active copy", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cold-backfill-"));
  const body =
    "The legacy billing pipeline drains all remaining invoices before shutdown.";
  const anchor = "2025-06-20T00:00:00.000Z";

  const makeConfig = () =>
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
      temporalBiTemporal: true,
    });

  {
    const orch = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
    const storage = await orch.getStorage("default");
    const { persistedIds: ids } = await orch.persistExtraction(factResult(body), storage, null, {
      sourceConnector: "chatgpt",
      validAt: anchor,
    });
    assert.equal(ids.length, 1, "fact persisted to hot in phase 1");

    const [hotMemory] = await storage.readAllMemories();
    assert.ok(hotMemory, "the persisted fact is readable from the hot tier");
    assert.ok(
      !hotMemory.frontmatter.invalid_at,
      "the fact has no end bound before re-extraction",
    );
    const { changed } = await storage.migrateMemoryToTier(hotMemory, "cold");
    assert.equal(changed, true, "the fact was demoted to cold");
    assert.equal(
      (await storage.readAllMemories()).length,
      0,
      "no active copy remains in the hot tier after demotion",
    );
  }
  clearMemoryCache(memoryDir); // model a fresh process

  const orch2 = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storage2 = await orch2.getStorage("default");
  const resultWithEndBound: ExtractionResult = {
    facts: [{ ...makeFact(body), eventTime: "through 2026" }],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };
  const { persistedIds: reIds } = await orch2.persistExtraction(resultWithEndBound, storage2, null, {
    sourceConnector: "chatgpt",
    validAt: anchor,
  });
  assert.equal(
    reIds.length,
    0,
    "cold-only active copy suppresses the duplicate hot write",
  );
  assert.equal(
    (await storage2.readAllMemories()).length,
    0,
    "no duplicate hot copy was written",
  );

  const cold = await storage2.readAllColdMemories();
  const coldCopy = cold.find((m: MemoryFile) => m.content.includes(body));
  assert.ok(coldCopy, "the single cold copy remains");
  assert.equal(
    coldCopy!.frontmatter.invalid_at,
    "2027-01-01T00:00:00.000Z",
    "the corrected invalid_at was backfilled onto the COLD copy (empty without the fix)",
  );

  await rm(memoryDir, { recursive: true, force: true });
});

test("#1909 (PR #2016): a promoted fact demoted to cold is not re-promoted as a duplicate hot copy after restart", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cold-promo-"));
  const body = "The compliance archive is retained for exactly seven years.";
  const scopePlan = makePromotionScopePlan();

  const makeConfig = () =>
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

  {
    const orch = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
    const targetStorage = await orch.getStorage(PROMOTION_TARGET_NS);
    await targetStorage.ensureDirectories();
    await targetStorage.writeMemory("fact", body, {
      confidence: 0.9,
      sourceConnector: "chatgpt",
    });
    const [hotMemory] = await targetStorage.readAllMemories();
    assert.ok(hotMemory, "the pre-written promotion copy is in the hot tier");
    const { changed } = await targetStorage.migrateMemoryToTier(hotMemory, "cold");
    assert.equal(changed, true, "the promoted copy was demoted to cold");
    assert.equal(
      (await targetStorage.readAllMemories()).length,
      0,
      "no active promotion copy remains in the hot tier",
    );
    assert.equal(
      (await targetStorage.readAllColdMemories()).length,
      1,
      "the demoted promotion copy is now in the cold tier",
    );
  }
  clearMemoryCache(memoryDir); // model a fresh process

  const orch2 = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storage2 = await orch2.getStorage("default");
  await storage2.ensureDirectories();
  const targetStorage2 = await orch2.getStorage(PROMOTION_TARGET_NS);
  assert.equal(
    await targetStorage2.hasFactContentHash(body),
    true,
    "the demoted promotion copy's hash survives the hot+cold rebuild",
  );

  const { persistedIds: ids } = await orch2.persistExtraction(
    factResult(body),
    storage2,
    null,
    { sourceConnector: "chatgpt" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  assert.equal(
    (await targetStorage2.readAllMemories()).filter((m: MemoryFile) =>
      m.content.includes(body),
    ).length,
    0,
    "no duplicate hot promotion copy was written",
  );
  assert.equal(
    (await targetStorage2.readAllColdMemories()).filter((m: MemoryFile) =>
      m.content.includes(body),
    ).length,
    1,
    "the single cold promotion copy remains the only copy",
  );

  await rm(memoryDir, { recursive: true, force: true });
});

test("#2016 thread SDyCj: a peer-advanced hash visible only after the post-miss authority rebuild is not written as a duplicate", async () => {
  const { orchestrator, storage, memoryDir } = await makeDedupOrchestrator();
  const body = "The release train departs every second Thursday at 1500 UTC.";

  const { persistedIds: first } = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(first.length, 1, "peer's initial write persists");

  const realHas = orchestrator.hasContentHashDedup.bind(orchestrator);
  let calls = 0;
  orchestrator.hasContentHashDedup = async (ts: StorageManager, content: string) => {
    calls += 1;
    if (calls === 1) return false; // stale-snapshot miss
    return realHas(ts, content); // now-authoritative result
  };

  const { persistedIds: ids } = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(
    ids.length,
    0,
    "the re-run lookup after the authority rebuild catches the peer fact (a duplicate is written without the fix)",
  );

  const all = await new StorageManager(memoryDir).readAllMemories();
  assert.equal(
    all.filter((m: MemoryFile) => m.content.includes(body)).length,
    1,
    "exactly one copy of the fact exists on disk",
  );

  await rm(memoryDir, { recursive: true, force: true });
});

test("#2016 threads SDzOP/SDzOR: orchestrator archival removal clears fact-only membership (no stale hasFactContentHash)", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator();
  const body = "The nightly backup job rotates encryption keys every thirty days.";

  await storage.writeMemory("fact", body, { source: "manual" });
  assert.equal(
    await storage.isFactContentHashAuthoritative(),
    true,
    "index is authoritative so hasFactContentHash reads the in-memory fact-only set",
  );
  assert.equal(await storage.hasFactContentHash(body), true, "fact is registered");

  const [memory] = (await storage.readAllMemories()).filter((m: MemoryFile) =>
    m.content.includes(body),
  );
  assert.ok(memory, "the fact is on disk");

  await orchestrator.removeContentHashForMemory(storage, memory, "fact-archival");

  assert.equal(
    await storage.hasFactContentHash(body),
    false,
    "the removed fact must not linger in the fact-only membership (stale true without the fix)",
  );
});
