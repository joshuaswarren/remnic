import test from "node:test";
import assert from "node:assert/strict";
import {
  hasIdentityRecoveryIntent,
  resolveEffectiveIdentityInjectionMode,
  resolveEffectiveRecallMode,
  resolveRecallModeDecisionAsync,
} from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import type { FallbackLlmClient } from "../src/fallback-llm.js";
import type { RecallPlanMode } from "../src/types.js";

function stubPlannerLlm(mode: RecallPlanMode, reason = "stub"): FallbackLlmClient {
  return {
    isAvailable: () => true,
    parseWithSchemaDetailed: async (
      _messages: unknown,
      schema: { parse: (v: unknown) => unknown },
    ) => ({ result: schema.parse({ mode, reason }), modelUsed: "test/model" }),
  } as unknown as FallbackLlmClient;
}

test("resolveEffectiveRecallMode downgrades graph_mode to full when graph recall is disabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: true,
    graphRecallEnabled: false,
    multiGraphMemoryEnabled: true,
    prompt: "what happened in the timeline",
  });
  assert.equal(mode, "full");
});

test("resolveEffectiveRecallMode downgrades graph_mode to full when graph memory is disabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: false,
    prompt: "show the chain of events",
  });
  assert.equal(mode, "full");
});

test("resolveEffectiveRecallMode keeps graph_mode when both graph flags are enabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    prompt: "what happened in the timeline",
  });
  assert.equal(mode, "graph_mode");
});

test("resolveEffectiveRecallMode keeps baseline behavior when planner is disabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: false,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    prompt: "what happened in the timeline",
  });
  assert.equal(mode, "full");
});

test("resolveEffectiveRecallMode broad intent can escalate to graph_mode when enabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    graphExpandedIntentEnabled: true,
    prompt: "How did we get here with recall regressions?",
  });
  assert.equal(mode, "graph_mode");
});

// --- LLM recall planning (issue #1367 / Option C) ---

test("resolveRecallModeDecisionAsync uses heuristic when LLM planning is not opted in", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: false });
  const decision = await resolveRecallModeDecisionAsync({
    plannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    prompt: "restart the gateway",
    config,
    llm: stubPlannerLlm("graph_mode"),
  });
  // LLM stub says graph_mode, but it must not be consulted.
  assert.equal(decision.effectiveMode, "minimal");
  assert.equal(decision.plannerSource, undefined);
});

test("resolveRecallModeDecisionAsync applies the LLM classification when opted in", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true });
  const decision = await resolveRecallModeDecisionAsync({
    plannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    prompt: "restart the gateway",
    config,
    llm: stubPlannerLlm("graph_mode", "wants history"),
  });
  assert.equal(decision.effectiveMode, "graph_mode");
  assert.equal(decision.plannedMode, "graph_mode");
  assert.equal(decision.plannerSource, "llm");
  assert.equal(decision.plannerReason, "wants history");
  // The heuristic baseline is preserved distinctly from the LLM's choice so
  // telemetry can compare them (cursor review on PR #1428): "restart the
  // gateway" → heuristic "minimal", LLM → "graph_mode".
  assert.equal(decision.plannerHeuristicMode, "minimal");
  assert.notEqual(decision.plannerHeuristicMode, decision.plannedMode);
});

test("resolveRecallModeDecisionAsync gates an LLM graph_mode to full when graph recall is disabled (gotcha #39)", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true });
  const decision = await resolveRecallModeDecisionAsync({
    plannerEnabled: true,
    graphRecallEnabled: false,
    multiGraphMemoryEnabled: true,
    prompt: "restart the gateway",
    config,
    llm: stubPlannerLlm("graph_mode"),
  });
  // Same graph gating as the heuristic path.
  assert.equal(decision.plannedMode, "graph_mode");
  assert.equal(decision.effectiveMode, "full");
  assert.equal(decision.graphReason, "graph recall disabled by config");
});

test("resolveRecallModeDecisionAsync shadow mode keeps the heuristic effective decision", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true, recallPlannerShadowMode: true });
  const decision = await resolveRecallModeDecisionAsync({
    plannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    prompt: "restart the gateway", // heuristic → minimal
    config,
    llm: stubPlannerLlm("graph_mode"),
  });
  // Effective stays on the heuristic; the LLM's choice is recorded for comparison.
  assert.equal(decision.effectiveMode, "minimal");
  assert.equal(decision.shadowLlmMode, "graph_mode");
  assert.match(decision.plannerReason ?? "", /^shadow:/);
});

test("resolveRecallModeDecisionAsync skips the LLM entirely when the planner is disabled", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true });
  let called = false;
  const llm = {
    isAvailable: () => {
      called = true;
      return true;
    },
    parseWithSchemaDetailed: async () => {
      called = true;
      return null;
    },
  } as unknown as FallbackLlmClient;
  const decision = await resolveRecallModeDecisionAsync({
    plannerEnabled: false,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    prompt: "what happened in the timeline",
    config,
    llm,
  });
  assert.equal(decision.effectiveMode, "full");
  assert.equal(called, false, "planner disabled → LLM must not be consulted");
});

test("hasIdentityRecoveryIntent detects recovery/continuity phrasing", () => {
  assert.equal(hasIdentityRecoveryIntent("We need continuity recovery right now"), true);
  assert.equal(hasIdentityRecoveryIntent("run the lint check"), false);
});

test("resolveEffectiveIdentityInjectionMode gates recovery_only when no explicit intent", () => {
  const result = resolveEffectiveIdentityInjectionMode({
    configuredMode: "recovery_only",
    recallMode: "full",
    prompt: "what did we decide for API retries?",
  });
  assert.deepEqual(result, { mode: "recovery_only", shouldInject: false });
});

test("resolveEffectiveIdentityInjectionMode allows recovery_only when explicit intent is present", () => {
  const result = resolveEffectiveIdentityInjectionMode({
    configuredMode: "recovery_only",
    recallMode: "full",
    prompt: "identity continuity drift happened again, recover the anchor",
  });
  assert.deepEqual(result, { mode: "recovery_only", shouldInject: true });
});

test("resolveEffectiveIdentityInjectionMode downgrades full to minimal under minimal recall mode", () => {
  const result = resolveEffectiveIdentityInjectionMode({
    configuredMode: "full",
    recallMode: "minimal",
    prompt: "reload gateway",
  });
  assert.deepEqual(result, { mode: "minimal", shouldInject: true });
});
