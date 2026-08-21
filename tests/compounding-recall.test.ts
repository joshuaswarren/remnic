import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { CompoundingEngine } from "../src/compounding/engine.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { PluginConfig } from "../src/types.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function buildConfig(memoryDir: string, sharedContextDir: string, overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    ...parseConfig({
      memoryDir,
      sharedContextDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: true,
      continuityAuditEnabled: false,
    }),
    ...overrides,
  };
}

test("compounding recall includes rubric-aware matches for workflow-oriented queries", async () => {
  const memoryDir = tmpDir("engram-compound-recall-mem");
  const sharedDir = tmpDir("engram-compound-recall-shared");
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  await writeFile(
    path.join(sharedDir, "feedback", "inbox.jsonl"),
    [
      JSON.stringify({
        agent: "planner",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "missing evidence window",
        date: "2026-02-25T10:00:00.000Z",
        learning: "Always cite the evidence window in review-loop summaries",
        tags: ["review-loop", "evidence"],
      }),
      JSON.stringify({
        agent: "coder",
        decision: "rejected",
        reason: "Used stale sources",
        date: "2026-02-25T11:00:00.000Z",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  await engine.synthesizeWeekly({ weekId: "2026-W09" });

  const reviewSection = await engine.buildRecallSection("review-loop evidence policy", { maxPatterns: 2, maxRubrics: 2 });
  const zeroRubricsSection = await engine.buildRecallSection("review-loop evidence policy", { maxPatterns: 2, maxRubrics: 0 });

  assert.ok(reviewSection);
  assert.match(reviewSection!, /Avoid repeating these patterns:/);
  assert.match(reviewSection!, /Active rubrics:/);
  assert.match(reviewSection!, /workflow review-loop:/);
  assert.ok(zeroRubricsSection);
  assert.equal(zeroRubricsSection!.includes("Active rubrics:"), false);
});

test("orchestrator keeps rubric-only compounding recall when maxPatterns is zero", async () => {
  const memoryDir = tmpDir("engram-compound-orch-mem");
  const sharedDir = tmpDir("engram-compound-orch-shared");
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  await writeFile(
    path.join(sharedDir, "feedback", "inbox.jsonl"),
    [
      JSON.stringify({
        agent: "planner",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "missing evidence window",
        date: "2026-02-25T10:00:00.000Z",
        learning: "Always cite the evidence window in review-loop summaries",
        tags: ["review-loop", "evidence"],
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const base = buildConfig(memoryDir, sharedDir, {
    sharedContextEnabled: false,
    recallPipeline: [
      { id: "compounding", enabled: true, maxPatterns: 0, maxRubrics: 2 },
    ],
  });
  const orchestrator = new Orchestrator(base);
  await orchestrator.compounding?.synthesizeWeekly({ weekId: "2026-W09" });

  const context = await (orchestrator as any).recallInternal("review-loop evidence policy", "user:test:compounding");

  assert.match(context, /## Institutional Learning \(Compounded\)/);
  assert.equal(context.includes("Avoid repeating these patterns:"), false);
  assert.match(context, /Active rubrics:/);
  assert.match(context, /workflow review-loop:/);
});

test("compounding recall excludes unrelated rubrics when the query has no rubric match", async () => {
  const memoryDir = tmpDir("engram-compound-recall-filter-mem");
  const sharedDir = tmpDir("engram-compound-recall-filter-shared");
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  await writeFile(
    path.join(sharedDir, "feedback", "inbox.jsonl"),
    [
      JSON.stringify({
        agent: "planner",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "missing evidence window",
        date: "2026-02-25T10:00:00.000Z",
        learning: "Always cite the evidence window in review-loop summaries",
        tags: ["review-loop", "evidence"],
      }),
      JSON.stringify({
        agent: "researcher",
        workflow: "citation-audit",
        decision: "approved_with_feedback",
        reason: "missing citations",
        date: "2026-02-25T11:00:00.000Z",
        learning: "Attach citations before shipping citation-audit output",
        tags: ["citations", "audit"],
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  await engine.synthesizeWeekly({ weekId: "2026-W09" });

  const recallSection = await engine.buildRecallSection("review-loop evidence policy", { maxPatterns: 0, maxRubrics: 2 });

  assert.ok(recallSection);
  assert.match(recallSection!, /workflow review-loop:/);
  assert.equal(recallSection!.includes("citation-audit"), false);
});
