/**
 * recall-state-view-asof.test.ts — issue #1952 historical-pinned state views.
 *
 * Proves an `asOf` recall before the successor's validity keeps the
 * predecessor: the inject seam must not discard a predecessor merely
 * because its successor is absent under the same pin, and a valid asOf
 * result is never emptied. Pinned after the successor's validity, the
 * same corpus returns the successor instead.
 *
 * Pre-fix bug: publishRecallResults annotated without the pin, so the
 * "superseded never appears without its successor" contract dropped the
 * predecessor at the seam and the valid historical snapshot rendered
 * empty.
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

async function makeOrchestrator(
  overrides: Partial<PluginConfig> = {},
): Promise<{ orchestrator: Orchestrator; memoryDir: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-asof-"));
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
 * Write the supersession pair with explicit validity windows: the
 * successor (`sv-new`) becomes valid one hour after the pin, and the
 * predecessor (`sv-old`) is superseded at that same instant. At the pin
 * the predecessor is the live fact; the successor is not yet valid.
 */
async function writeTimedPair(memoryDir: string): Promise<{ pin: string; afterFlip: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const factsDir = path.join(memoryDir, "facts", today);
  await mkdir(factsDir, { recursive: true });
  const now = Date.now();
  const pin = new Date(now + 60_000).toISOString();
  const flipAt = new Date(now + 3_600_000).toISOString();
  const afterFlip = new Date(now + 3_660_000).toISOString();
  const successor = [
    "---",
    "id: sv-new",
    "category: fact",
    `created: ${new Date(now).toISOString()}`,
    `updated: ${new Date(now).toISOString()}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    "status: active",
    `validAt: ${flipAt}`,
    "---",
    "",
    "Current job title: Staff Engineer.",
    "",
  ];
  const predecessor = [
    "---",
    "id: sv-old",
    "category: fact",
    `created: ${new Date(now).toISOString()}`,
    `updated: ${new Date(now).toISOString()}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    "status: superseded",
    "supersededBy: sv-new",
    `supersededAt: ${flipAt}`,
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
  return { pin, afterFlip };
}

test("asOf before the successor's validity keeps the predecessor and never empties the snapshot (#1952)", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator();
  try {
    const { pin } = await writeTimedPair(memoryDir);
    const out = await orchestrator.recall(QUERY, "sess-sv-asof-before", {
      stateView: true,
      asOf: pin,
      xrayCapture: true,
    });
    assert.ok(out.length > 0, "a valid asOf result must never be emptied");
    assert.ok(
      out.includes("Senior Engineer"),
      `the pin-valid predecessor must survive the state-view seam, got:\n${out}`,
    );
    assert.ok(
      !out.includes("Staff Engineer"),
      `the successor is not yet valid at the pin and must stay filtered, got:\n${out}`,
    );
    assert.ok(
      !out.includes("[superseded "),
      `a predecessor current at the snapshot renders unlabeled, got:\n${out}`,
    );
    const snapshot = orchestrator.getLastXraySnapshot();
    assert.ok(snapshot, "X-ray snapshot must be captured");
    const labels = (snapshot!.results ?? [])
      .map((r) => r.stateView)
      .filter((label) => label !== undefined);
    assert.deepEqual(
      labels,
      ["current"],
      `X-ray must label the pin-valid predecessor current-at-snapshot, got: ${JSON.stringify(labels)}`,
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("asOf after the successor's validity returns the successor instead (#1952)", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator();
  try {
    const { afterFlip } = await writeTimedPair(memoryDir);
    const out = await orchestrator.recall(QUERY, "sess-sv-asof-after", {
      stateView: true,
      asOf: afterFlip,
    });
    assert.ok(
      out.includes("Staff Engineer"),
      `after the flip the successor is the valid fact, got:\n${out}`,
    );
    assert.ok(
      !out.includes("Senior Engineer"),
      `after the flip the predecessor's interval has ended, got:\n${out}`,
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
