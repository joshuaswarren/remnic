import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import type { EngramTraceEvent, MemoryFile } from "../src/types.js";

async function makeOrchestrator(prefix: string): Promise<Orchestrator> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
  });
  return new Orchestrator(cfg);
}

function expectedPolicyVersion(orchestrator: Orchestrator): string {
  const cfg = orchestrator.config;
  return createHash("sha256")
    .update(
      JSON.stringify({
        recencyWeight: cfg.recencyWeight,
        lifecyclePromoteHeatThreshold: cfg.lifecyclePromoteHeatThreshold,
        lifecycleStaleDecayThreshold: Math.min(cfg.lifecycleStaleDecayThreshold, cfg.lifecycleArchiveDecayThreshold),
        cronRecallInstructionHeavyTokenCap: cfg.cronRecallInstructionHeavyTokenCap,
        utilityRankingBoostMultiplier: 1,
        utilityRankingSuppressMultiplier: 1,
        utilityPromoteThresholdDelta: 0,
        utilityDemoteThresholdDelta: 0,
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

test("recall telemetry emits for no_recall short-circuit", async () => {
  const orchestrator = await makeOrchestrator("engram-telemetry-no-recall-");
  const events: EngramTraceEvent[] = [];
  const previous = (globalThis as any).__openclawEngramTrace;
  (globalThis as any).__openclawEngramTrace = (event: EngramTraceEvent) => events.push(event);

  try {
    const out = await (orchestrator as any).recallInternal("ok", "user:test:no-recall");
    assert.equal(out, "");
  } finally {
    (globalThis as any).__openclawEngramTrace = previous;
  }

  const recallEvent = events.find((e) => e.kind === "recall_summary");
  assert.ok(recallEvent);
  assert.equal(recallEvent.recallMode, "no_recall");
  assert.equal(recallEvent.source, "none");
  assert.equal(recallEvent.recalledMemoryCount, 0);
  assert.equal(recallEvent.injected, false);
  assert.equal(typeof recallEvent.policyVersion, "string");
  assert.equal((recallEvent.policyVersion ?? "").length, 12);
  assert.equal(recallEvent.policyVersion, expectedPolicyVersion(orchestrator));
  assert.equal(recallEvent.identityInjectionMode, "none");
  assert.equal(recallEvent.identityInjectedChars, 0);
  assert.equal(recallEvent.identityInjectionTruncated, false);
});

test("recall telemetry emits source/count for recent-scan fallback", async () => {
  const orchestrator = await makeOrchestrator("engram-telemetry-recent-");
  const now = new Date().toISOString();
  const mockMemory: MemoryFile = {
    path: "/tmp/facts/2026-02-24/fact-telemetry.md",
    content: "We set API rate limit to 1000 requests per minute.",
    frontmatter: {
      id: "fact-telemetry",
      category: "fact",
      created: now,
      updated: now,
      source: "extraction",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: ["api", "limits"],
      status: "active",
    },
  };

  (orchestrator as any).readAllMemoriesForNamespaces = async () => [mockMemory];
  (orchestrator as any).boostSearchResults = async (results: any[]) => results;

  const events: EngramTraceEvent[] = [];
  const previous = (globalThis as any).__openclawEngramTrace;
  (globalThis as any).__openclawEngramTrace = (event: EngramTraceEvent) => events.push(event);

  try {
    const out = await (orchestrator as any).recallInternal(
      "What did we decide about API rate limits?",
      "user:test:recent",
    );
    assert.match(out, /Recent Memories/);
  } finally {
    (globalThis as any).__openclawEngramTrace = previous;
  }

  const recallEvent = events.find((e) => e.kind === "recall_summary");
  assert.ok(recallEvent);
  assert.equal(recallEvent.source, "recent_scan");
  assert.equal(recallEvent.recalledMemoryCount, 1);
  assert.equal(recallEvent.injected, true);
  assert.equal(typeof recallEvent.policyVersion, "string");
  assert.equal((recallEvent.policyVersion ?? "").length, 12);
  assert.equal(recallEvent.policyVersion, expectedPolicyVersion(orchestrator));
});
