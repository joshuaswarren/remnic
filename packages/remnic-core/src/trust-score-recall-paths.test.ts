/**
 * trust-score-recall-paths.test.ts — issue #1577 integration tests.
 *
 * Proves the rule-41 parity fix: TrustScore runs on EVERY recall path, not
 * just the hot-QMD path. With QMD disabled (so recall falls through to the
 * recent-memory-scan / embedding-fallback branch) and trustScoreEnabled ON,
 * recall still produces a per-path trust map that reaches the X-ray snapshot.
 *
 * This pins the HIGH review gap: before the fix, the cold / embedding / recent
 * paths skipped TrustScore entirely, so recallTrustByPath stayed null and the
 * X-ray + publisher quarantine filtering never saw trust data on those paths.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";

async function makeOrchestrator(
  overrides: Partial<PluginConfig> = {},
): Promise<{ orchestrator: Orchestrator; memoryDir: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-trust-paths-"));
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
    temporalSupersessionEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
    trustScoreEnabled: true,
    initGateTimeoutMs: 200,
    ...overrides,
  });
  const orchestrator = new Orchestrator(config);
  return { orchestrator, memoryDir };
}

/**
 * Write a fact file directly into the default-namespace storage dir with the
 * given extra frontmatter lines (mw_success / mw_fail / faithfulness). Mirrors
 * the memory-worth-frontmatter test helper so we control trust signals without
 * going through the extraction pipeline.
 */
async function writeFact(
  memoryDir: string,
  body: string,
  extraFrontmatterLines: string[] = [],
  updatedAt = new Date().toISOString(),
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    "---",
    `id: ${id}`,
    "category: fact",
    `created: ${new Date().toISOString()}`,
    `updated: ${updatedAt}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    ...extraFrontmatterLines,
    "---",
  ];
  const factsDir = path.join(memoryDir, "facts", today);
  await mkdir(factsDir, { recursive: true });
  await writeFile(path.join(factsDir, `${id}.md`), `${lines.join("\n")}\n\n${body}\n`, "utf-8");
  return id;
}

test("TrustScore runs on the recent-scan path: trust map reaches the X-ray snapshot (#1577)", async (t) => {
  // QMD disabled → recall falls through to the recent-memory-scan branch.
  // trustScoreEnabled ON → applyTrustScoreToBranch must score the recent
  // candidates and populate recallTrustByPath, which the X-ray capture reads.
  const { orchestrator, memoryDir } = await makeOrchestrator();
  try {
    await writeFact(memoryDir, "High-trust fact: production DB uses pgBouncer.", [
      "mw_success: 10",
      "mw_fail: 0",
    ]);
    await writeFact(memoryDir, "Low-trust fact: the cache never invalidates.", [
      "mw_success: 0",
      "mw_fail: 10",
    ]);
    await orchestrator.recall("database connection pooling", "sess-trust-paths", {
      xrayCapture: true,
    });
    const snapshot = orchestrator.getLastXraySnapshot();
    assert.ok(snapshot, "X-ray snapshot must be captured");
    const withTrust = (snapshot!.results ?? []).filter((r) => r.trust !== undefined);
    // At least one recalled result carries a trust projection → the recent-scan
    // path populated recallTrustByPath and the capture read it back. Before the
    // fix, recallTrustByPath was null on this path so NO result had trust.
    assert.ok(
      withTrust.length > 0,
      "recent-scan path must surface trust projections (rule 41 parity)",
    );
    // Each trust projection is well-formed (cloneResult preserved it).
    for (const r of withTrust) {
      assert.ok(typeof r.trust!.score === "number", "trust.score is a number");
      assert.ok(
        r.trust!.band === "high" || r.trust!.band === "medium" || r.trust!.band === "low" || r.trust!.band === "quarantine",
        "trust.band is a valid band",
      );
    }
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("TrustScore quarantine excludes a contradicted memory from injection but surfaces it in X-ray (#1577)", async (t) => {
  // A faithfulness-contradicted memory is a hard negative: it must be excluded
  // from the injected set (publishRecallResults filters it) BUT appear in the
  // X-ray snapshot with its quarantine reason (rule 34 — exclusion must never
  // look like "no result"). This proves the trust map flows to BOTH consumers.
  const { orchestrator, memoryDir } = await makeOrchestrator();
  try {
    const goodId = await writeFact(memoryDir, "Verified fact: the API port is 8080.", [
      "mw_success: 5",
      "mw_fail: 0",
    ]);
    const badId = await writeFact(memoryDir, "Contradicted fact: the API port is 9000.", [
      'faithfulness: {"verdict":"contradicted"}',
    ]);
    await orchestrator.recall("API port", "sess-trust-quarantine", {
      xrayCapture: true,
    });
    const snapshot = orchestrator.getLastXraySnapshot();
    assert.ok(snapshot, "X-ray snapshot captured");
    const results = snapshot!.results ?? [];
    const quarantined = results.find(
      (r) => r.trust?.quarantined === true,
    );
    assert.ok(quarantined, "a quarantined result must appear in the X-ray snapshot (rule 34)");
    assert.ok(
      typeof quarantined!.trust!.quarantineReason === "string" && quarantined!.trust!.quarantineReason.length > 0,
      "quarantined result carries a human-readable reason",
    );
    assert.ok(
      snapshot!.appliedResults.some((result) => result.memoryId === goodId),
      "the applied witness includes the memory that reached published recall",
    );
    assert.equal(
      snapshot!.appliedResults.some((result) => result.memoryId === badId),
      false,
      "the applied witness excludes a candidate removed before the result-limit partition",
    );
    assert.equal(
      snapshot!.headroomResults.some((result) => result.memoryId === badId),
      false,
      "the headroom witness excludes quarantined candidates",
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("X-ray capture preserves recent-scan serving while recording post-trust applied and pre-trust headroom", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator({
    qmdMaxResults: 2,
  });
  const now = Date.now();
  try {
    const tailId = await writeFact(
      memoryDir,
      "Parity recall token: stable tail candidate.",
      ["mw_success: 5", "mw_fail: 0"],
      new Date(now - 3_000).toISOString(),
    );
    const quarantinedId = await writeFact(
      memoryDir,
      "Parity recall token: contradicted applied candidate.",
      ['faithfulness: {"verdict":"contradicted"}'],
      new Date(now - 2_000).toISOString(),
    );
    const servedId = await writeFact(
      memoryDir,
      "Parity recall token: verified served candidate.",
      ["mw_success: 5", "mw_fail: 0"],
      new Date(now - 1_000).toISOString(),
    );

    const withoutCapture = await orchestrator.recall(
      "parity recall token",
      "sess-trust-parity",
      { mode: "full" },
    );
    const withCapture = await orchestrator.recall(
      "parity recall token",
      "sess-trust-parity",
      { mode: "full", xrayCapture: true },
    );
    const snapshot = orchestrator.getLastXraySnapshot();

    assert.equal(withCapture, withoutCapture);
    assert.match(withCapture, /verified served candidate/);
    assert.doesNotMatch(withCapture, /contradicted applied candidate|stable tail candidate/);
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.appliedResults.map((result) => result.memoryId),
      [servedId],
    );
    assert.deepEqual(
      snapshot.headroomResults.map((result) => result.memoryId),
      [tailId],
    );
    assert.equal(
      snapshot.appliedResults.some((result) => result.memoryId === quarantinedId),
      false,
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
