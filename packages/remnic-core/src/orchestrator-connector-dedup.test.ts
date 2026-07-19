/**
 * Connector-aware dedup regression tests (QOjlB, PR #1852).
 *
 * After a content-hash dedup hit, a readAllMemories() scan verifies the
 * existing fact shares the same sourceConnector. If no same-connector
 * active fact is found, exactDuplicate is set to false so the write
 * proceeds. On scan failure, the write also proceeds (fail open) so an
 * unverifiable hash hit can never silently drop content.
 *
 * Fix location: extraction-persist.ts lines 1585-1607.
 *
 * These tests call persistExtraction directly — the same entry point used
 * by buffer extraction and proactive extraction.
 */

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

// ---------------------------------------------------------------------------
// Types — minimal surface of Orchestrator needed by these tests.
// persistExtraction is private; cast through unknown to reach it without `any`.
// ---------------------------------------------------------------------------

/** Source-context shape accepted by persistExtraction (connector subset). */
interface TestSourceContext {
  sourceConnector?: string;
  validAt?: string;
}

/** Orchestrator fields the tests touch (all exist on the real instance). */
interface OrchestratorTestSurface {
  persistExtraction: (
    result: ExtractionResult,
    storage: StorageManager,
    threadId: string | null,
    sourceContext?: TestSourceContext,
    baseNamespace?: string,
    scopeProfileWritePlan?: ResolvedScopeProfilePlan | null,
  ) => Promise<string[]>;
  getStorage: (namespace: string) => Promise<StorageManager>;
  contentHashIndex: ContentHashIndex | null;
  // Private on the real instance; reached through the unknown-cast surface for
  // the #1909 defer-durability tests (registration failure + concurrent runs).
  addContentHashDedup: (targetStorage: StorageManager, content: string) => Promise<void>;
  hasContentHashDedup: (targetStorage: StorageManager, content: string) => Promise<boolean>;
  removeContentHashForMemory: (
    targetStorage: StorageManager,
    memory: MemoryFile,
    context: string,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
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

  // Inject a real ContentHashIndex so the hash-dedup path is active.
  const stateDir = path.join(memoryDir, "state");
  await mkdir(stateDir, { recursive: true });
  const hashIndex = new ContentHashIndex(stateDir);
  await hashIndex.load();
  orchestrator.contentHashIndex = hashIndex;

  return { orchestrator, storage, memoryDir, hashIndex };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("connector dedup (QOjlB): same content + same connector dedupes", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator();
  const body =
    "The deployment pipeline runs canary checks every fifteen minutes before promoting to production.";

  // First write with connector "chatgpt" — must succeed.
  const ids1 = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first write must succeed");

  // Second write: same content, same connector → must dedupe.
  const ids2 = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids2.length, 0, "same-connector duplicate must be deduped");

  // Only one copy of the fact on disk.
  const all = await storage.readAllMemories();
  const matching = all.filter((m: MemoryFile) => m.content.includes(body));
  assert.equal(matching.length, 1, "only one memory on disk");
});

test("connector dedup (QOjlB): same content + different connector does NOT dedupe", async () => {
  const { orchestrator, storage } = await makeDedupOrchestrator();
  const body =
    "The staging environment uses isolated feature flags per tenant for safer rollouts.";

  // First write with connector "chatgpt".
  const ids1 = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first write must succeed");

  // Second write: same content, DIFFERENT connector → must NOT dedupe.
  const ids2 = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "codex-cli" },
  );
  assert.equal(ids2.length, 1, "cross-connector fact must NOT be deduped");

  // Two memories on disk, one per connector.
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

  // Simulate a stale hash: register the content hash WITHOUT writing any
  // matching memory. The hash says "duplicate" but no memory backs it.
  hashIndex.add(body);

  // persistExtraction must write through — the connector-aware scan finds
  // no matching memory, so exactDuplicate falls to false.
  const ids = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids.length, 1, "stale hash with no memory must write through");

  // Verify the fact landed on disk.
  const all = await storage.readAllMemories();
  const matching = all.filter((m: MemoryFile) => m.content.includes(body));
  assert.equal(matching.length, 1, "fact must be persisted on disk");
});

