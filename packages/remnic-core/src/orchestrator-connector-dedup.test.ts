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
import { mkdtemp, mkdir } from "node:fs/promises";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { ContentHashIndex, StorageManager } from "./storage.js";
import type { ExtractionResult, ExtractedFact, MemoryFile } from "./types.js";
import type { ResolvedScopeProfilePlan } from "./namespaces/scope-profiles.js";

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
