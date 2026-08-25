/**
 * recall-state-view-cron-intent.test.ts — issue #2893.
 *
 * Cron recall policy (buildRecallQueryPolicy) normalizes the retrieval
 * query: standard prompts are truncated at maxChars, instruction-heavy
 * prompts are compacted with stop-word removal ("when", "before",
 * "after") plus a token cap. Either path can erase the change-intent
 * signal that gates state views. These regressions pin:
 *
 * 1. Change intent is classified from the ORIGINAL prompt at the recall
 *    entry seam, so a long cron prompt whose intent phrase lies beyond
 *    the normalization cutoff still activates state views.
 * 2. Only the validated boolean flows downstream: retrieval keeps the
 *    normalized query, and the inject seam does not re-classify intent
 *    against it when the per-request flag is threaded.
 * 3. Negative controls: non-change prompts, flag-less calls, and the
 *    legacy config-only path (no threaded flag) keep prior behavior.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { buildRecallQueryPolicy, type RecallQueryPolicyConfig } from "./recall-query-policy.js";
import { resolveRecallStateViewActive } from "./recall-state-view-admission.js";
import { annotateStateView, isChangeOrientedQuery, type StateViewResult } from "./recall-state-view.js";
import { widenRecallStateViews } from "./recall-state-view-widen.js";
import { applyRecallStateViews } from "./recall-state-view-wire.js";
import { Orchestrator } from "./orchestrator.js";
import type { PluginConfig } from "./types.js";

// No change-intent tokens; comfortably longer than the 120-char cutoff.
const FILLER =
  "daily ops digest for platform delivery covering deploy notes on-call handoffs release cadence sprint board columns quota dashboards vendor invoices and rotating shift owners";
const LONG_CHANGE = `${FILLER} plus tell me when did the job title change`;
const LONG_NON_CHANGE = `${FILLER} plus confirm the current job title roster`;
const CRON_KEY = "sess:cron:nightly-digest";
const POLICY_CFG: RecallQueryPolicyConfig = {
  cronRecallPolicyEnabled: true,
  cronRecallNormalizedQueryMaxChars: 120,
  cronRecallInstructionHeavyTokenCap: 8,
  cronConversationRecallMode: "auto",
};

test("fixtures: filler carries no intent and outruns the cutoff", () => {
  assert.ok(FILLER.length >= 120, `filler must exceed maxChars, got ${FILLER.length}`);
  assert.equal(isChangeOrientedQuery(FILLER), false);
  assert.equal(isChangeOrientedQuery(LONG_CHANGE), true);
  assert.equal(isChangeOrientedQuery(LONG_NON_CHANGE), false);
});

test("standard cron truncation erases intent from the normalized query", () => {
  const policy = buildRecallQueryPolicy(LONG_CHANGE, CRON_KEY, POLICY_CFG);
  assert.equal(policy.promptShape, "standard");
  assert.equal(isChangeOrientedQuery(policy.retrievalQuery), false);
  assert.ok(!policy.retrievalQuery.includes("when did"));
});

test("instruction-heavy compaction erases intent from the normalized query", () => {
  const lines = [
    "GOAL: nightly infrastructure digest",
    "OUTPUT FORMAT: markdown summary",
    "TONE RULES: concise operator voice",
    "GROUNDING RULES: cite memory ids",
  ];
  for (let i = 0; i < 10; i += 1) lines.push(`- item-${i} inventory cluster-${i}`);
  for (let i = 0; i < 14; i += 1) lines.push(`vendor ledger panel review segment ${i}`);
  lines.push("finally answer when did the job title change");
  const prompt = lines.join("\n");

  const policy = buildRecallQueryPolicy(prompt, CRON_KEY, POLICY_CFG);
  assert.equal(policy.promptShape, "instruction_heavy");
  assert.equal(isChangeOrientedQuery(prompt), true);
  assert.equal(isChangeOrientedQuery(policy.retrievalQuery), false);
  assert.ok(!policy.retrievalQuery.includes("change"));
});

test("entry seam classifies the ORIGINAL prompt, not the normalized query (#2893)", () => {
  const policy = buildRecallQueryPolicy(LONG_CHANGE, CRON_KEY, POLICY_CFG);
  // Pre-fix shape: classifying the normalized query disables the view.
  assert.equal(resolveRecallStateViewActive({ stateView: true }, {}, policy.retrievalQuery), false);
  // Post-fix contract: the original prompt carries the signal.
  assert.equal(resolveRecallStateViewActive({ stateView: true }, { recallStateViews: false }, LONG_CHANGE), true);
  assert.equal(resolveRecallStateViewActive({}, { recallStateViews: true }, LONG_CHANGE), true);
});

test("negative controls: non-change prompts and flag-less calls stay inactive", () => {
  assert.equal(
    resolveRecallStateViewActive({ stateView: true }, { recallStateViews: true }, LONG_NON_CHANGE),
    false,
  );
  assert.equal(resolveRecallStateViewActive({}, {}, LONG_CHANGE), false);
  assert.equal(
    resolveRecallStateViewActive({ stateView: false }, { recallStateViews: false }, LONG_CHANGE),
    false,
  );
});

test("non-cron sessions keep the original prompt as the retrieval query", () => {
  const policy = buildRecallQueryPolicy(LONG_CHANGE, "sess-interactive", POLICY_CFG);
  assert.equal(policy.retrievalQuery, LONG_CHANGE);
});

function fact(id: string, extra: Partial<StateViewResult> = {}): StateViewResult {
  return { id, ...extra };
}

const CURRENT = fact("new-job", { status: "active" });
const HISTORICAL = fact("old-job", {
  status: "superseded",
  supersededBy: "new-job",
  supersededAt: "2026-03-01",
});

test("threaded flag carries the decision past the normalized query at the inject seam (#2893)", () => {
  const policy = buildRecallQueryPolicy(LONG_CHANGE, CRON_KEY, POLICY_CFG);
  assert.equal(isChangeOrientedQuery(policy.retrievalQuery), false);

  const labeled = widenRecallStateViews([CURRENT], policy.retrievalQuery, { recallStateViews: false }, [HISTORICAL], true);
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel]),
    [
      ["new-job", "current"],
      ["old-job", "historical"],
    ],
  );
  assert.deepEqual(
    applyRecallStateViews([CURRENT, HISTORICAL], policy.retrievalQuery, { recallStateViews: false }, true).map(
      (row) => row.stateLabel,
    ),
    ["current", "historical"],
  );
  assert.deepEqual(
    annotateStateView([CURRENT, HISTORICAL], policy.retrievalQuery, [], {
      enabled: true,
      changeIntent: true,
    }).map((row) => row.stateLabel),
    ["current", "historical"],
  );
});

test("legacy config-only path still re-checks intent against the given query", () => {
  const policy = buildRecallQueryPolicy(LONG_CHANGE, CRON_KEY, POLICY_CFG);
  const input = [CURRENT, HISTORICAL];
  // No threaded flag: config-on alone must not label a non-change query.
  assert.equal(widenRecallStateViews(input, policy.retrievalQuery, { recallStateViews: true }), input);
  assert.equal(applyRecallStateViews(input, policy.retrievalQuery, { recallStateViews: true }), input);
  assert.equal(annotateStateView(input, policy.retrievalQuery, [], { enabled: true }), input);
  assert.equal(input[0]?.stateLabel, undefined);
});

async function makeOrchestrator(
  overrides: Partial<PluginConfig> = {},
): Promise<{ orchestrator: Orchestrator; memoryDir: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-cron-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    multiGraphMemoryEnabled: false,
    entityGraphEnabled: false,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    extractionJudgeEnabled: false,
    temporalSupersessionEnabled: true,
    temporalSupersessionIncludeInRecall: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
    initGateTimeoutMs: 200,
    ...overrides,
  });
  return { orchestrator: new Orchestrator(config), memoryDir };
}

async function writePair(memoryDir: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const factsDir = path.join(memoryDir, "facts", today);
  await mkdir(factsDir, { recursive: true });
  const now = new Date().toISOString();
  const successor = [
    "---",
    "id: sv-new",
    "category: fact",
    `created: ${now}`,
    `updated: ${now}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    "status: active",
    "---",
    "",
    "Current job title: Staff Engineer.",
    "",
  ];
  const predecessor = [
    "---",
    "id: sv-old",
    "category: fact",
    `created: ${now}`,
    `updated: ${now}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    "status: superseded",
    "supersededBy: sv-new",
    "supersededAt: 2026-08-01",
    "---",
    "",
    "Job title history: the job title used to be Senior Engineer.",
    "",
  ];
  await writeFile(path.join(factsDir, "sv-new.md"), `${successor.join("\n")}\n`, "utf-8");
  await writeFile(path.join(factsDir, "sv-old.md"), `${predecessor.join("\n")}\n`, "utf-8");
}

const CRON_E2E_CONFIG: Partial<PluginConfig> = {
  cronRecallPolicyEnabled: true,
  cronRecallNormalizedQueryMaxChars: 120,
};

test("long cron prompt keeps per-call stateView labels when truncation erases intent (#2893)", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator(CRON_E2E_CONFIG);
  try {
    await writePair(memoryDir);
    const out = await orchestrator.recall(LONG_CHANGE, CRON_KEY, { stateView: true });
    assert.ok(
      out.includes("[superseded 2026-08-01 by sv-new]"),
      `cron truncation must not erase the classified intent, got:\n${out}`,
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("e2e negative: long cron prompt without intent stays unlabeled even with the flag", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator(CRON_E2E_CONFIG);
  try {
    await writePair(memoryDir);
    const out = await orchestrator.recall(LONG_NON_CHANGE, CRON_KEY, { stateView: true });
    assert.ok(!out.includes("[superseded "), `non-change prompt must stay filtered, got:\n${out}`);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("e2e negative: long cron prompt with intent stays zero-diff without flags", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator(CRON_E2E_CONFIG);
  try {
    await writePair(memoryDir);
    const out = await orchestrator.recall(LONG_CHANGE, CRON_KEY);
    assert.ok(!out.includes("[superseded "), `no flags must keep the injection byte-identical, got:\n${out}`);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