test("connector dedup (QOjlB): readAllMemories throws → writes through (fail open)", async () => {
  const { orchestrator, storage, hashIndex } = await makeDedupOrchestrator();
  const body =
    "The redaction engine compiles regex patterns defensively to avoid ReDoS.";

  // Pre-register the hash so hasContentHashDedup returns true, forcing the
  // connector-aware scan to run.
  hashIndex.add(body);

  // Override readAllMemories to simulate a scan failure. With the test
  // config (no embedding fallback, no graph, no namespaces) the dedup
  // scan at extraction-persist.ts:1592 is the ONLY readAllMemories call
  // during persistExtraction, so this override targets it precisely.
  const originalReadAllMemories = storage.readAllMemories.bind(storage);
  storage.readAllMemories = async (): Promise<MemoryFile[]> => {
    throw new Error("simulated readAllMemories failure");
  };

  // persistExtraction must write through — the scan failure is caught and
  // exactDuplicate falls to false (fail open).
  const ids = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids.length, 1, "scan failure must fail open to write");

  // Restore so post-test verification can read memories.
  storage.readAllMemories = originalReadAllMemories;
  const all = await storage.readAllMemories();
  const matching = all.filter((m: MemoryFile) => m.content.includes(body));
  assert.equal(matching.length, 1, "fact must be persisted despite scan failure");
});

// ---------------------------------------------------------------------------
// Promotion dedup tests (QOjlD, PR #1852)
//
// The promotion paths (profile-target at extraction-persist.ts:476-521 and
// shared at :730-751) apply the same connector-aware dedup after a hash hit.
// After hasFactContentHash returns true on the TARGET namespace, a
// readAllMemories() scan checks whether a same-content, same-connector
// active fact exists there. If not, the promotion write proceeds. Fail
// open on scan error.
//
// Each test pre-writes a fact to the TARGET namespace (via writeMemory,
// which registers the content hash in the target's fact-hash index), then
// calls persistExtraction on the SOURCE namespace with a scope-profile
// plan that auto-promotes "fact" to a userGlobal target.
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

  // Pre-write the same fact to the TARGET namespace with connector "chatgpt".
  // This registers the content hash in the target's fact-hash index.
  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  // persistExtraction writes to source (default) and promotes to target.
  const ids = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  // Target must still have exactly ONE memory — promotion was skipped.
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

  // Pre-write with connector "chatgpt".
  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  // Extract with a DIFFERENT connector — promotion must proceed.
  const ids = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "codex-cli" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  // Target must now have TWO memories (pre-write + promoted copy).
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

  // Pre-write WITH a connector (chatgpt).
  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  // Extract WITHOUT a sourceConnector (operator write).
  const ids = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    undefined,
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  // Connectors differ (chatgpt vs undefined) → promotion must proceed.
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

  // Pre-write WITHOUT a connector (operator write).
  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
  });

  // Extract WITHOUT a sourceConnector (operator write).
  const ids = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    undefined,
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  // Both undefined → connectors match → promotion must be skipped.
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

  // Pre-write the same fact to the target with connector "chatgpt".
  await targetStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  // Force the target's fact-hash index to become authoritative NOW so the
  // subsequent hasFactContentHash call inside persistExtraction does NOT
  // internally call readAllMemories (which we are about to override).
  await targetStorage.isFactContentHashAuthoritative();

  // Sanity: the hash really is registered before we break the scan.
  assert.ok(
    await targetStorage.hasFactContentHash(body),
    "pre-write must register the content hash in the target index",
  );

  // Override readAllMemories on the TARGET so the connector-aware scan fails.
  // hasFactContentHash still works (authoritative flag is set), so the code
  // enters the scan block — then readAllMemories throws → fail-open → proceeds.
  const originalReadAllMemories = targetStorage.readAllMemories.bind(targetStorage);
  targetStorage.readAllMemories = async (): Promise<MemoryFile[]> => {
    throw new Error("simulated target readAllMemories failure");
  };

  const ids = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  // Restore and verify the promotion proceeded (fail open).
  targetStorage.readAllMemories = originalReadAllMemories;
  const targetMems = await targetStorage.readAllMemories();
  assert.equal(
    targetMems.length,
    2,
    "promotion must proceed (fail open) when target scan throws",
  );
});

