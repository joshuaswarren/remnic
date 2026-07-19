import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PluginConfig } from "../src/types.js";
import { NamespaceStorageRouter } from "../src/namespaces/storage.js";
import { keyring, secureStoreDir } from "../src/secure-store/index.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function baseConfig(memoryDir: string): PluginConfig {
  return {
    openaiApiKey: undefined,
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
    memoryDir,
    debug: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    identityInjectionMode: "recovery_only",
    identityMaxInjectChars: 1200,
    continuityIncidentLoggingEnabled: false,
    continuityAuditEnabled: false,
    injectQuestions: false,
    commitmentDecayDays: 90,
    workspaceDir: path.join(memoryDir, "workspace"),
    accessTrackingEnabled: false,
    accessTrackingBufferMaxSize: 100,
    recencyWeight: 0.2,
    boostAccessCount: true,
    recordEmptyRecallImpressions: false,
    queryExpansionEnabled: false,
    queryExpansionMaxQueries: 4,
    queryExpansionMinTokenLen: 3,
    rerankEnabled: false,
    rerankProvider: "local",
    rerankMaxCandidates: 10,
    rerankTimeoutMs: 1000,
    rerankCacheEnabled: true,
    rerankCacheTtlMs: 1000,
    feedbackEnabled: false,
    negativeExamplesEnabled: false,
    negativeExamplesPenaltyPerHit: 0.05,
    negativeExamplesPenaltyCap: 0.25,
    chunkingEnabled: false,
    chunkingTargetTokens: 200,
    chunkingMinTokens: 150,
    chunkingOverlapSentences: 2,
    contradictionDetectionEnabled: false,
    contradictionSimilarityThreshold: 0.7,
    contradictionMinConfidence: 0.9,
    contradictionAutoResolve: true,
    memoryLinkingEnabled: false,
    threadingEnabled: false,
    threadingGapMinutes: 30,
    summarizationEnabled: false,
    summarizationTriggerCount: 1000,
    summarizationRecentToKeep: 300,
    summarizationImportanceThreshold: 0.3,
    summarizationProtectedTags: [],
    topicExtractionEnabled: false,
    topicExtractionTopN: 50,
    transcriptEnabled: false,
    transcriptRetentionDays: 7,
    transcriptSkipChannelTypes: ["cron"],
    transcriptRecallHours: 12,
    maxTranscriptTurns: 50,
    maxTranscriptTokens: 1000,
    checkpointEnabled: false,
    checkpointTurns: 15,
    hourlySummariesEnabled: false,
    hourlySummaryCronAutoRegister: false,
    summaryRecallHours: 24,
    maxSummaryCount: 6,
    summaryModel: "gpt-5.5",
    hourlySummariesExtendedEnabled: false,
    hourlySummariesIncludeToolStats: false,
    hourlySummariesIncludeSystemMessages: false,
    hourlySummariesMaxTurnsPerRun: 60,
    conversationIndexEnabled: false,
    conversationIndexBackend: "qmd",
    conversationIndexQmdCollection: "openclaw-engram-convo",
    conversationIndexRetentionDays: 14,
    conversationRecallTopK: 3,
    conversationRecallMaxChars: 2000,
    conversationRecallTimeoutMs: 500,
    localLlmEnabled: false,
    localLlmUrl: "http://localhost:1234/v1",
    localLlmModel: "local-model",
    localLlmFallback: true,
    localLlmTimeoutMs: 1000,
    slowLogEnabled: false,
    slowLogThresholdMs: 30_000,
    extractionDedupeEnabled: true,
    extractionDedupeWindowMs: 60_000,
    extractionMinChars: 20,
    extractionMinUserTurns: 1,
    extractionMaxTurnChars: 4000,
    extractionMaxFactsPerRun: 12,
    extractionMaxEntitiesPerRun: 6,
    extractionMaxQuestionsPerRun: 3,
    extractionMaxProfileUpdatesPerRun: 4,
    consolidationRequireNonZeroExtraction: true,
    consolidationMinIntervalMs: 60_000,
    qmdMaintenanceEnabled: true,
    qmdMaintenanceDebounceMs: 500,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 60_000,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 50,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 10_000,
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
    sharedContextDir: undefined,
    sharedContextMaxInjectChars: 4000,
    crossSignalsSemanticEnabled: false,
    crossSignalsSemanticTimeoutMs: 1000,
    compoundingEnabled: false,
    compoundingWeeklyCronEnabled: false,
    compoundingSemanticEnabled: false,
    compoundingSynthesisTimeoutMs: 1000,
    compoundingInjectEnabled: false,
  };
}

