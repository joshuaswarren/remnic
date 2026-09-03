import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  resolveCapabilities,
  resolveAccessSetupCapabilities,
  resolveNamespaceCapabilities,
  resolveQmdCapabilities,
  resolveIdentityContinuityCapabilities,
  resolveLocalLlmCapabilities,
  resolveSecurityCapabilities,
  resolveEvalCapabilities,
  resolveUtilityLearningCapabilities,
  resolveObjectiveStateCapabilities,
  resolveCompressionCapabilities,
  resolvePresentationCapabilities,
  resolveConsolidationCapabilities,
  resolveRecallAuxiliaryCapabilities,
  resolveRecallEnhancementCapabilities,
  resolvePipelineProcessingCapabilities,
  resolveConversationContextCapabilities,
  type CapabilitySet,
  type AccessSetupCapabilitySet,
  type NamespaceCapabilitySet,
  type QmdCapabilitySet,
  type IdentityContinuityCapabilitySet,
  type LocalLlmCapabilitySet,
  type SecurityCapabilitySet,
  type EvalCapabilitySet,
  type UtilityLearningCapabilitySet,
  type ObjectiveStateCapabilitySet,
  type CompressionCapabilitySet,
  type PresentationCapabilitySet,
  type ConsolidationCapabilitySet,
  type RecallAuxiliaryCapabilitySet,
  type RecallEnhancementCapabilitySet,
  type PipelineProcessingCapabilitySet,
  type ConversationContextCapabilitySet,
} from "./capabilities.js";

/**
 * Characterization tests for the recall-operation CapabilitySet (issue #1523).
 *
 * These guard against composition drift: every capability field must project
 * from its `<field>Enabled` config flag, so a future edit to
 * `resolveCapabilities` that accidentally maps a field to the wrong flag (the
 * rule-39 gate-divergence class, moved up one layer) fails loudly here.
 */

/**
 * Map of CapabilitySet field → the PluginConfig flag it projects from.
 * Kept explicit (rather than derived by string concat) so the two graph flags
 * with non-`<field>Enabled` names are covered too.
 */
const FIELD_TO_FLAG: Record<keyof CapabilitySet, string> = {
  rerankCache: "rerankCacheEnabled",
  recallDirectAnswer: "recallDirectAnswerEnabled",
  recallMemoryWorthFilter: "recallMemoryWorthFilterEnabled",
  recallTrustScore: "trustScoreEnabled",
  recallMmr: "recallMmrEnabled",
  recallReasoningTraceBoost: "recallReasoningTraceBoostEnabled",
  recallPlannerLlm: "recallPlannerLlmEnabled",
  recallPlanner: "recallPlannerEnabled",
  recallConfidenceGate: "recallConfidenceGateEnabled",
  graphRecall: "graphRecallEnabled",
  graphAssistInFullMode: "graphAssistInFullModeEnabled",
  graphExpandedIntent: "graphExpandedIntentEnabled",
  // Issue #1566 Cluster C: mixed-operation flags.
  rerank: "rerankEnabled",
  harmonicRetrieval: "harmonicRetrievalEnabled",
  parallelRetrieval: "parallelRetrievalEnabled",
};

const FIELDS = Object.keys(FIELD_TO_FLAG) as Array<keyof CapabilitySet>;

test("resolveCapabilities projects every field from its <field>Enabled flag (true variant)", () => {
  // Build a config where every migrated flag is explicitly true.
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveCapabilities(config);

  for (const field of FIELDS) {
    const flag = FIELD_TO_FLAG[field];
    assert.equal(
      caps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `caps.${field} must equal config.${flag} (true variant)`,
    );
    assert.equal(caps[field], true, `caps.${field} should be true here`);
  }
});

test("resolveCapabilities projects every field from its <field>Enabled flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveCapabilities(config);

  for (const field of FIELDS) {
    const flag = FIELD_TO_FLAG[field];
    // The two optional graph flags carry default-when-undefined semantics, but
    // when explicitly set to a concrete boolean the projection must match it.
    assert.equal(
      caps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `caps.${field} must equal config.${flag} (false variant)`,
    );
    assert.equal(caps[field], false, `caps.${field} should be false here`);
  }
});

test("resolveCapabilities preserves optional-flag defaults when the flag is undefined", () => {
  // parseConfig with no overrides exercises the documented defaults. The two
  // optional graph flags encode asymmetric defaults on purpose:
  //   graphAssistInFullModeEnabled → default-ON  (`!== false`)
  //   graphExpandedIntentEnabled    → default-OFF (`=== true`)
  const config = parseConfig({});
  const caps = resolveCapabilities(config);

  assert.equal(
    caps.graphAssistInFullMode,
    config.graphAssistInFullModeEnabled !== false,
    "graphAssistInFullMode must be default-on unless explicitly false",
  );
  assert.equal(
    caps.graphExpandedIntent,
    config.graphExpandedIntentEnabled === true,
    "graphExpandedIntent must be default-off unless explicitly true",
  );
});

test("resolveCapabilities returns a frozen object", () => {
  const caps = resolveCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "CapabilitySet must be frozen");
});

test("resolveCapabilities is deterministic — same config always yields identical gate values (one-resolution-per-op #1523)", () => {
  // The one-resolution-per-op contract (issue #1523): resolve ONCE at the
  // operation entry, thread the frozen result down. This test proves the
  // resolution is deterministic — calling it twice with the same config
  // produces identical values for every gate, so there is never a reason to
  // re-resolve mid-operation.
  const config = parseConfig({
    rerankCacheEnabled: true,
    recallDirectAnswerEnabled: false,
    recallMmrEnabled: true,
    recallPlannerLlmEnabled: true,
    graphRecallEnabled: true,
  });
  const first = resolveCapabilities(config);
  const second = resolveCapabilities(config);
  for (const field of FIELDS) {
    assert.equal(
      first[field],
      second[field],
      `field ${field} must be deterministic across resolutions`,
    );
  }
  // Both must be frozen — a mid-operation mutation would break the contract.
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
});


