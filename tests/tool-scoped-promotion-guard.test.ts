import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.js";
import type { PluginConfig, ExtractionResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Issue #2183 — tool-scoped global-promotion guard.
//
// A `global`-scoped fact that references a specific tool/command, produced by
// a KNOWN integration (sourceConnector), must NOT be promoted to the shared
// namespace: a different integration exposing a same-named but incompatible
// tool (Pi `search` vs OpenClaw `search`) would otherwise consume it. The guard
// lives in tool-scoped-memory.ts (shouldPromoteGlobalFactToShared) and is
// called from BOTH the pre-judge namespace prediction and the write-loop
// scope-routing block, so the read path and write path agree on the namespace.
//
// The guard has NO separate config knob: it is gated by the SAME
// extractionScopeClassificationEnabled capability as the scope-routing block it
// lives in (the guard only applies to facts the scope classifier tagged
// `global`, so scope classification is both its input domain and its escape
// hatch). These tests assert on the ACTUAL resolved namespace by driving the
// real Orchestrator.persistExtraction and reading each namespace back.
// ---------------------------------------------------------------------------

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// Real, namespaces-enabled config known to drive persistExtraction end to end
// (mirrors tests/identity-namespaces.test.ts). Heavy LLM-backed gates are off.
function baseConfig(memoryDir: string, extra: Record<string, unknown> = {}): PluginConfig {
  return parseConfig({
    openaiApiKey: undefined,
    openaiBaseUrl: undefined,
    model: "gpt-5.5",
    reasoningEffort: "low",
    triggerMode: "smart",
    bufferMaxTurns: 5,
    bufferMaxMinutes: 15,
    consolidateEveryN: 3,
    highSignalPatterns: [],
    maxMemoryTokens: 2000,
    qmdEnabled: false,
    qmdCollection: "openclaw-engram",
    qmdMaxResults: 8,
    qmdTierMigrationEnabled: false,
    qmdTierDemotionMinAgeDays: 30,
    qmdTierDemotionValueThreshold: 0.2,
    qmdTierPromotionValueThreshold: 0.8,
    qmdTierParityGraphEnabled: false,
    qmdTierParityHiMemEnabled: false,
    qmdTierAutoBackfillEnabled: false,
    embeddingFallbackEnabled: false,
    embeddingFallbackProvider: "auto",
    memoryDir,
    debug: false,
    injectQuestions: false,
    commitmentDecayDays: 90,
    workspaceDir: path.join(memoryDir, "workspace"),
    accessTrackingEnabled: false,
    accessTrackingBufferMaxSize: 100,
    recencyWeight: 0.2,
    boostAccessCount: true,
    recordEmptyRecallImpressions: false,
    chunkingEnabled: false,
    contradictionDetectionEnabled: false,
    memoryLinkingEnabled: false,
    threadingEnabled: false,
    summarizationEnabled: false,
    topicExtractionEnabled: false,
    transcriptEnabled: false,
    checkpointEnabled: false,
    compactionResetEnabled: false,
    hourlySummariesEnabled: false,
    conversationIndexEnabled: false,
    recallPlannerEnabled: false,
    tagMemoryEnabled: false,
    qmdDaemonEnabled: false,
    qmdDaemonUrl: undefined,
    factDeduplicationEnabled: false,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    namespacePolicies: [],
    defaultRecallNamespaces: ["self"],
    cronRecallMode: "all",
    cronRecallAllowlist: [],
    autoPromoteToSharedEnabled: false,
    autoPromoteToSharedCategories: ["correction"],
    autoPromoteMinConfidenceTier: "explicit",
    sharedContextEnabled: false,
    graphRecallEnabled: false,
    searchBackend: "qmd",
    lancedbEnabled: false,
    meilisearchEnabled: false,
    oramaEnabled: false,
    slowLogEnabled: false,
    slowLogThresholdMs: 30_000,
    ...extra,
  } as Record<string, unknown>);
}

function globalFact(content: string): ExtractionResult {
  return {
    facts: [{ content, category: "fact", confidence: 0.9, tags: [], scope: "global" }],
    entities: [],
    questions: [],
    profileUpdates: [],
  };
}

const TOOL_FACT = "Prefer the search tool and provide a path when locating code.";
const PORTABLE_FACT = "User prefers dark mode in all editors";

// Stub private background work (qmd maintenance / tier migration) that
// persistExtraction may schedule. Cast through `unknown` because these are
// private members the compiler will not let us name directly.
function stubBackgroundWork(orchestrator: Orchestrator): void {
  const o = orchestrator as unknown as {
    requestQmdMaintenance: () => void;
    runTierMigrationCycle: () => Promise<{ migrated: number }>;
  };
  o.requestQmdMaintenance = () => {};
  o.runTierMigrationCycle = async () => ({ migrated: 0 });
}

// ---------------------------------------------------------------------------
// Promotion-guard integration against the real Orchestrator.persistExtraction
// (scope classification ON — the guard's input domain).
// ---------------------------------------------------------------------------

test("promotion guard: global tool-scoped fact with sourceConnector stays in session namespace", async () => {
  const memoryDir = tmpDir("tool-scoped-guard-with-connector");
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir));
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    await orchestrator.persistExtraction(globalFact(TOOL_FACT), defaultStorage, "thread-1", { sourceConnector: "pi" });

    const sharedMems = await sharedStorage.readAllMemories();
    const defaultMems = await defaultStorage.readAllMemories();
    assert.equal(
      sharedMems.some((m) => m.content?.includes(TOOL_FACT.slice(0, 20))),
      false,
      "tool-scoped global fact must NOT be promoted to the shared namespace",
    );
    assert.ok(
      defaultMems.some((m) => m.content?.includes(TOOL_FACT.slice(0, 20))),
      "tool-scoped global fact must remain in the session (default) namespace",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("promotion guard: same tool-scoped fact WITHOUT sourceConnector is still promoted to shared", async () => {
  const memoryDir = tmpDir("tool-scoped-guard-no-connector");
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir));
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    // No sourceContext → the guard cannot attribute the fact to an integration,
    // so promotion proceeds as before (no regression for unattributed facts).
    await orchestrator.persistExtraction(globalFact(TOOL_FACT), defaultStorage, "thread-1");

    const sharedMems = await sharedStorage.readAllMemories();
    assert.ok(
      sharedMems.some((m) => m.content?.includes(TOOL_FACT.slice(0, 20))),
      "unattributed global fact must still be promoted to the shared namespace",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("promotion guard: portable global fact WITH sourceConnector is still promoted to shared", async () => {
  const memoryDir = tmpDir("tool-scoped-guard-portable");
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir));
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    // sourceConnector is set, but the content is portable knowledge (no tool
    // reference) → the guard does not fire and promotion proceeds.
    await orchestrator.persistExtraction(globalFact(PORTABLE_FACT), defaultStorage, "thread-1", { sourceConnector: "pi" });

    const sharedMems = await sharedStorage.readAllMemories();
    assert.ok(
      sharedMems.some((m) => m.content?.includes(PORTABLE_FACT.slice(0, 20))),
      "portable global fact must still be promoted to the shared namespace",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Capability gate: the guard is inert when extractionScopeClassificationEnabled
// is false (boolean AND CLI string "false"), because scope classification is
// the guard's sole input domain. With it off, NO global fact is promoted —
// tool-scoped and portable facts behave identically.
// ---------------------------------------------------------------------------

test("capability gate: extractionScopeClassificationEnabled=false makes the guard inert", async () => {
  const memoryDir = tmpDir("tool-scoped-guard-scope-off");
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir, { extractionScopeClassificationEnabled: false }));
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    // A tool-scoped global fact + sourceConnector: with scope classification
    // off, the scope-routing block never runs, so the fact is not promoted —
    // the guard has nothing to withhold and adds no behavior of its own.
    await orchestrator.persistExtraction(globalFact(TOOL_FACT), defaultStorage, "thread-1", { sourceConnector: "pi" });
    // A portable global fact: likewise not promoted when scope routing is off.
    await orchestrator.persistExtraction(globalFact(PORTABLE_FACT), defaultStorage, "thread-2", { sourceConnector: "pi" });

    const sharedMems = await sharedStorage.readAllMemories();
    const defaultMems = await defaultStorage.readAllMemories();
    assert.ok(
      defaultMems.some((m) => m.content?.includes(TOOL_FACT.slice(0, 20))),
      "facts must actually be persisted in the session namespace (non-vacuous)",
    );
    assert.equal(
      sharedMems.some((m) => m.content?.includes(TOOL_FACT.slice(0, 20)) || m.content?.includes(PORTABLE_FACT.slice(0, 20))),
      false,
      "with scope classification off, no global fact is promoted to shared (guard inert)",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("capability gate: extractionScopeClassificationEnabled='false' (CLI string) likewise disables scope routing", () => {
  // coerceBool honors the CLI-style string so the capability is off.
  const cfg = parseConfig({ openaiApiKey: "sk-test", extractionScopeClassificationEnabled: "false" });
  assert.equal(cfg.extractionScopeClassificationEnabled, false);
});


// ---------------------------------------------------------------------------
// Auto-promotion path (#2183 follow-up): the post-write promoteMemoryToShared
// call sites (chunked + non-chunked) must honour the SAME tool-scope primitive
// as scope-routing, or autoPromoteToSharedEnabled / a serverShared scope-profile
// target quietly re-leaks a tool-scoped fact into the shared namespace. The
// primitive is applied ONCE inside promoteMemoryToShared, so both call sites are
// covered by construction. These exercise the real Orchestrator.persistExtraction
// and assert on the resolved namespace. scope="project" isolates the auto-promote
// path from scope-routing (which only fires for scope="global").
// ---------------------------------------------------------------------------

function correctionFact(content: string, scope: "project" | "global" = "project"): ExtractionResult {
  return {
    facts: [{ content, category: "correction", confidence: 0.95, tags: [], scope }],
    entities: [],
    questions: [],
    profileUpdates: [],
  };
}

// A procedure that passes validateProcedureExtraction (>=2 steps with intents
// + trigger phrasing "Workflow") and carries tool-bearing steps. The title is
// deliberately portable prose so the guard must rely on procedureSteps.
function procedureResult(content: string, scope: "project" | "global"): ExtractionResult {
  return {
    facts: [
      {
        content,
        category: "procedure",
        confidence: 0.95,
        tags: [],
        scope,
        procedureSteps: [
          { order: 1, intent: "find the symbol", toolCall: { kind: "search", signature: "search('foo')" } },
          { order: 2, intent: "open the file", toolCall: { kind: "read", signature: "read('bar.ts')" } },
        ],
      },
    ],
    entities: [],
    questions: [],
    profileUpdates: [],
  };
}

function autoPromoteConfig(memoryDir: string, extra: Record<string, unknown> = {}): PluginConfig {
  return baseConfig(memoryDir, {
    autoPromoteToSharedEnabled: true,
    autoPromoteToSharedCategories: ["correction"],
    autoPromoteMinConfidenceTier: "explicit",
    ...extra,
  });
}

test("auto-promote: tool-scoped correction fact WITH sourceConnector is NOT auto-promoted to shared (non-chunked)", async () => {
  const memoryDir = tmpDir("tool-scoped-autopromo-withheld");
  try {
    const orchestrator = new Orchestrator(autoPromoteConfig(memoryDir));
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    await orchestrator.persistExtraction(correctionFact(TOOL_FACT), defaultStorage, "thread-1", { sourceConnector: "pi" });

    const sharedMems = await sharedStorage.readAllMemories();
    const defaultMems = await defaultStorage.readAllMemories();
    assert.equal(
      sharedMems.some((m) => m.content?.includes(TOOL_FACT.slice(0, 20))),
      false,
      "tool-scoped fact must NOT be auto-promoted to shared even with autoPromoteToSharedEnabled",
    );
    assert.ok(
      defaultMems.some((m) => m.content?.includes(TOOL_FACT.slice(0, 20))),
      "tool-scoped fact stays in the session namespace",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-promote: same tool-scoped fact WITHOUT sourceConnector still auto-promotes (non-chunked)", async () => {
  const memoryDir = tmpDir("tool-scoped-autopromo-no-connector");
  try {
    const orchestrator = new Orchestrator(autoPromoteConfig(memoryDir));
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    await orchestrator.persistExtraction(correctionFact(TOOL_FACT), defaultStorage, "thread-1");

    const sharedMems = await sharedStorage.readAllMemories();
    assert.ok(
      sharedMems.some((m) => m.content?.includes(TOOL_FACT.slice(0, 20))),
      "unattributed tool-scoped fact still auto-promotes (no regression)",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-promote: portable correction fact WITH sourceConnector still auto-promotes (non-chunked)", async () => {
  const memoryDir = tmpDir("tool-scoped-autopromo-portable");
  try {
    const orchestrator = new Orchestrator(autoPromoteConfig(memoryDir));
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    await orchestrator.persistExtraction(correctionFact(PORTABLE_FACT), defaultStorage, "thread-1", { sourceConnector: "pi" });

    const sharedMems = await sharedStorage.readAllMemories();
    assert.ok(
      sharedMems.some((m) => m.content?.includes(PORTABLE_FACT.slice(0, 20))),
      "portable fact still auto-promotes with a sourceConnector (no regression)",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-promote: chunked path also withholds a tool-scoped fact with sourceConnector", async () => {
  // Force the chunked write branch (the L2379 promoteMemoryToShared call site)
  // so the guard inside promoteMemoryToShared is exercised via that path too.
  const memoryDir = tmpDir("tool-scoped-autopromo-chunked");
  try {
    const orchestrator = new Orchestrator(
      autoPromoteConfig(memoryDir, { chunkingEnabled: true, chunkingTargetTokens: 5, chunkingMinTokens: 1, chunkingOverlapSentences: 0 }),
    );
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    const longToolFact = `${TOOL_FACT} `.repeat(20).trim();
    await orchestrator.persistExtraction(correctionFact(longToolFact), defaultStorage, "thread-1", { sourceConnector: "pi" });

    const sharedMems = await sharedStorage.readAllMemories();
    const defaultMems = await defaultStorage.readAllMemories();
    assert.ok(
      defaultMems.some((m) => m.content?.includes("search")),
      "chunked fact must actually be persisted in the session namespace (non-vacuous)",
    );
    assert.equal(
      sharedMems.some((m) => m.content?.includes("search tool")),
      false,
      "chunked tool-scoped fact must NOT be auto-promoted to shared (chunked call site guarded)",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Structured procedure tool identity (#2183 P2): a procedure with a portable
// title but tool-bearing steps is tool-scoped. The primitive consults
// procedureSteps[].toolCall.kind; promoteMemoryToShared forwards the steps, so
// such a procedure is withheld from the shared namespace on the auto-promote
// path. Procedures cannot flat-auto-promote (autoPromoteToSharedCategories is
// allow-listed to fact|correction|decision|preference), so the meaningful
// coverage is the scope-routing path (scope="global"), with a no-connector
// control proving the procedure still promotes when unattributed.
// ---------------------------------------------------------------------------

test("scope-routing: global procedure with portable title + tool-bearing steps + connector is NOT promoted to shared", async () => {
  // auto-promote is OFF here, so the ONLY promotion path is scope routing
  // (scope="global"). The guard must withhold on this path too, not just via
  // auto-promote — proves shouldPromoteGlobalFactToShared consults procedureSteps.
  const memoryDir = tmpDir("tool-scoped-procedure-scope-routing");
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir));
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    await orchestrator.persistExtraction(procedureResult("Workflow for locating an implementation", "global"), defaultStorage, "thread-1", { sourceConnector: "pi" });

    const sharedMems = await sharedStorage.readAllMemories();
    const defaultMems = await defaultStorage.readAllMemories();
    assert.ok(
      defaultMems.some((m) => m.content?.includes("locating an implementation")),
      "global procedure must actually be persisted in the session namespace (non-vacuous)",
    );
    assert.equal(
      sharedMems.some((m) => m.content?.includes("locating an implementation")),
      false,
      "global procedure with tool-bearing steps must NOT be scope-routed to shared when attributed",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scope-routing: same global procedure WITHOUT sourceConnector is still scope-routed to shared (control)", async () => {
  // Paired control for the scope-routing procedure-withheld test: with no
  // attribution the guard does not withhold, so the global procedure must be
  // scope-routed to shared.
  const memoryDir = tmpDir("tool-scoped-procedure-control-scope-routing");
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir));
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    await orchestrator.persistExtraction(procedureResult("Workflow for locating an implementation", "global"), defaultStorage, "thread-1");

    const sharedMems = await sharedStorage.readAllMemories();
    assert.ok(
      sharedMems.some((m) => m.content?.includes("locating an implementation")),
      "unattributed global procedure must still be scope-routed to shared (control)",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-promote: capability off (extractionScopeClassificationEnabled=false) makes the tool-scope guard inert on the auto-promote path", async () => {
  // Disabling scope classification is the escape hatch: the tool-scope guard
  // must be inert on EVERY path, so a tool-scoped attributed fact auto-promotes
  // again (byte-identical to pre-feature behavior).
  const memoryDir = tmpDir("tool-scoped-autopromo-capoff");
  try {
    const orchestrator = new Orchestrator(
      autoPromoteConfig(memoryDir, { extractionScopeClassificationEnabled: false }),
    );
    stubBackgroundWork(orchestrator);
    const defaultStorage = await orchestrator.getStorageForNamespace("default");
    await defaultStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorageForNamespace("shared");
    await sharedStorage.ensureDirectories();

    await orchestrator.persistExtraction(correctionFact(TOOL_FACT), defaultStorage, "thread-1", { sourceConnector: "pi" });

    const sharedMems = await sharedStorage.readAllMemories();
    assert.ok(
      sharedMems.some((m) => m.content?.includes(TOOL_FACT.slice(0, 20))),
      "with scope classification off, the tool-scope guard is inert and the fact auto-promotes (escape hatch)",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
