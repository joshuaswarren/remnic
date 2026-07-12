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
import { ContentHashIndex, type StorageManager } from "./storage.js";
import type { ExtractionResult, ExtractedFact, MemoryFile } from "./types.js";
import type { ResolvedScopeProfilePlan } from "./namespaces/scope-profiles.js";

// ---------------------------------------------------------------------------
// Types — minimal surface of Orchestrator needed by these tests.
// persistExtraction is private; cast through unknown to reach it without `any`.
// ---------------------------------------------------------------------------

/** Source-context shape accepted by persistExtraction (connector subset). */
interface TestSourceContext {
  sourceConnector?: string;
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