// ---------------------------------------------------------------------------
// GraphConstructionCapabilitySet — gate-parity tests (issue #1566 Cluster A).
//
// Same invariant as the recall CapabilitySet tests above: every caps field
// must project from its `<field>Enabled` config flag, so a future edit to
// `resolveGraphConstructionCapabilities` that maps a field to the wrong flag
// (or drops the `!== false` default for the optional session-adjacency flag)
// fails loudly here.
//
// Parity contract: a caps-resolved run and a config-derived run MUST produce
// identical boolean values for every gate — on AND off. These tests are the
// executable proof of that contract.
// ---------------------------------------------------------------------------

import {
  resolveGraphConstructionCapabilities,
  type GraphConstructionCapabilitySet,
} from "./capabilities.js";

import {
  resolveMemoryLifecycleCapabilities,
  type MemoryLifecycleCapabilitySet,
} from "./capabilities.js";


const GRAPH_FIELD_TO_FLAG: Record<keyof GraphConstructionCapabilitySet, string> = {
  entityGraph: "entityGraphEnabled",
  timeGraph: "timeGraphEnabled",
  causalGraph: "causalGraphEnabled",
  multiGraphMemory: "multiGraphMemoryEnabled",
  graphWriteSessionAdjacency: "graphWriteSessionAdjacencyEnabled",
};

const GRAPH_FIELDS = Object.keys(GRAPH_FIELD_TO_FLAG) as Array<
  keyof GraphConstructionCapabilitySet
>;

test("resolveGraphConstructionCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(GRAPH_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const graphCaps = resolveGraphConstructionCapabilities(config);

  for (const field of GRAPH_FIELDS) {
    const flag = GRAPH_FIELD_TO_FLAG[field];
    assert.equal(
      graphCaps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `graphCaps.${field} must equal config.${flag} (true variant)`,
    );
    assert.equal(graphCaps[field], true, `graphCaps.${field} should be true here`);
  }
});

test("resolveGraphConstructionCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(GRAPH_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const graphCaps = resolveGraphConstructionCapabilities(config);

  for (const field of GRAPH_FIELDS) {
    const flag = GRAPH_FIELD_TO_FLAG[field];
    assert.equal(
      graphCaps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `graphCaps.${field} must equal config.${flag} (false variant)`,
    );
    assert.equal(graphCaps[field], false, `graphCaps.${field} should be false here`);
  }
});

test("resolveGraphConstructionCapabilities preserves graphWriteSessionAdjacency default-on when undefined", () => {
  // graphWriteSessionAdjacencyEnabled is optional — `!== false` means
  // default-ON. This is the exact semantics the migrated call site used
  // (orchestrator.ts buildGraphEdge), and the parity test below verifies
  // the caps resolver does not drift from it.
  const config = parseConfig({});
  const graphCaps = resolveGraphConstructionCapabilities(config);

  assert.equal(
    graphCaps.graphWriteSessionAdjacency,
    config.graphWriteSessionAdjacencyEnabled !== false,
    "graphWriteSessionAdjacency must be default-on unless explicitly false",
  );
  assert.equal(
    graphCaps.graphWriteSessionAdjacency,
    true,
    "with no explicit override, graphWriteSessionAdjacency should be true",
  );

  // Explicit-false must propagate (not get swallowed by the default).
  const disabled = parseConfig({ graphWriteSessionAdjacencyEnabled: false });
  assert.equal(
    resolveGraphConstructionCapabilities(disabled).graphWriteSessionAdjacency,
    false,
    "explicit false must disable graphWriteSessionAdjacency",
  );
});

test("resolveGraphConstructionCapabilities returns a frozen object", () => {
  const graphCaps = resolveGraphConstructionCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(graphCaps), true, "GraphConstructionCapabilitySet must be frozen");
});

test("resolveGraphConstructionCapabilities matches pre-migration config reads (parity contract)", () => {
  // This is the core parity test: for EVERY combination of the 5 cluster-A
  // flags, the caps-resolved values MUST be identical to what the old
  // scattered `this.config.<flag>Enabled` reads would have produced.
  //
  // We exercise representative combinations rather than the full 2^5 space
  // (32 cases) to keep the test cheap, but we cover:
  //   - all-off (the "no graphs" baseline)
  //   - all-on (the "full graph" mode)
  //   - only entity graph
  //   - multiGraph off but others on (the recall-without-write split)
  //   - session-adjacency undefined vs explicit-false
  const cases: Record<string, Record<string, boolean | undefined>> = {
    "all-off": {
      entityGraphEnabled: false,
      timeGraphEnabled: false,
      causalGraphEnabled: false,
      multiGraphMemoryEnabled: false,
      graphWriteSessionAdjacencyEnabled: false,
    },
    "all-on": {
      entityGraphEnabled: true,
      timeGraphEnabled: true,
      causalGraphEnabled: true,
      multiGraphMemoryEnabled: true,
      graphWriteSessionAdjacencyEnabled: true,
    },
    "entity-only": {
      entityGraphEnabled: true,
      timeGraphEnabled: false,
      causalGraphEnabled: false,
      multiGraphMemoryEnabled: true,
      graphWriteSessionAdjacencyEnabled: true,
    },
    "multigraph-off": {
      entityGraphEnabled: true,
      timeGraphEnabled: true,
      causalGraphEnabled: true,
      multiGraphMemoryEnabled: false,
      graphWriteSessionAdjacencyEnabled: true,
    },
    "session-adj-undefined": {
      entityGraphEnabled: true,
      timeGraphEnabled: true,
      causalGraphEnabled: true,
      multiGraphMemoryEnabled: true,
      // graphWriteSessionAdjacencyEnabled deliberately omitted
    },
  };

  for (const [label, overrides] of Object.entries(cases)) {
    const config = parseConfig(overrides);
    const graphCaps = resolveGraphConstructionCapabilities(config);

    // Parity: each caps field must equal the pre-migration config read.
    // entityGraph/timeGraph/causalGraph/multiGraphMemory used bare reads:
    //   config.entityGraphEnabled  → graphCaps.entityGraph
    // graphWriteSessionAdjacency used `!== false`:
    //   config.graphWriteSessionAdjacencyEnabled !== false  → graphCaps.graphWriteSessionAdjacency
    assert.equal(graphCaps.entityGraph, config.entityGraphEnabled, `[${label}] entityGraph parity`);
    assert.equal(graphCaps.timeGraph, config.timeGraphEnabled, `[${label}] timeGraph parity`);
    assert.equal(graphCaps.causalGraph, config.causalGraphEnabled, `[${label}] causalGraph parity`);
    assert.equal(
      graphCaps.multiGraphMemory,
      config.multiGraphMemoryEnabled,
      `[${label}] multiGraphMemory parity`,
    );
    assert.equal(
      graphCaps.graphWriteSessionAdjacency,
      config.graphWriteSessionAdjacencyEnabled !== false,
      `[${label}] graphWriteSessionAdjacency parity (must match !== false)`,
    );
  }
});