test("v3 namespaces router uses legacy memoryDir for default namespace if namespaced dir missing", async () => {
  const memoryDir = tmpDir("engram-ns-router");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  const router = new NamespaceStorageRouter(cfg);

  const s = await router.storageFor("default");
  await s.ensureDirectories();
  await s.writeProfile("# Profile\n\n- Legacy root\n");

  const legacyProfile = await readFile(path.join(memoryDir, "profile.md"), "utf-8");
  assert.match(legacyProfile, /Legacy root/);
});

test("v3 namespaces router uses namespaced dir when it exists before first resolve", async () => {
  const memoryDir = tmpDir("engram-ns-router2");
  const nsDir = path.join(memoryDir, "namespaces", "default");
  await mkdir(nsDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  const router = new NamespaceStorageRouter(cfg);

  const s = await router.storageFor("default");
  await s.ensureDirectories();
  await s.writeProfile("# Profile\n\n- Namespaced\n");

  const namespacedProfile = await readFile(path.join(nsDir, "profile.md"), "utf-8");
  assert.match(namespacedProfile, /Namespaced/);
});

test("v3 namespaces router refreshes default storage when namespaced dir appears", async () => {
  const memoryDir = tmpDir("engram-ns-router-refresh");
  const nsDir = path.join(memoryDir, "namespaces", "default");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  const router = new NamespaceStorageRouter(cfg);

  const legacyStorage = await router.storageFor("default");
  assert.equal(legacyStorage.dir, memoryDir);

  await mkdir(nsDir, { recursive: true });

  const namespacedStorage = await router.storageFor("default");
  assert.equal(namespacedStorage.dir, nsDir);
  assert.notEqual(namespacedStorage, legacyStorage);
});

test("v3 namespaces router keeps default storage at legacy root when legacy data exists", async () => {
  const memoryDir = tmpDir("engram-ns-router-legacy-refresh");
  const nsDir = path.join(memoryDir, "namespaces", "default");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  const router = new NamespaceStorageRouter(cfg);

  const legacyStorage = await router.storageFor("default");
  await legacyStorage.ensureDirectories();
  await legacyStorage.writeProfile("# Profile\n\n- Legacy root\n");
  await mkdir(nsDir, { recursive: true });

  const refreshedStorage = await router.storageFor("default");
  assert.equal(refreshedStorage.dir, memoryDir);
  assert.equal(refreshedStorage, legacyStorage);
});

test("v3 namespaces router propagates custom entity schemas to routed storage managers", async () => {
  const memoryDir = tmpDir("engram-ns-router-schemas");
  await mkdir(path.join(memoryDir, "entities"), { recursive: true });

  const cfg = baseConfig(memoryDir);
  cfg.entitySchemas = {
    person: {
      sections: [{ key: "principles", title: "Principles", description: "" }],
    },
  };

  const router = new NamespaceStorageRouter(cfg);
  const storage = await router.storageFor("default");
  const canonical = "person-alice-example";
  await writeFile(
    path.join(memoryDir, "entities", `${canonical}.md`),
    [
      "# Alice Example",
      "",
      "**Type:** person",
      "",
      "## Principles",
      "",
      "- Alice Example documents operating principles explicitly.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const entities = await storage.readAllEntityFiles();

  assert.equal(entities.length, 1);
  assert.deepEqual(entities[0]?.structuredSections, [
    {
      key: "principles",
      title: "Principles",
      facts: ["Alice Example documents operating principles explicitly."],
    },
  ]);
});

// ── Round 7 (cursor Medium — NCNL2): the resolve hook must fire only ONCE per
// (namespace, storageDir). Recall/extraction call `storageFor` repeatedly; firing
// onResolve (→ catalog loadCompacted + append) on every cache hit grows the log
// without bound between rebuilds. A steady-state cache hit must be a hook no-op.
test("storageFor fires the resolve hook once per (namespace, dir), not on every cache hit", async () => {
  const memoryDir = tmpDir("ns-router-resolve-dedup");
  const cfg = baseConfig(memoryDir);
  const resolves: Array<{ ns: string; dir: string }> = [];
  const router = new NamespaceStorageRouter(cfg, {
    onResolve: (ns, dir) => {
      resolves.push({ ns, dir });
    },
  });

  // First resolve fires the hook; subsequent cache hits for the same dir do not.
  const a = await router.storageFor("default");
  const b = await router.storageFor("default");
  const c = await router.storageFor("default");
  assert.equal(a, b, "cache hit returns the same StorageManager");
  assert.equal(b, c, "cache hit returns the same StorageManager");
  assert.equal(
    resolves.filter((r) => r.ns === "default").length,
    1,
    "onResolve must fire exactly once for repeated cache hits on the same namespace/dir",
  );
});

// ── Round 7 (cursor Medium — ND3EJ): a FAILED resolve-hook registration must not
// be permanently suppressed by the dedup. If the first hook invocation rejects
// (e.g. catalog append dropped on a rebuild-lock timeout), a later cache hit must
// RETRY the hook rather than skip it forever.
test("storageFor retries the resolve hook after a failed registration", async () => {
  const memoryDir = tmpDir("ns-router-resolve-retry");
  const cfg = baseConfig(memoryDir);
  let calls = 0;
  const router = new NamespaceStorageRouter(cfg, {
    onResolve: async () => {
      calls += 1;
      if (calls === 1) throw new Error("first registration dropped");
      // Subsequent calls succeed.
    },
  });

  // First resolve fires the hook, which REJECTS — dedup must not be recorded.
  await router.storageFor("default");
  await new Promise((r) => setTimeout(r, 10)); // let the rejection settle
  // A later cache hit must RE-FIRE the hook (retry) since the first failed.
  await router.storageFor("default");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls >= 2, "a failed registration must be retried on the next resolve");

  // Once a hook succeeds, further cache hits are deduped (no unbounded growth).
  const callsAfterSuccess = calls;
  await router.storageFor("default");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    calls,
    callsAfterSuccess,
    "after a successful registration, further cache hits are deduped",
  );
});

// ── Round 7 (codex P2 — NEFoX): a resolve hook that RESOLVES TO `false` (a
// dropped/no-op registration — e.g. the catalog touch returned without appending
// under a rebuild-lock timeout) must NOT be marked notified, so a later cache hit
// retries it. A `false` result is distinct from a thrown/rejected failure.
test("storageFor retries a resolve hook that resolves to false (dropped registration)", async () => {
  const memoryDir = tmpDir("ns-router-resolve-false");
  const cfg = baseConfig(memoryDir);
  let calls = 0;
  const router = new NamespaceStorageRouter(cfg, {
    onResolve: async () => {
      calls += 1;
      // First two registrations are DROPPED (false); the third persists (true).
      return calls >= 3;
    },
  });

  await router.storageFor("default");
  await new Promise((r) => setTimeout(r, 10));
  await router.storageFor("default");
  await new Promise((r) => setTimeout(r, 10));
  await router.storageFor("default");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls >= 3, "a registration resolving to false must be retried, not suppressed");

  // After the persisted (true) result, further cache hits are deduped.
  const callsAfterPersist = calls;
  await router.storageFor("default");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    calls,
    callsAfterPersist,
    "after a persisted registration (true), further cache hits are deduped",
  );
});