test("promotion dedup (QOjlD): cited fact canonicalized before connector-aware dedup", async () => {
  // When inlineSourceAttributionEnabled is true, the orchestrator appends a
  // citation tag to every persisted fact. A second extraction that arrives
  // already carrying that citation must still be deduped: normalizeStoredHashSource
  // strips the citation from the STORED content before the connector-aware scan
  // compares it to the canonical incoming body. Without this, the cited body
  // would never match and the fact would be re-persisted (and re-promoted)
  // on every relay cycle.
  const { orchestrator, storage } = await makeDedupOrchestrator({
    inlineSourceAttributionEnabled: true,
  });
  const rawBody =
    "The deployment manifest pins container digests for reproducible builds.";

  // First persist: orchestrator appends an inline citation and writes the fact.
  const firstIds = await orchestrator.persistExtraction(
    factResult(rawBody),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(firstIds.length, 1, "first write must succeed");

  // Read back the persisted body — it now carries the citation tag.
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

  // Second persist: submit the ALREADY-CITED body with the same connector.
  // normalizeStoredHashSource strips the citation before comparing, so the
  // connector-aware scan finds the matching fact and dedupes at the source
  // gate — promotion never fires.
  const secondIds = await orchestrator.persistExtraction(
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

  // Only one copy of the fact exists on disk.
  const all = await storage.readAllMemories();
  assert.equal(all.length, 1, "only one memory on disk");
});

// ---------------------------------------------------------------------------
// Thread 5 (QPDE5): procedure body comparison in extraction dedup.
// The hash is keyed on buildProcedurePersistBody (title + steps), but the
// connector-aware scan previously compared against canonicalContentForHash
// (title only). Same-connector procedures with steps were re-persisted.
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
  // Title must contain a PROCEDURE_TRIGGER_RE phrase ("to deploy").
  const title = "Workflow to deploy the canary service to staging";
  const steps = [
    { intent: "Build the container image", expectedOutcome: "Image tagged and pushed" },
    { intent: "Update the Helm chart values", expectedOutcome: "Values file committed" },
  ];

  // First write with connector "chatgpt" — must succeed.
  const ids1 = await orchestrator.persistExtraction(
    procedureResult(title, steps),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first procedure write must succeed");

  // Second write: same procedure, same connector → must dedupe.
  const ids2 = await orchestrator.persistExtraction(
    procedureResult(title, steps),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids2.length, 0, "same-connector procedure must be deduped");

  // Only one procedure memory on disk.
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

  // First write with connector "chatgpt".
  const ids1 = await orchestrator.persistExtraction(
    procedureResult(title, steps),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first procedure write must succeed");

  // Second write: same procedure, DIFFERENT connector → must NOT dedupe.
  const ids2 = await orchestrator.persistExtraction(
    procedureResult(title, steps),
    storage,
    null,
    { sourceConnector: "codex-cli" },
  );
  assert.equal(ids2.length, 1, "cross-connector procedure must NOT be deduped");

  // Two procedures on disk.
  const all = await storage.readAllMemories();
  const procs = all.filter((m: MemoryFile) => m.frontmatter.category === "procedure");
  assert.equal(procs.length, 2, "two procedure memories on disk");
});

// ---------------------------------------------------------------------------
// Thread 3 (QO42V): structuredAttributes enrichment in extraction dedup.
// Facts with structuredAttributes get an appended [Attributes: ...] suffix in
// the stored body. The connector-aware scan previously compared the enriched
// stored body against the raw hash key (no suffix), so same-connector enriched
// facts were re-persisted.
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
  const ids1 = await orchestrator.persistExtraction(
    enrichedResult(body, attrs),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids1.length, 1, "first enriched fact write must succeed");

  // Second write: same content + attrs, same connector → must dedupe.
  const ids2 = await orchestrator.persistExtraction(
    enrichedResult(body, attrs),
    storage,
    null,
    { sourceConnector: "chatgpt" },
  );
  assert.equal(ids2.length, 0, "same-connector enriched fact must be deduped");

  // Only one memory on disk.
  const all = await storage.readAllMemories();
  const facts = all.filter(
    (m: MemoryFile) => m.frontmatter.category === "fact" && m.frontmatter.status !== "superseded",
  );
  assert.equal(facts.length, 1, "only one active fact memory on disk");
});

// ---------------------------------------------------------------------------
// Thread 4 (QPAn-): shared promotion short-circuit ignores connector when
// temporal supersession is off or the fact has no entity/attributes.
// Uses a scope plan with a serverShared promotion target so the shared
// promotion path fires and reaches the no-supersession else branch.
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

  // Pre-write the fact to the SHARED namespace with connector "chatgpt".
  // No entityRef/structuredAttributes → shared promotion takes the else branch.
  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  // Extract with a DIFFERENT connector — shared promotion else branch
  // must NOT short-circuit; the different-connector fact gets promoted.
  const ids = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "codex-cli" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  // Shared namespace must now have TWO memories (chatgpt + codex-cli).
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

  // Pre-write to shared with connector "chatgpt".
  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  // Extract with the SAME connector — shared promotion must be skipped.
  const ids = await orchestrator.persistExtraction(
    factResult(body),
    storage,
    null,
    { sourceConnector: "chatgpt" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  // Shared namespace must still have exactly ONE memory.
  const sharedMems = await sharedStorage.readAllMemories();
  assert.equal(
    sharedMems.length,
    1,
    "same-connector shared promotion must be skipped",
  );
});