// ---------------------------------------------------------------------------
// MemoryLifecycleCapabilitySet — gate-parity tests (issue #1523 batch 3).
//
// Same invariant as the sets above: every caps field must project from its
// `<field>Enabled` config flag, so a future edit that maps a field to the wrong
// flag fails loudly here. All ten flags are required booleans on PluginConfig
// (defaults resolved at the parse boundary), so the projection is a pure
// passthrough — no optional-default variants needed.
//
// Parity contract: a caps-resolved run and a config-derived run MUST produce
// identical boolean values for every gate — on AND off.
// ---------------------------------------------------------------------------

const LIFECYCLE_FIELD_TO_FLAG: Record<keyof MemoryLifecycleCapabilitySet, string> = {
  temporalSupersession: "temporalSupersessionEnabled",
  temporalMemoryTree: "temporalMemoryTreeEnabled",
  lifecyclePolicy: "lifecyclePolicyEnabled",
  lifecycleFilterStale: "lifecycleFilterStaleEnabled",
  lifecycleMetrics: "lifecycleMetricsEnabled",
  extractionScopeClassification: "extractionScopeClassificationEnabled",
  extractionJudge: "extractionJudgeEnabled",
  extractionDedupe: "extractionDedupeEnabled",
  extractionRetry: "extractionRetryEnabled",
  extractionTelemetryPrefilter: "extractionTelemetryPrefilterEnabled",
  extractionJudgeTelemetry: "extractionJudgeTelemetryEnabled",
  embeddingFallback: "embeddingFallbackEnabled",
  projectionRebuild: "projectionRebuildEnabled",
};

const LIFECYCLE_FIELDS = Object.keys(LIFECYCLE_FIELD_TO_FLAG) as Array<
  keyof MemoryLifecycleCapabilitySet
>;

test("resolveMemoryLifecycleCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(LIFECYCLE_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveMemoryLifecycleCapabilities(config);

  for (const field of LIFECYCLE_FIELDS) {
    const flag = LIFECYCLE_FIELD_TO_FLAG[field];
    assert.equal(
      caps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `caps.${field} must equal config.${flag} (true variant)`,
    );
    assert.equal(caps[field], true, `caps.${field} should be true here`);
  }
});

test("resolveMemoryLifecycleCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(LIFECYCLE_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveMemoryLifecycleCapabilities(config);

  for (const field of LIFECYCLE_FIELDS) {
    const flag = LIFECYCLE_FIELD_TO_FLAG[field];
    assert.equal(
      caps[field],
      (config as unknown as Record<string, boolean>)[flag],
      `caps.${field} must equal config.${flag} (false variant)`,
    );
    assert.equal(caps[field], false, `caps.${field} should be false here`);
  }
});

test("resolveMemoryLifecycleCapabilities returns a frozen object", () => {
  const config = parseConfig({});
  const caps = resolveMemoryLifecycleCapabilities(config);
  assert.equal(Object.isFrozen(caps), true);
});

test("resolveMemoryLifecycleCapabilities matches pre-migration config reads (parity contract)", () => {
  // For representative on/off combinations, the caps-resolved values MUST be
  // identical to what the old scattered `this.config.<flag>Enabled` reads
  // produced. All ten flags used bare reads (no `!== false`/`=== true` at the
  // call site that would change the value — the two sites that wrote
  // `=== true` were redundant coercion on an already-boolean config field),
  // so parity is a direct equality against the resolved config boolean.
  const cases: Record<string, Record<string, boolean>> = {
    "all-off": {
      temporalSupersessionEnabled: false,
      temporalMemoryTreeEnabled: false,
      lifecyclePolicyEnabled: false,
      lifecycleFilterStaleEnabled: false,
      lifecycleMetricsEnabled: false,
      extractionScopeClassificationEnabled: false,
      extractionJudgeEnabled: false,
      extractionDedupeEnabled: false,
      extractionTelemetryPrefilterEnabled: false,
      extractionJudgeTelemetryEnabled: false,
      embeddingFallbackEnabled: false,
    },
    "all-on": {
      temporalSupersessionEnabled: true,
      temporalMemoryTreeEnabled: true,
      lifecyclePolicyEnabled: true,
      lifecycleFilterStaleEnabled: true,
      lifecycleMetricsEnabled: true,
      extractionScopeClassificationEnabled: true,
      extractionJudgeEnabled: true,
      extractionDedupeEnabled: true,
      extractionTelemetryPrefilterEnabled: true,
      extractionJudgeTelemetryEnabled: true,
      embeddingFallbackEnabled: true,
    },
    "temporal-on-rest-off": {
      temporalSupersessionEnabled: true,
      temporalMemoryTreeEnabled: true,
      lifecyclePolicyEnabled: false,
      lifecycleFilterStaleEnabled: false,
      lifecycleMetricsEnabled: false,
      extractionScopeClassificationEnabled: false,
      extractionJudgeEnabled: false,
      extractionDedupeEnabled: false,
      extractionTelemetryPrefilterEnabled: false,
      extractionJudgeTelemetryEnabled: false,
      embeddingFallbackEnabled: false,
    },
    "extraction-on-rest-off": {
      temporalSupersessionEnabled: false,
      temporalMemoryTreeEnabled: false,
      lifecyclePolicyEnabled: false,
      lifecycleFilterStaleEnabled: false,
      lifecycleMetricsEnabled: false,
      extractionScopeClassificationEnabled: true,
      extractionJudgeEnabled: true,
      extractionDedupeEnabled: true,
      extractionTelemetryPrefilterEnabled: true,
      extractionJudgeTelemetryEnabled: true,
      embeddingFallbackEnabled: true,
    },
  };

  for (const [label, overrides] of Object.entries(cases)) {
    const config = parseConfig(overrides);
    const caps = resolveMemoryLifecycleCapabilities(config);

    for (const field of LIFECYCLE_FIELDS) {
      const flag = LIFECYCLE_FIELD_TO_FLAG[field];
      assert.equal(
        caps[field],
        (config as unknown as Record<string, boolean>)[flag],
        `[${label}] caps.${field} must equal config.${flag}`,
      );
    }
  }
});