test("router installs the unlocked secure-store key on router-created stores so recovery paths see an unlocked store (#2033)", async () => {
  const memoryDir = tmpDir("engram-ns-router-secure");
  await mkdir(memoryDir, { recursive: true });
  const storeId = secureStoreDir(memoryDir);
  // Operator unlocked: the process-local keyring holds the root key. Router
  // stores must pick it up — the orchestrator keys only its primary storage.
  keyring.unlock(storeId, Buffer.alloc(32, 6));
  try {
    const cfg: PluginConfig = {
      ...baseConfig(memoryDir),
      secureStoreEnabled: true,
      secureStoreEncryptOnWrite: true,
    };
    const router = new NamespaceStorageRouter(cfg);

    const defaultStore = await router.storageFor("default");
    assert.equal(
      defaultStore.isSecureStoreUnlocked(),
      true,
      "router-created default store picks up the unlocked keyring key",
    );
    // The secure store is one key per memory ROOT, so a per-namespace child store
    // keys off the same root id and is also unlocked.
    const childStore = await router.storageFor("project-x");
    assert.equal(
      childStore.isSecureStoreUnlocked(),
      true,
      "router-created namespace store is unlocked from the root key too",
    );
  } finally {
    keyring.lock(storeId);
  }

  // Keyring locked (no key registered): the store is marked required but stays
  // locked — it must NOT silently fall back to plaintext.
  const lockedRouter = new NamespaceStorageRouter({
    ...baseConfig(memoryDir),
    secureStoreEnabled: true,
    secureStoreEncryptOnWrite: true,
  });
  const lockedStore = await lockedRouter.storageFor("default");
  assert.equal(
    lockedStore.isSecureStoreUnlocked(),
    false,
    "no key in the keyring → router store stays locked, never silently plaintext",
  );
});