// ---------------------------------------------------------------------------
// Regression: shared-promotion temporal backfill respects connector identity
// (codex finding: temporal backfill occurred before connector mismatch check).
// The shared namespace's backfillTemporalBoundsOnDedupHit must NOT patch
// temporal bounds onto a different-connector fact. Same-connector facts
// still get backfilled as designed.
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

  // Pre-write a fact to the SHARED namespace with connector "chatgpt"
  // and NO temporal bounds (invalid_at absent).
  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  // Verify the pre-written fact has no invalid_at.
  const sharedBefore = await sharedStorage.readAllMemories();
  const preFact = sharedBefore.find((m: MemoryFile) => m.frontmatter.sourceConnector === "chatgpt");
  assert.ok(preFact, "pre-written chatgpt fact exists");
  assert.equal(preFact!.frontmatter.invalid_at, undefined, "no invalid_at before extraction");

  // Extract the SAME content with a DIFFERENT connector and an eventTime
  // expression that resolves a validUntil bound.
  const ids = await orchestrator.persistExtraction(
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

  // The chatgpt shared fact must NOT have been temporal-patched —
  // different connector means no cross-connector backfill.
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

  // The codex-li fact must have its OWN promoted shared copy with bounds.
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

  // Pre-write a fact to shared with connector "chatgpt" and NO temporal bounds.
  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.writeMemory("fact", body, {
    confidence: 0.9,
    sourceConnector: "chatgpt",
  });

  // Extract SAME content with SAME connector and an eventTime resolving validUntil.
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

  // Same connector → backfill MUST fire, patching invalid_at onto the
  // existing shared fact.
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
// Regression (cursor #1852): persistence-index backfill must match connector
// identity EXACTLY, including undefined. The prior guard only filtered
// sourceConnector when truthy — so an operator re-extraction with NO connector
// skipped the guard entirely, letting .find() select the first hash/entity
// match, which could be a connector-TAGGED duplicate, mutating its temporal
// bounds. Fix: exact comparison (undefined === undefined, tagged === tagged).
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

  // Pre-write TWO facts to the shared namespace with identical content:
  // one tagged "chatgpt" and one connectorless. Neither has temporal bounds.
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

  // Verify the tagged fact exists and lacks temporal bounds.
  const sharedBefore = await sharedStorage.readAllMemories();
  const taggedBefore = sharedBefore.find(
    (m: MemoryFile) => m.frontmatter.sourceConnector === "chatgpt",
  );
  assert.ok(taggedBefore, "pre-written chatgpt fact exists");
  assert.equal(taggedBefore!.frontmatter.invalid_at, undefined);

  // Extract the SAME content with NO sourceConnector (operator
  // re-extraction) and an eventTime that resolves a validUntil bound.
  const ids = await orchestrator.persistExtraction(
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

  // The chatgpt-tagged fact must NOT have been temporal-patched.
  // Operator/no-connector backfill may only select a connectorless
  // candidate, never a connector-tagged one (cursor #1852).
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
// Issue #1909 review round 2 finding 2 — defer only covered by the batch save
// ---------------------------------------------------------------------------

test("#1909: with factDeduplicationEnabled=false, extraction writes flush the fact-hash index immediately", async () => {
  // With dedup off, contentHashIndexForStorage() returns null so the
  // orchestrator's end-of-persist batch save is a no-op. The main-path fact
  // write must therefore NOT defer its per-fact index flush — otherwise the
  // storage-owned fact-hash index is never written, and a restart with
  // fact-hashes.ready present trusts a stale index missing the fact.
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
  // Warm the index authoritative and create the .ready marker over the current
  // (empty) corpus, so a later fresh session trusts the on-disk index.
  assert.equal(await storage.hasFactContentHash("warm"), false);

  const body = "The billing service retries failed charges with exponential backoff.";
  const ids = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(ids.length, 1, "the fact is written");

  // Fresh StorageManager with .ready present trusts the on-disk fact-hash index
  // (no rebuild). The hash must be there via the immediate per-fact save.
  const restarted = new StorageManager(memoryDir);
  assert.equal(
    await restarted.hasFactContentHash(body),
    true,
    "the fact hash was flushed immediately despite the batch saver being a no-op",
  );
});
test("#2016 SD-nH: fact dedup disabled never suppresses a write via the authority/corpus-confirm path", async () => {
  // With dedup DISABLED the entire content-hash dedup path must be
  // short-circuited. The pre-fix code still ran hasContentHashDedup (returns
  // false with a null index), then consulted isFactContentHashAuthoritative();
  // when that reported NON-authoritative (e.g. a peer holds the rebuild lock)
  // it set needsCorpusConfirm and the connector-aware corpus scan could find a
  // same-content same-connector active fact and SUPPRESS the write — dedup
  // behavior while dedup is turned off.
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

    // Seed one active same-connector copy in the corpus.
    const first = await orchestrator.persistExtraction(factResult(body), storage, null, source);
    assert.equal(first.length, 1, "first write lands");

    // Force the storage fact-hash index NON-authoritative so the pre-fix code
    // falls into needsCorpusConfirm and runs the corpus scan — the exact path
    // that (wrongly) suppressed a write while dedup is DISABLED.
    // isFactContentHashAuthoritative is a real method on StorageManager; the
    // cast only reaches it as an overridable slot for this test.
    const authorityStub = storage as unknown as {
      isFactContentHashAuthoritative: () => Promise<boolean>;
    };
    authorityStub.isFactContentHashAuthoritative = async () => false;
    // Read the corpus from disk so the scan sees the seeded copy.
    clearMemoryCache();

    const second = await orchestrator.persistExtraction(factResult(body), storage, null, source);
    assert.equal(
      second.length,
      1,
      "dedup disabled must not suppress the write via the authority/corpus-confirm path",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("#1909 round 11: deferred persist writes no ready marker and a restart rebuild still dedups", async () => {
  // With dedup ON the main-path fact write defers; there is NO fact-hashes.ready
  // marker anymore. A restart rebuilds the fact-hash index authoritatively from
  // the corpus and still dedups the fact.
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
  const ids = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(ids.length, 1, "the fact is written");
  assert.equal(existsSync(readyPath), false, "no ready marker is ever written (round 11)");

  // A fresh instance rebuilds from the corpus and still dedups.
  const restarted = new StorageManager(memoryDir);
  assert.equal(await restarted.hasFactContentHash(body), true);
  assert.equal(existsSync(readyPath), false, "still no marker after the restart rebuild");
});
test("#1909: a deferred fact stays durable when addContentHashDedup throws", async () => {
  // Review round 6 finding 1: the deferred write's durability must not depend on
  // the orchestrator dedup registration succeeding. writeMemory already added the
  // hash to the storage-owned index; the end-of-run storage-index flush must put
  // it on disk even though addContentHashDedup threw (caught+logged).
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

  // Force the orchestrator dedup registration to throw for every fact this run.
  orchestrator.addContentHashDedup = async () => {
    throw new Error("simulated registration failure");
  };

  const body = "The queue drains oldest-first under sustained backpressure.";
  const ids = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(ids.length, 1, "the fact is written despite the registration failure");

  // Restart trusts the marker (restored) and finds the hash on disk — no
  // duplicate re-creation — because the storage-owned index flush persisted it.
  const restarted = new StorageManager(memoryDir);
  assert.equal(
    await restarted.hasFactContentHash(body),
    true,
    "the deferred hash reached disk independent of addContentHashDedup",
  );
});

test("#1909: two interleaved persist runs both land on disk (merge, no clobber)", async () => {
  // Review round 6 finding 2: two orchestrators that snapshot an empty index
  // before either saves must not clobber each other — the merge-save unions.
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

  // Force BOTH orchestrator indexes to load an empty snapshot up front (the race:
  // each holds a pre-write view of the shared on-disk index).
  await orchA.hasContentHashDedup(storageA, "noop-a");
  await orchB.hasContentHashDedup(storageB, "noop-b");

  await orchA.persistExtraction(factResult("alpha interleaved fact"), storageA, null);
  await orchB.persistExtraction(factResult("beta interleaved fact"), storageB, null);

  // A blind overwrite by B (stale empty snapshot) would drop alpha; the merge
  // union preserves both.
  const fresh = new StorageManager(memoryDir);
  assert.equal(await fresh.hasFactContentHash("alpha interleaved fact"), true, "A's fact survived");
  assert.equal(await fresh.hasFactContentHash("beta interleaved fact"), true, "B's fact survived");
});
test("#1909 round 11: the restart rebuild reflects the current corpus (archived fact is not re-deduped)", async () => {
  // No ready marker exists — the fact-hash index is ALWAYS rebuilt from the
  // durable corpus on restart. So an archival/consolidation removal LANDS after
  // restart (the removed .md is excluded from the rebuild) even if that run's
  // reconciling save could not publish (lock timeout) — there is no stale
  // on-disk index to trust. This is the definitive replacement for the
  // marker-invalidate-on-removal machinery.
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

  // A fresh instance rebuilds from the corpus → dedups the persisted fact.
  const before = new StorageManager(memoryDir);
  assert.equal(await before.hasFactContentHash(body), true);

  // Archive the fact: remove its .md from the active corpus.
  const mem = (await storage.readAllMemories()).find((m: MemoryFile) => m.content.includes(body));
  assert.ok(mem, "persisted fact is readable");
  await rm(mem.path);
  // Simulate a fresh process (real restart): drop the process-wide memory cache
  // so the rebuild re-reads the now-smaller corpus from disk.
  clearMemoryCache(memoryDir);

  // A fresh instance rebuilds from the now-smaller corpus → the archived fact is
  // no longer deduped (re-extraction is allowed). The removal landed with no
  // marker and no reliance on the reconciling save having published.
  const after = new StorageManager(memoryDir);
  assert.equal(
    await after.hasFactContentHash(body),
    false,
    "archived fact is not deduped after the restart rebuild",
  );
});
test("#1909 round 11 finding 2: destroy() flushes the debounced buffer BEFORE catalog touches", async () => {
  // The buffer save fires a coalesced namespace-catalog touch; if catalog touches
  // were flushed first, that shutdown-time touch would queue after and be lost.
  // destroy() must flush the buffer first so its touch folds into the catalog
  // flush and both settle before destroy() returns.
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
    order,
    ["buffer", "catalog"],
    "buffer flush must run before the catalog-touch flush on shutdown",
  );
});
test("#1909 round 14: destroy() surfaces a buffer flush failure and still completes teardown", async () => {
  // Graceful-shutdown durability contract: a failed shutdown buffer flush must
  // NOT be silently swallowed — the pending turns are retained in memory but
  // lost on process exit, so the host has to learn about it. destroy() runs the
  // remaining teardown in a finally block, then rethrows the flush failure.
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
  // A deferred fact write persists the .md but not fact-hashes.txt; a crash
  // before saveContentHashIndexes leaves only the .md durable. On restart the
  // orchestrator's dedup index must be corpus-AUTHORITATIVE (round 12) — sharing
  // StorageManager's rebuild — so hasContentHashDedup sees the fact and
  // persistExtraction does NOT re-create it. Pre-round-12 it loaded a stale
  // fact-hashes.txt (missing the fact) and would duplicate.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-orch-rebuild-"));
  const body = "The deploy pipeline gates on a green smoke suite.";

  // Phase 1 — crash window: deferred write, NO batch save / index flush.
  {
    const seed = new StorageManager(memoryDir);
    await seed.ensureDirectories();
    await seed.writeMemory("fact", body, { source: "extraction", deferHashIndexSave: true });
    // CRASH: no saveContentHashIndexes → fact-hashes.txt never got the hash.
  }
  clearMemoryCache(memoryDir); // model a fresh process

  // Phase 2 — restart: the orchestrator dedup index rebuilds from the corpus.
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
  // And re-persisting the same fact is deduped (no duplicate .md created).
  const ids = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(ids.length, 0, "the fact is deduped on re-extraction — not re-created");
});

test("#1909 round 13: startup rebuild preserves PROCEDURE hashes as well as fact hashes across restart", async () => {
  // The content-hash dedup index is SHARED by fact AND procedure dedup —
  // procedures register their persist-body hash into the same index. The
  // marker-less startup rebuild (ensureFactHashIndexAuthoritative) clears the
  // on-disk index and reconstructs it from the .md corpus on first use per
  // process. A fact-only rebuild dropped every persisted procedure hash, so a
  // restart would re-create identical procedures. Both categories must survive.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-rebuild-"));
  const factBody = "The staging deploy gates on a green smoke suite.";
  const procTitle = "When you cut a hotfix release, follow the checklist";
  const procSteps = [
    { intent: "Branch from main and cherry-pick the fix" },
    { intent: "Run CI and tag the release" },
  ];
  // The dedup key for a procedure is its full persist body (title + steps).
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

  // Phase 1 — persist a fact and a procedure through the real persist path.
  {
    const orch = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
    const storage = await orch.getStorage("default");
    const factIds = await orch.persistExtraction(factResult(factBody), storage, null);
    assert.equal(factIds.length, 1, "fact persisted in phase 1");
    const procIds = await orch.persistExtraction(
      procedureResult(procTitle, procSteps),
      storage,
      null,
    );
    assert.equal(procIds.length, 1, "procedure persisted in phase 1");
  }
  clearMemoryCache(memoryDir); // model a fresh process

  // Phase 2 — restart: the dedup index rebuilds authoritatively from the corpus.
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

  // Re-extraction of both is deduped — neither is re-created.
  const factReIds = await orch2.persistExtraction(factResult(factBody), storage2, null);
  assert.equal(factReIds.length, 0, "fact is deduped on restart");
  const procReIds = await orch2.persistExtraction(
    procedureResult(procTitle, procSteps),
    storage2,
    null,
  );
  assert.equal(
    procReIds.length,
    0,
    "procedure is deduped on restart (would be re-created without the round 13 fix)",
  );

  // Exactly one of each remains on disk.
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
  // The content-hash dedup index is shared by every registered write category:
  // persistExtraction calls addContentHashDedup for every writeCategory it
  // persists (preference, decision, commitment, …), not only fact/procedure.
  // A rebuild restricted to fact+procedure dropped those hashes on restart, so
  // the next extraction re-created identical active non-fact memories (the
  // retired fact-hashes.txt load used to preserve them). Every category's hash
  // must survive the corpus rebuild.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cat-rebuild-"));
  const prefContent = "The user prefers dark mode across every surface.";
  const decisionContent = "We standardized on pnpm for all workspace installs.";
  // A preference carrying structuredAttributes: writeMemory appends an
  // "[Attributes: …]" suffix to the stored body, but the registered dedup key
  // is the RAW content WITHOUT that suffix. The rebuild must strip the suffix
  // or the reconstructed hash never matches and the memory is re-created.
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

  // Phase 1 — persist non-fact/procedure categories through the real path.
  {
    const orch = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
    const storage = await orch.getStorage("default");
    assert.equal(
      (await orch.persistExtraction(categoryResult(prefContent, "preference"), storage, null)).length,
      1,
      "preference persisted in phase 1",
    );
    assert.equal(
      (await orch.persistExtraction(categoryResult(decisionContent, "decision"), storage, null)).length,
      1,
      "decision persisted in phase 1",
    );
    assert.equal(
      (await orch.persistExtraction(categoryResult(attrContent, "preference", attrs), storage, null)).length,
      1,
      "attributed preference persisted in phase 1",
    );
  }
  clearMemoryCache(memoryDir); // model a fresh process

  // Phase 2 — restart: the dedup index rebuilds authoritatively from the corpus.
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

  // Re-extraction of each is deduped — none is re-created.
  assert.equal(
    (await orch2.persistExtraction(categoryResult(prefContent, "preference"), storage2, null)).length,
    0,
    "preference is deduped on restart (would be re-created without the fix)",
  );
  assert.equal(
    (await orch2.persistExtraction(categoryResult(decisionContent, "decision"), storage2, null)).length,
    0,
    "decision is deduped on restart (would be re-created without the fix)",
  );
  assert.equal(
    (await orch2.persistExtraction(categoryResult(attrContent, "preference", attrs), storage2, null)).length,
    0,
    "attributed preference is deduped on restart (would be re-created without the fix)",
  );

  // The originals remain the only copies on disk.
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
  // The authoritative content-hash rebuild unions the HOT and COLD tiers, so a
  // restart's hash index reports a hit for a fact whose only active copy was
  // demoted to cold/. The connector-aware confirmation scan in
  // ExtractionPersistCoordinator previously scanned readAllMemories() (hot)
  // only, found no matching row, flipped exactDuplicate back to false, and
  // wrote a SECOND active hot copy. It must scan the cold tier too so the
  // cold-only active copy still suppresses the redundant hot write.
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

  // Phase 1 — persist a fact, then demote its only active copy to cold/.
  {
    const orch = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
    const storage = await orch.getStorage("default");
    const ids = await orch.persistExtraction(factResult(body), storage, null, {
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

  // Phase 2 — restart: the authoritative rebuild unions hot+cold, so the hash
  // index reports a hit for the cold-only copy.
  const orch2 = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storage2 = await orch2.getStorage("default");
  assert.equal(
    await orch2.hasContentHashDedup(storage2, body),
    true,
    "the demoted fact's hash survives the hot+cold rebuild",
  );

  // Re-extraction of the same content with the same connector must be deduped
  // against the cold copy — no second hot copy is created.
  const reIds = await orch2.persistExtraction(factResult(body), storage2, null, {
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
  // Fresh finding beyond the crash/restart tests above: those model a NEW
  // process rebuilding from the corpus. Here BOTH instances stay live. Instance
  // A rebuilds its fact-hash index and marks it authoritative; instance B then
  // persists AND flushes a fact through the real persist path. A is still
  // flagged authoritative from its earlier rebuild, so without a freshness gate
  // its stale in-memory index answers a MISS and skips corpus confirmation —
  // persisting a duplicate active memory. The cheap per-operation freshness
  // check (durable index fingerprint advanced) must drop authority so A's
  // duplicate check finds B's fact.
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

  // A rebuilds the index and becomes authoritative over a corpus without the
  // fact — its in-memory MISS for `body` is (correctly) trusted at this point.
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

  // B persists and flushes the fact through the real persist path (its
  // reconcile-save advances the durable fact-hashes.txt A rebuilt from).
  const bIds = await orchB.persistExtraction(factResult(body), storageB, null);
  assert.equal(bIds.length, 1, "B persisted the fact");

  // A is still flagged authoritative, but the durable index advanced. The
  // freshness gate must catch it so A's duplicate check now finds B's fact
  // instead of trusting a stale miss.
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

  // Re-extracting the same fact on A is deduped — no duplicate .md is created.
  const aIds = await orchA.persistExtraction(factResult(body), storageA, null);
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
  // Finding: when a content-hash hit is confirmed only by the cold tier, the
  // dedup short-circuit fires but backfillTemporalBoundsOnDedupHit() scanned
  // readAllMemories() (hot) alone, so a cold active fact re-extracted with a
  // newly resolved invalid_at never had its cold copy patched and the corrected
  // temporal write was suppressed — leaving recall with stale bounds. The
  // helper must scan the cold tier too.
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

  // Phase 1 — persist a fact with NO end bound, then demote it to cold.
  {
    const orch = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
    const storage = await orch.getStorage("default");
    const ids = await orch.persistExtraction(factResult(body), storage, null, {
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

  // Phase 2 — re-extract the SAME content, now carrying a resolved end bound
  // ("through 2026" → invalid_at 2027-01-01). The dedup hit is confirmed only
  // by the cold copy, so the backfill must patch the cold copy's invalid_at.
  const orch2 = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storage2 = await orch2.getStorage("default");
  const resultWithEndBound: ExtractionResult = {
    facts: [{ ...makeFact(body), eventTime: "through 2026" }],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };
  const reIds = await orch2.persistExtraction(resultWithEndBound, storage2, null, {
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
  // Finding: adding cold memories to the authoritative hash rebuild means the
  // TARGET namespace's hasFactContentHash() can hit a promoted copy that was
  // demoted to cold/, but the promotion confirmation scan read readAllMemories()
  // (hot) alone, missed the cold copy, and fell through to writeSealedMemory —
  // creating a duplicate hot promotion. The confirmation must scan cold too.
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

  // Phase 1 — pre-write the fact into the TARGET namespace, then demote its
  // only active copy to cold/.
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

  // Phase 2 — restart: the target rebuild unions hot+cold, so hasFactContentHash
  // reports a hit for the cold-only promoted copy.
  const orch2 = new Orchestrator(makeConfig()) as unknown as OrchestratorTestSurface;
  const storage2 = await orch2.getStorage("default");
  await storage2.ensureDirectories();
  const targetStorage2 = await orch2.getStorage(PROMOTION_TARGET_NS);
  assert.equal(
    await targetStorage2.hasFactContentHash(body),
    true,
    "the demoted promotion copy's hash survives the hot+cold rebuild",
  );

  const ids = await orch2.persistExtraction(
    factResult(body),
    storage2,
    null,
    { sourceConnector: "chatgpt" },
    "default",
    scopePlan,
  );
  assert.equal(ids.length, 1, "source write must succeed");

  // The promotion must be deduped against the cold copy — no duplicate hot
  // promotion is created (would be 1 without the fix).
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
  // Distinct from the freshness-gate test in the defer suite: that pre-warms the
  // freshness so the FIRST hasContentHashDedup already returns a hit. Here we
  // isolate the exact race INSIDE a single persistExtraction — a peer advances
  // the durable index AFTER our MISS but BEFORE the authority check. The MISS was
  // read from the pre-rebuild snapshot; the authority check then rebuilds and
  // reports authoritative, but `exactDuplicate` stayed the stale `false`, so the
  // corpus-confirm block was skipped and a duplicate written. The fix re-runs the
  // lookup against the freshly authoritative set.
  const { orchestrator, storage, memoryDir } = await makeDedupOrchestrator();
  const body = "The release train departs every second Thursday at 1500 UTC.";

  // Peer persisted the fact durably through the real path.
  const first = await orchestrator.persistExtraction(factResult(body), storage, null);
  assert.equal(first.length, 1, "peer's initial write persists");

  // Model the race: the first dedup lookup in the NEXT persist reports a stale
  // MISS (captured before the peer flush was visible to this snapshot); the
  // authority check that follows rebuilds from the corpus (which contains the
  // fact) and reports authoritative, so the re-run lookup must catch it.
  const realHas = orchestrator.hasContentHashDedup.bind(orchestrator);
  let calls = 0;
  orchestrator.hasContentHashDedup = async (ts: StorageManager, content: string) => {
    calls += 1;
    if (calls === 1) return false; // stale-snapshot miss
    return realHas(ts, content); // now-authoritative result
  };

  const ids = await orchestrator.persistExtraction(factResult(body), storage, null);
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
  // The orchestrator's category-agnostic removeContentHashForMemory (archival /
  // semantic consolidation) used to mutate only the shared index, leaving the
  // fact-ONLY membership set holding the removed fact's hash. hasFactContentHash
  // reads that set when authoritative, so it returned a stale `true` and
  // wearable / explicit-capture / promotion callers skipped a valid write until
  // the next corpus rebuild.
  const { orchestrator, storage } = await makeDedupOrchestrator();
  const body = "The nightly backup job rotates encryption keys every thirty days.";

  // Register an active fact (shared index + fact-only set).
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

  // Remove via the ORCHESTRATOR coordinator path (what archival uses). It does
  // NOT save, so the durable index fingerprint is unchanged and
  // hasFactContentHash still reads the in-memory fact-only set below.
  await orchestrator.removeContentHashForMemory(storage, memory, "fact-archival");

  assert.equal(
    await storage.hasFactContentHash(body),
    false,
    "the removed fact must not linger in the fact-only membership (stale true without the fix)",
  );
});