// ---------------------------------------------------------------------------
// IndexingCapabilitySet — gate-parity tests (issue #1523 batch 4).
//
// Same invariant as the sets above: every caps field must project from its
// `<field>Enabled` config flag. All two flags are required booleans on
// PluginConfig (defaults resolved at the parse boundary), so the projection
// is a pure passthrough.
//
// Parity contract: a caps-resolved run and a config-derived run MUST produce
// identical boolean values for every gate — on AND off.
// ---------------------------------------------------------------------------

import {
  resolveIndexingCapabilities,
  type IndexingCapabilitySet,
} from "./capabilities.js";

const INDEXING_FIELD_TO_FLAG: Record<keyof IndexingCapabilitySet, string> = {
  queryAwareIndexing: "queryAwareIndexingEnabled",
  conversationIndex: "conversationIndexEnabled",
};

const INDEXING_FIELDS = Object.keys(INDEXING_FIELD_TO_FLAG) as Array<
  keyof IndexingCapabilitySet
>;

test("resolveIndexingCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(INDEXING_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveIndexingCapabilities(config);

  for (const field of INDEXING_FIELDS) {
    const flag = INDEXING_FIELD_TO_FLAG[field];
    assert.equal(caps[field], true, `caps.${field} must be true when ${flag}=true`);
  }
});

test("resolveIndexingCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(INDEXING_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveIndexingCapabilities(config);

  for (const field of INDEXING_FIELDS) {
    const flag = INDEXING_FIELD_TO_FLAG[field];
    assert.equal(caps[field], false, `caps.${field} must be false when ${flag}=false`);
  }
});

test("resolveIndexingCapabilities returns a frozen object", () => {
  const config = parseConfig({});
  const caps = resolveIndexingCapabilities(config);
  assert.equal(Object.isFrozen(caps), true);
});

