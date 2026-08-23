/**
 * recall-state-view-call.test.ts — issue #1952 per-call wiring.
 *
 * Proves the per-call `stateView` boolean carries through the FINAL
 * annotation (publish inject seam + X-ray capture) on a fallback recall
 * path, even when the global `recallStateViews` flag is false. QMD and
 * embedding fallback are disabled so recall settles on the recent-scan
 * branch — the same "every fallback path" guarantee the trust-map
 * parity tests pin (#1577).
 *
 * Pre-fix bug: recallInternal computed an effective per-request flag
 * (options.stateView OR config) for admission, but publishRecallResults
 * and the X-ray annotator reread `config.recallStateViews` directly, so
 * per-call true + global false admitted the superseded row upstream and
 * then dropped its label/prefix at the inject seam.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import type { PluginConfig } from "./types.js";

const QUERY = "when did the job title change";
const PREFIX = "[superseded 2026-08-01 by sv-new]";

async function makeOrchestrator(
  overrides: Partial<PluginConfig> = {},
): Promise<{ orchestrator: Orchestrator; memoryDir: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-call-"));
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

/**
 * Write the supersession pair directly into the facts dir: an active
 * successor (sv-new) and a superseded predecessor (sv-old) pointing at
 * it. temporalSupersession is ON with includeInRecall=false, so sv-old
 * reaches the candidate pool ONLY when a state view is active.
 */
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
  await writeFile(
    path.join(factsDir, "sv-new.md"),
    `${successor.join("\n")}\n`,
    "utf-8",
  );
  await writeFile(
    path.join(factsDir, "sv-old.md"),
    `${predecessor.join("\n")}\n`,
    "utf-8",
  );
}

test("per-call stateView=true labels the fallback-path injection and X-ray even when the global flag is false (#1952)", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator();
  try {
    await writePair(memoryDir);
    const out = await orchestrator.recall(QUERY, "sess-sv-call-true", {
      stateView: true,
      xrayCapture: true,
    });
    assert.ok(
      out.includes(PREFIX),
      `per-call true + global false must render the historical prefix, got:\n${out}`,
    );
    const snapshot = orchestrator.getLastXraySnapshot();
    assert.ok(snapshot, "X-ray snapshot must be captured");
    const labels = (snapshot!.results ?? [])
      .map((r) => r.stateView)
      .filter((label) => label !== undefined);
    assert.ok(
      labels.includes("historical") && labels.includes("current"),
      `X-ray must carry stateView labels through the per-call flag, got: ${JSON.stringify(labels)}`,
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("precedence is OR: per-call stateView=false never disables a global recallStateViews=true (#1952)", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator({
    recallStateViews: true,
  });
  try {
    await writePair(memoryDir);
    const out = await orchestrator.recall(QUERY, "sess-sv-call-false", {
      stateView: false,
    });
    assert.ok(
      out.includes(PREFIX),
      `call false + global true must still label (documented OR semantics), got:\n${out}`,
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("default stays zero-diff: no flags, no labels, no prefix (#1952)", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator();
  try {
    await writePair(memoryDir);
    const out = await orchestrator.recall(QUERY, "sess-sv-call-off");
    assert.ok(
      !out.includes("[superseded "),
      `no flags must keep the injection byte-identical (superseded row stays filtered), got:\n${out}`,
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