test("resolveIndexingCapabilities matches pre-migration config reads (parity contract)", () => {
  const cases: Record<string, Record<string, boolean>> = {
    "all-off": {
      queryAwareIndexingEnabled: false,
      conversationIndexEnabled: false,
    },
    "all-on": {
      queryAwareIndexingEnabled: true,
      conversationIndexEnabled: true,
    },
    "indexing-on-conv-off": {
      queryAwareIndexingEnabled: true,
      conversationIndexEnabled: false,
    },
    "conv-on-indexing-off": {
      queryAwareIndexingEnabled: false,
      conversationIndexEnabled: true,
    },
  };

  for (const [label, overrides] of Object.entries(cases)) {
    const config = parseConfig(overrides);
    const caps = resolveIndexingCapabilities(config);

    for (const field of INDEXING_FIELDS) {
      const flag = INDEXING_FIELD_TO_FLAG[field];
      assert.equal(
        caps[field],
        (config as unknown as Record<string, boolean>)[flag],
        `[${label}] caps.${field} must equal config.${flag}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// CreationMemoryCapabilitySet — gate-parity tests (issue #1523 batch 4).
// ---------------------------------------------------------------------------

import {
  resolveCreationMemoryCapabilities,
  type CreationMemoryCapabilitySet,
} from "./capabilities.js";

const CREATION_FIELD_TO_FLAG: Record<keyof CreationMemoryCapabilitySet, string> = {
  creationMemory: "creationMemoryEnabled",
  commitmentLedger: "commitmentLedgerEnabled",
  resumeBundles: "resumeBundlesEnabled",
  commitmentLifecycle: "commitmentLifecycleEnabled",
};

const CREATION_FIELDS = Object.keys(CREATION_FIELD_TO_FLAG) as Array<
  keyof CreationMemoryCapabilitySet
>;

test("resolveCreationMemoryCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(CREATION_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveCreationMemoryCapabilities(config);

  for (const field of CREATION_FIELDS) {
    const flag = CREATION_FIELD_TO_FLAG[field];
    assert.equal(caps[field], true, `caps.${field} must be true when ${flag}=true`);
  }
});

test("resolveCreationMemoryCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(CREATION_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveCreationMemoryCapabilities(config);

  for (const field of CREATION_FIELDS) {
    const flag = CREATION_FIELD_TO_FLAG[field];
    assert.equal(caps[field], false, `caps.${field} must be false when ${flag}=false`);
  }
});

test("resolveCreationMemoryCapabilities returns a frozen object", () => {
  const config = parseConfig({});
  const caps = resolveCreationMemoryCapabilities(config);
  assert.equal(Object.isFrozen(caps), true);
});

test("resolveCreationMemoryCapabilities matches pre-migration config reads (parity contract)", () => {
  const cases: Record<string, Record<string, boolean>> = {
    "all-off": {
      creationMemoryEnabled: false,
      commitmentLedgerEnabled: false,
      resumeBundlesEnabled: false,
      commitmentLifecycleEnabled: false,
    },
    "all-on": {
      creationMemoryEnabled: true,
      commitmentLedgerEnabled: true,
      resumeBundlesEnabled: true,
      commitmentLifecycleEnabled: true,
    },
    "creation-on-rest-off": {
      creationMemoryEnabled: true,
      commitmentLedgerEnabled: false,
      resumeBundlesEnabled: false,
      commitmentLifecycleEnabled: false,
    },
    "ledgers-on-rest-off": {
      creationMemoryEnabled: false,
      commitmentLedgerEnabled: true,
      resumeBundlesEnabled: true,
      commitmentLifecycleEnabled: true,
    },
  };

  for (const [label, overrides] of Object.entries(cases)) {
    const config = parseConfig(overrides);
    const caps = resolveCreationMemoryCapabilities(config);

    for (const field of CREATION_FIELDS) {
      const flag = CREATION_FIELD_TO_FLAG[field];
      assert.equal(
        caps[field],
        (config as unknown as Record<string, boolean>)[flag],
        `[${label}] caps.${field} must equal config.${flag}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Namespace capability set parity tests (issue #1523 batch 5).
//
// Guard: resolveNamespaceCapabilities(config).namespaces must always equal
// config.namespacesEnabled. The flag is a non-optional boolean so no default
// coercion is needed.
// ---------------------------------------------------------------------------

test("resolveNamespaceCapabilities: namespaces === config.namespacesEnabled (parity)", () => {
  const cases = [
    { label: "on", overrides: { namespacesEnabled: true } },
    { label: "off", overrides: { namespacesEnabled: false } },
  ];

  for (const { label, overrides } of cases) {
    const config = parseConfig(overrides);
    const caps = resolveNamespaceCapabilities(config);
    assert.equal(
      caps.namespaces,
      config.namespacesEnabled,
      `[${label}] caps.namespaces must equal config.namespacesEnabled`,
    );
  }
});

test("resolveNamespaceCapabilities: result is frozen", () => {
  const config = parseConfig({ namespacesEnabled: true });
  const caps = resolveNamespaceCapabilities(config);
  assert.ok(Object.isFrozen(caps), "NamespaceCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// QmdCapabilitySet — gate-parity tests (issue #1523 batch 6).
//
// Same invariant: every caps field must project from its `<field>Enabled`
// config flag. All twelve flags are required booleans on PluginConfig (defaults
// resolved at the parse boundary), so the projection is pure passthrough.
// ---------------------------------------------------------------------------

const QMD_FIELD_TO_FLAG: Record<keyof QmdCapabilitySet, string> = {
  qmd: "qmdEnabled",
  qmdTierMigration: "qmdTierMigrationEnabled",
  qmdTierAutoBackfill: "qmdTierAutoBackfillEnabled",
  qmdAutoEmbed: "qmdAutoEmbedEnabled",
  qmdMaintenance: "qmdMaintenanceEnabled",
  qmdColdTier: "qmdColdTierEnabled",
  qmdDaemon: "qmdDaemonEnabled",
  qmdTierParityGraph: "qmdTierParityGraphEnabled",
  qmdQueryRerank: "qmdQueryRerankEnabled",
  qmdIntentHints: "qmdIntentHintsEnabled",
  qmdExplain: "qmdExplainEnabled",
  qmdAutoUpgrade: "qmdAutoUpgradeEnabled",
};

const QMD_FIELDS = Object.keys(QMD_FIELD_TO_FLAG) as Array<keyof QmdCapabilitySet>;

test("resolveQmdCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(QMD_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveQmdCapabilities(config);

  for (const field of QMD_FIELDS) {
    const flag = QMD_FIELD_TO_FLAG[field];
    assert.equal(caps[field], true, `caps.${field} must be true when ${flag}=true`);
  }
});

test("resolveQmdCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(QMD_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveQmdCapabilities(config);

  for (const field of QMD_FIELDS) {
    const flag = QMD_FIELD_TO_FLAG[field];
    assert.equal(caps[field], false, `caps.${field} must be false when ${flag}=false`);
  }
});

test("resolveQmdCapabilities returns a frozen object", () => {
  const config = parseConfig({});
  const caps = resolveQmdCapabilities(config);
  assert.equal(Object.isFrozen(caps), true);
});

test("resolveQmdCapabilities matches pre-migration config reads (parity contract)", () => {
  const cases: Record<string, Record<string, boolean>> = {
    "all-off": Object.fromEntries(Object.values(QMD_FIELD_TO_FLAG).map((f) => [f, false])),
    "all-on": Object.fromEntries(Object.values(QMD_FIELD_TO_FLAG).map((f) => [f, true])),
    "qmd-on-rest-off": {
      ...Object.fromEntries(Object.values(QMD_FIELD_TO_FLAG).map((f) => [f, false])),
      qmdEnabled: true,
    },
    "tiers-on-qmd-off": {
      ...Object.fromEntries(Object.values(QMD_FIELD_TO_FLAG).map((f) => [f, false])),
      qmdTierMigrationEnabled: true,
      qmdColdTierEnabled: true,
    },
  };

  for (const [label, overrides] of Object.entries(cases)) {
    const config = parseConfig(overrides);
    const caps = resolveQmdCapabilities(config);

    for (const field of QMD_FIELDS) {
      const flag = QMD_FIELD_TO_FLAG[field];
      assert.equal(
        caps[field],
        (config as unknown as Record<string, boolean>)[flag],
        `[${label}] caps.${field} must equal config.${flag}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// IdentityContinuityCapabilitySet — gate-parity tests (issue #1523 batch 6).
// ---------------------------------------------------------------------------

test("resolveIdentityContinuityCapabilities: identityContinuity === config.identityContinuityEnabled (parity)", () => {
  const cases = [
    { label: "on", overrides: { identityContinuityEnabled: true } },
    { label: "off", overrides: { identityContinuityEnabled: false } },
  ];

  for (const { label, overrides } of cases) {
    const config = parseConfig(overrides);
    const caps = resolveIdentityContinuityCapabilities(config);
    assert.equal(
      caps.identityContinuity,
      config.identityContinuityEnabled,
      `[${label}] caps.identityContinuity must equal config.identityContinuityEnabled`,
    );
  }
});

test("resolveIdentityContinuityCapabilities: result is frozen", () => {
  const config = parseConfig({ identityContinuityEnabled: true });
  const caps = resolveIdentityContinuityCapabilities(config);
  assert.ok(Object.isFrozen(caps), "IdentityContinuityCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// LocalLlmCapabilitySet — gate-parity tests (issue #1523 batch 6).
// ---------------------------------------------------------------------------

test("resolveLocalLlmCapabilities: localLlm === config.localLlmEnabled (parity)", () => {
  const cases = [
    { label: "on", overrides: { localLlmEnabled: true } },
    { label: "off", overrides: { localLlmEnabled: false } },
  ];

  for (const { label, overrides } of cases) {
    const config = parseConfig(overrides);
    const caps = resolveLocalLlmCapabilities(config);
    assert.equal(
      caps.localLlm,
      config.localLlmEnabled,
      `[${label}] caps.localLlm must equal config.localLlmEnabled`,
    );
  }
});

test("resolveLocalLlmCapabilities: result is frozen", () => {
  const config = parseConfig({ localLlmEnabled: true });
  const caps = resolveLocalLlmCapabilities(config);
  assert.ok(Object.isFrozen(caps), "LocalLlmCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// SecurityCapabilitySet — gate-parity tests (issue #1523 batch 7).
// ---------------------------------------------------------------------------

// Boolean-flag parity only: `injectionScreenProfile` is an enum projection
// (#1962), not a gate — its custom->default / named-mode->hardened mapping is
// pinned in config.test.ts.
const SECURITY_FIELD_TO_FLAG: Record<Exclude<keyof SecurityCapabilitySet, "injectionScreenProfile">, string> = {
  trustZones: "trustZonesEnabled",
  quarantinePromotion: "quarantinePromotionEnabled",
  memoryPoisoningDefense: "memoryPoisoningDefenseEnabled",
  originAuthority: "originAuthorityEnabled",
  injectionScreen: "injectionScreenEnabled",
  trustZoneRecall: "trustZoneRecallEnabled",
};

const SECURITY_FIELDS = Object.keys(SECURITY_FIELD_TO_FLAG) as Array<keyof SecurityCapabilitySet>;

test("resolveSecurityCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(SECURITY_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveSecurityCapabilities(config);
  for (const field of SECURITY_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolveSecurityCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(SECURITY_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveSecurityCapabilities(config);
  for (const field of SECURITY_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolveSecurityCapabilities returns a frozen object", () => {
  const caps = resolveSecurityCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "SecurityCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// EvalCapabilitySet — gate-parity tests (issue #1523 batch 7).
// ---------------------------------------------------------------------------

const EVAL_FIELD_TO_FLAG: Record<keyof EvalCapabilitySet, string> = {
  evalHarness: "evalHarnessEnabled",
  evalShadowMode: "evalShadowModeEnabled",
  benchmarkBaselineSnapshots: "benchmarkBaselineSnapshotsEnabled",
  benchmarkDeltaReporter: "benchmarkDeltaReporterEnabled",
  memoryRedTeamBench: "memoryRedTeamBenchEnabled",
};

const EVAL_FIELDS = Object.keys(EVAL_FIELD_TO_FLAG) as Array<keyof EvalCapabilitySet>;

test("resolveEvalCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(EVAL_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveEvalCapabilities(config);
  for (const field of EVAL_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolveEvalCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(EVAL_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveEvalCapabilities(config);
  for (const field of EVAL_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolveEvalCapabilities returns a frozen object", () => {
  const caps = resolveEvalCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "EvalCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// UtilityLearningCapabilitySet — gate-parity tests (issue #1523 batch 7).
// ---------------------------------------------------------------------------

const UTILITY_FIELD_TO_FLAG: Record<keyof UtilityLearningCapabilitySet, string> = {
  memoryUtilityLearning: "memoryUtilityLearningEnabled",
  promotionByOutcome: "promotionByOutcomeEnabled",
};

const UTILITY_FIELDS = Object.keys(UTILITY_FIELD_TO_FLAG) as Array<keyof UtilityLearningCapabilitySet>;

test("resolveUtilityLearningCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(UTILITY_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveUtilityLearningCapabilities(config);
  for (const field of UTILITY_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolveUtilityLearningCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(UTILITY_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveUtilityLearningCapabilities(config);
  for (const field of UTILITY_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolveUtilityLearningCapabilities returns a frozen object", () => {
  const caps = resolveUtilityLearningCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "UtilityLearningCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// ObjectiveStateCapabilitySet — gate-parity tests (issue #1523 batch 7).
// ---------------------------------------------------------------------------

const OBJECTIVE_FIELD_TO_FLAG: Record<keyof ObjectiveStateCapabilitySet, string> = {
  objectiveStateMemory: "objectiveStateMemoryEnabled",
  objectiveStateSnapshotWrites: "objectiveStateSnapshotWritesEnabled",
  objectiveStateRecall: "objectiveStateRecallEnabled",
};

const OBJECTIVE_FIELDS = Object.keys(OBJECTIVE_FIELD_TO_FLAG) as Array<keyof ObjectiveStateCapabilitySet>;

test("resolveObjectiveStateCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(OBJECTIVE_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveObjectiveStateCapabilities(config);
  for (const field of OBJECTIVE_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolveObjectiveStateCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(OBJECTIVE_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveObjectiveStateCapabilities(config);
  for (const field of OBJECTIVE_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolveObjectiveStateCapabilities returns a frozen object", () => {
  const caps = resolveObjectiveStateCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "ObjectiveStateCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// CompressionCapabilitySet — gate-parity tests (issue #1523 batch 7).
// ---------------------------------------------------------------------------

const COMPRESSION_FIELD_TO_FLAG: Record<keyof CompressionCapabilitySet, string> = {
  compressionGuidelineLearning: "compressionGuidelineLearningEnabled",
  compressionGuidelineSemanticRefinement: "compressionGuidelineSemanticRefinementEnabled",
  contextCompressionActions: "contextCompressionActionsEnabled",
};

const COMPRESSION_FIELDS = Object.keys(COMPRESSION_FIELD_TO_FLAG) as Array<keyof CompressionCapabilitySet>;

test("resolveCompressionCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(COMPRESSION_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveCompressionCapabilities(config);
  for (const field of COMPRESSION_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolveCompressionCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(COMPRESSION_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveCompressionCapabilities(config);
  for (const field of COMPRESSION_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolveCompressionCapabilities returns a frozen object", () => {
  const caps = resolveCompressionCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "CompressionCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// PresentationCapabilitySet — gate-parity tests (issue #1523 batch 8).
// ---------------------------------------------------------------------------

const PRESENTATION_FIELD_TO_FLAG: Record<keyof PresentationCapabilitySet, string> = {
  verbatimArtifacts: "verbatimArtifactsEnabled",
  memoryBoxes: "memoryBoxesEnabled",
  bufferSurpriseTrigger: "bufferSurpriseTriggerEnabled",
  threading: "threadingEnabled",
  episodeNoteMode: "episodeNoteModeEnabled",
  transcript: "transcriptEnabled",
  entitySummary: "entitySummaryEnabled",
};

const PRESENTATION_FIELDS = Object.keys(PRESENTATION_FIELD_TO_FLAG) as Array<keyof PresentationCapabilitySet>;

test("resolvePresentationCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(PRESENTATION_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolvePresentationCapabilities(config);
  for (const field of PRESENTATION_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolvePresentationCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(PRESENTATION_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolvePresentationCapabilities(config);
  for (const field of PRESENTATION_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolvePresentationCapabilities returns a frozen object", () => {
  const caps = resolvePresentationCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "PresentationCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// ConsolidationCapabilitySet — gate-parity tests (issue #1523 batch 8).
// ---------------------------------------------------------------------------

const CONSOLIDATION_FIELD_TO_FLAG: Record<keyof ConsolidationCapabilitySet, string> = {
  compoundingSemantic: "compoundingSemanticEnabled",
  abstractionAnchors: "abstractionAnchorsEnabled",
  compounding: "compoundingEnabled",
  calibration: "calibrationEnabled",
  semanticConsolidation: "semanticConsolidationEnabled",
  patternReinforcement: "patternReinforcementEnabled",
  continuityAudit: "continuityAuditEnabled",
  graphEdgeDecay: "graphEdgeDecayEnabled",
};

const CONSOLIDATION_FIELDS = Object.keys(CONSOLIDATION_FIELD_TO_FLAG) as Array<keyof ConsolidationCapabilitySet>;

test("resolveConsolidationCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(CONSOLIDATION_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveConsolidationCapabilities(config);
  for (const field of CONSOLIDATION_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolveConsolidationCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(CONSOLIDATION_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveConsolidationCapabilities(config);
  for (const field of CONSOLIDATION_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolveConsolidationCapabilities returns a frozen object", () => {
  const caps = resolveConsolidationCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "ConsolidationCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// RecallAuxiliaryCapabilitySet — gate-parity tests (issue #1523 batch 8).
// ---------------------------------------------------------------------------

const RECALL_AUX_FIELD_TO_FLAG: Record<keyof RecallAuxiliaryCapabilitySet, string> = {
  causalRuleExtraction: "causalRuleExtractionEnabled",
  correction: "correctionEnabled",
  continuityIncidentLogging: "continuityIncidentLoggingEnabled",
  daySummary: "daySummaryEnabled",
  versioning: "versioningEnabled",
  verifiedRecall: "verifiedRecallEnabled",
  semanticRuleVerification: "semanticRuleVerificationEnabled",
  workProductRecall: "workProductRecallEnabled",
  secureStore: "secureStoreEnabled",
  knowledgeIndex: "knowledgeIndexEnabled",
  factDeduplication: "factDeduplicationEnabled",
  compactionReset: "compactionResetEnabled",
  entityRetrieval: "entityRetrievalEnabled",
  cronRecallPolicy: "cronRecallPolicyEnabled",
};

const RECALL_AUX_FIELDS = Object.keys(RECALL_AUX_FIELD_TO_FLAG) as Array<keyof RecallAuxiliaryCapabilitySet>;

test("resolveRecallAuxiliaryCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(RECALL_AUX_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveRecallAuxiliaryCapabilities(config);
  for (const field of RECALL_AUX_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolveRecallAuxiliaryCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(RECALL_AUX_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveRecallAuxiliaryCapabilities(config);
  for (const field of RECALL_AUX_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolveRecallAuxiliaryCapabilities returns a frozen object", () => {
  const caps = resolveRecallAuxiliaryCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "RecallAuxiliaryCapabilitySet must be frozen");
});


// ---------------------------------------------------------------------------
// RecallEnhancementCapabilitySet — gate-parity tests (issue #1523 batch 9).
// ---------------------------------------------------------------------------

const RECALL_ENH_FIELD_TO_FLAG: Record<keyof RecallEnhancementCapabilitySet, string> = {
  explicitCueRecall: "explicitCueRecallEnabled",
  targetedFactRecall: "targetedFactRecallEnabled",
  focusedListRecall: "focusedListRecallEnabled",
  responseGuidanceRecall: "responseGuidanceRecallEnabled",
  eventOrderRecall: "eventOrderRecallEnabled",
  reinforcementRecallBoost: "reinforcementRecallBoostEnabled",
  recallPlannerTelemetry: "recallPlannerTelemetryEnabled",
  peerProfileRecall: "peerProfileRecallEnabled",
  graphAssistShadowEval: "graphAssistShadowEvalEnabled",
  memoryReconstruction: "memoryReconstructionEnabled",
  memoryLinking: "memoryLinkingEnabled",
  causalTrajectoryRecall: "causalTrajectoryRecallEnabled",
  causalTrajectoryMemory: "causalTrajectoryMemoryEnabled",
  cmcRetrieval: "cmcRetrievalEnabled",
  contradictionDetection: "contradictionDetectionEnabled",
  factArchival: "factArchivalEnabled",
  entityRelationships: "entityRelationshipsEnabled",
  entityActivityLog: "entityActivityLogEnabled",
  compoundingInject: "compoundingInjectEnabled",
  accessTracking: "accessTrackingEnabled",
  autoPromoteToShared: "autoPromoteToSharedEnabled",
  feedback: "feedbackEnabled",
  identity: "identityEnabled",
};

const RECALL_ENH_FIELDS = Object.keys(RECALL_ENH_FIELD_TO_FLAG) as Array<keyof RecallEnhancementCapabilitySet>;

test("resolveRecallEnhancementCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(RECALL_ENH_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveRecallEnhancementCapabilities(config);
  for (const field of RECALL_ENH_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolveRecallEnhancementCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(RECALL_ENH_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveRecallEnhancementCapabilities(config);
  for (const field of RECALL_ENH_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolveRecallEnhancementCapabilities returns a frozen object", () => {
  const caps = resolveRecallEnhancementCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "RecallEnhancementCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// PipelineProcessingCapabilitySet — gate-parity tests (issue #1523 batch 9).
// ---------------------------------------------------------------------------

const PIPELINE_FIELD_TO_FLAG: Record<keyof PipelineProcessingCapabilitySet, string> = {
  chunking: "chunkingEnabled",
  semanticChunking: "semanticChunkingEnabled",
  semanticDedup: "semanticDedupEnabled",
  summarization: "summarizationEnabled",
  topicExtraction: "topicExtractionEnabled",
  sessionObserver: "sessionObserverEnabled",
  profiling: "profilingEnabled",
  checkpoint: "checkpointEnabled",
  traceWeaver: "traceWeaverEnabled",
  routingRules: "routingRulesEnabled",
  inlineSourceAttribution: "inlineSourceAttributionEnabled",
  negativeExamples: "negativeExamplesEnabled",
  hourlySummaries: "hourlySummariesEnabled",
  lcm: "lcmEnabled",
  localLlmFast: "localLlmFastEnabled",
  proactiveExtraction: "proactiveExtractionEnabled",
  sourceGrounding: "extractionSourceGroundingEnabled",
  delinearize: "delinearizeEnabled",
  slowLog: "slowLogEnabled",
  hostEmbeddingProvider: "hostEmbeddingProviderEnabled",
  memoryExtensions: "memoryExtensionsEnabled",
  hourlySummariesExtended: "hourlySummariesExtendedEnabled",
};

const PIPELINE_FIELDS = Object.keys(PIPELINE_FIELD_TO_FLAG) as Array<keyof PipelineProcessingCapabilitySet>;

test("resolvePipelineProcessingCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(PIPELINE_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolvePipelineProcessingCapabilities(config);
  for (const field of PIPELINE_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolvePipelineProcessingCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(PIPELINE_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolvePipelineProcessingCapabilities(config);
  for (const field of PIPELINE_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolvePipelineProcessingCapabilities returns a frozen object", () => {
  const caps = resolvePipelineProcessingCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "PipelineProcessingCapabilitySet must be frozen");
});

// ---------------------------------------------------------------------------
// ConversationContextCapabilitySet — gate-parity tests (issue #1523 batch 9).
// ---------------------------------------------------------------------------

const CONV_CTX_FIELD_TO_FLAG: Record<keyof ConversationContextCapabilitySet, string> = {
  sharedContext: "sharedContextEnabled",
  intentRouting: "intentRoutingEnabled",
  crossSignalsSemantic: "crossSignalsSemanticEnabled",
  sharedCrossSignalSemantic: "sharedCrossSignalSemanticEnabled",
  operatorAwareConsolidation: "operatorAwareConsolidationEnabled",
  peerProfileReasoner: "peerProfileReasonerEnabled",
  cmcConsolidation: "cmcConsolidationEnabled",
  maintenanceNamespaceFanout: "maintenanceNamespaceFanoutEnabled",
  citations: "citationsEnabled",
  semanticRulePromotion: "semanticRulePromotionEnabled",
  codexMarketplace: "codexMarketplaceEnabled",
};

const CONV_CTX_FIELDS = Object.keys(CONV_CTX_FIELD_TO_FLAG) as Array<keyof ConversationContextCapabilitySet>;

test("resolveConversationContextCapabilities projects every field from its flag (true variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(CONV_CTX_FIELD_TO_FLAG)) overrides[flag] = true;
  const config = parseConfig(overrides);
  const caps = resolveConversationContextCapabilities(config);
  for (const field of CONV_CTX_FIELDS) {
    assert.equal(caps[field], true, `${field} must be true`);
  }
});

test("resolveConversationContextCapabilities projects every field from its flag (false variant)", () => {
  const overrides: Record<string, boolean> = {};
  for (const flag of Object.values(CONV_CTX_FIELD_TO_FLAG)) overrides[flag] = false;
  const config = parseConfig(overrides);
  const caps = resolveConversationContextCapabilities(config);
  for (const field of CONV_CTX_FIELDS) {
    assert.equal(caps[field], false, `${field} must be false`);
  }
});

test("resolveConversationContextCapabilities returns a frozen object", () => {
  const caps = resolveConversationContextCapabilities(parseConfig({}));
  assert.equal(Object.isFrozen(caps), true, "ConversationContextCapabilitySet must be frozen");
});
