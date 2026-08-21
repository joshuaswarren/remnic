import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { CompoundingEngine } from "../src/compounding/engine.js";
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

test("weekly compounding writes rubrics artifact even with no feedback", async () => {
  const memoryDir = tmpDir("engram-compound-weekly-empty-mem");
  const sharedDir = tmpDir("engram-compound-weekly-empty-shared");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  const result = await engine.synthesizeWeekly({ weekId: "2026-W09" });

  const report = await readFile(result.reportPath, "utf-8");
  const reportJson = JSON.parse(await readFile(result.reportJsonPath, "utf-8"));
  const rubrics = await readFile(result.rubricsPath, "utf-8");
  const rubricsIndex = JSON.parse(await readFile(result.rubricsIndexPath, "utf-8"));

  assert.match(report, /## Outcome Weighting/);
  assert.match(report, /\(no action outcomes recorded this week\)/);
  assert.match(rubrics, /^# Compounding Rubrics/m);
  assert.match(rubrics, /## Agent Rubrics/);
  assert.match(rubrics, /## Workflow Rubrics/);
  assert.match(rubrics, /\(none yet\)/);
  assert.equal(reportJson.weekId, "2026-W09");
  assert.equal(reportJson.mistakes.count, 0);
  assert.deepEqual(rubricsIndex.agents, []);
  assert.deepEqual(rubricsIndex.workflows, []);
});

test("weekly report includes provenance references for feedback-derived patterns", async () => {
  const memoryDir = tmpDir("engram-compound-weekly-prov-mem");
  const sharedDir = tmpDir("engram-compound-weekly-prov-shared");
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  const feedbackPath = path.join(sharedDir, "feedback", "inbox.jsonl");
  await writeFile(
    feedbackPath,
    [
      JSON.stringify({
        agent: "agent-a",
        decision: "approved_with_feedback",
        reason: "tighten confidence thresholds",
        date: "2026-02-25T10:00:00.000Z",
        learning: "Include explicit confidence rationale",
      }),
      JSON.stringify({
        agent: "agent-b",
        decision: "rejected",
        reason: "Used stale source",
        date: "2026-02-26T11:00:00.000Z",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  const result = await engine.synthesizeWeekly({ weekId: "2026-W09" });
  const report = await readFile(result.reportPath, "utf-8");
  const reportJson = JSON.parse(await readFile(result.reportJsonPath, "utf-8"));
  const rubrics = await readFile(result.rubricsPath, "utf-8");
  const agentRubric = await readFile(path.join(memoryDir, "compounding", "rubrics", "agents", "agent-a.md"), "utf-8");
  const workflowRubric = await readFile(path.join(memoryDir, "compounding", "rubrics", "workflows", "review-loop.md"), "utf-8").catch(() => "");

  assert.match(report, /## Patterns \(Avoid \/ Prefer\)/);
  assert.match(report, /source: inbox\.jsonl:L1#agent-a-2026-02-25T10:00:00\.000Z-1/);
  assert.match(report, /source: inbox\.jsonl:L2#agent-b-2026-02-26T11:00:00\.000Z-2/);
  assert.match(rubrics, /source: inbox\.jsonl:L1#agent-a-2026-02-25T10:00:00\.000Z-1/);
  assert.equal(reportJson.feedback.count, 2);
  assert.ok(Array.isArray(reportJson.mistakes.registry));
  assert.match(agentRubric, /Agent Rubric — agent-a/);
  assert.equal(workflowRubric.length, 0);
});

test("weekly compounding writes structured json, workflow rubrics, and stable registry recurrence counts", async () => {
  const memoryDir = tmpDir("engram-compound-weekly-json-mem");
  const sharedDir = tmpDir("engram-compound-weekly-json-shared");
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  const feedbackPath = path.join(sharedDir, "feedback", "inbox.jsonl");
  await writeFile(
    feedbackPath,
    [
      JSON.stringify({
        agent: "agent-a",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "tighten confidence thresholds",
        date: "2026-02-25T10:00:00.000Z",
        learning: "Include explicit confidence rationale",
        confidence: 0.8,
        severity: "medium",
        tags: ["confidence", "review"],
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  const first = await engine.synthesizeWeekly({ weekId: "2026-W09" });
  const second = await engine.synthesizeWeekly({ weekId: "2026-W09" });

  const weeklyJson = JSON.parse(await readFile(second.reportJsonPath, "utf-8"));
  const workflowRubric = await readFile(path.join(memoryDir, "compounding", "rubrics", "workflows", "review-loop.md"), "utf-8");
  const mistakes = await engine.readMistakes();

  assert.equal(weeklyJson.feedback.entries[0].workflow, "review-loop");
  assert.deepEqual(weeklyJson.feedback.entries[0].tags, ["confidence", "review"]);
  assert.match(workflowRubric, /Workflow Rubric — review-loop/);
  assert.ok(mistakes);
  assert.equal(mistakes!.registry?.[0]?.recurrenceCount, 1);
  assert.equal(first.reportJsonPath, second.reportJsonPath);
});

test("weekly compounding widens evidence windows across repeated feedback entries", async () => {
  const memoryDir = tmpDir("engram-compound-evidence-window-mem");
  const sharedDir = tmpDir("engram-compound-evidence-window-shared");
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  await writeFile(
    path.join(sharedDir, "feedback", "inbox.jsonl"),
    [
      JSON.stringify({
        agent: "agent-a",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "tighten confidence thresholds",
        date: "2026-02-25T10:00:00.000Z",
        learning: "Include explicit confidence rationale",
        evidenceWindowStart: "2026-02-22T00:00:00.000Z",
        evidenceWindowEnd: "2026-02-25T00:00:00.000Z",
      }),
      JSON.stringify({
        agent: "agent-a",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "tighten confidence thresholds",
        date: "2026-02-26T10:00:00.000Z",
        learning: "Include explicit confidence rationale",
        evidenceWindowStart: "2026-02-20T00:00:00.000Z",
        evidenceWindowEnd: "2026-02-27T00:00:00.000Z",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  await engine.synthesizeWeekly({ weekId: "2026-W09" });
  const mistakes = await engine.readMistakes();

  assert.ok(mistakes);
  assert.equal(mistakes!.registry?.[0]?.evidenceWindow.start, "2026-02-20T00:00:00.000Z");
  assert.equal(mistakes!.registry?.[0]?.evidenceWindow.end, "2026-02-27T00:00:00.000Z");
});

test("rubric provenance stays aligned when repeated feedback reuses the same note", async () => {
  const memoryDir = tmpDir("engram-compound-rubric-prov-mem");
  const sharedDir = tmpDir("engram-compound-rubric-prov-shared");
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  await writeFile(
    path.join(sharedDir, "feedback", "inbox.jsonl"),
    [
      JSON.stringify({
        agent: "agent-a",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "tighten confidence thresholds",
        date: "2026-02-25T10:00:00.000Z",
        learning: "Include explicit confidence rationale",
      }),
      JSON.stringify({
        agent: "agent-a",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "same lesson, later evidence",
        date: "2026-02-26T10:00:00.000Z",
        learning: "Include explicit confidence rationale",
      }),
      JSON.stringify({
        agent: "agent-a",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "add explicit provenance",
        date: "2026-02-27T10:00:00.000Z",
        learning: "Attach evidence window when available",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  const result = await engine.synthesizeWeekly({ weekId: "2026-W09" });
  const rubrics = JSON.parse(await readFile(result.rubricsIndexPath, "utf-8"));
  const reviewLoop = rubrics.workflows.find((entry: { subject: string }) => entry.subject === "review-loop");

  assert.ok(reviewLoop);
  assert.deepEqual(
    reviewLoop.observationEntries,
    [
      {
        note: "Include explicit confidence rationale",
        provenance: [
          "inbox.jsonl:L1#agent-a-2026-02-25T10:00:00.000Z-1",
          "inbox.jsonl:L2#agent-a-2026-02-26T10:00:00.000Z-2",
        ],
      },
      {
        note: "Attach evidence window when available",
        provenance: ["inbox.jsonl:L3#agent-a-2026-02-27T10:00:00.000Z-3"],
      },
    ],
  );

  const rubricsMd = await readFile(result.rubricsPath, "utf-8");
  assert.match(
    rubricsMd,
    /Include explicit confidence rationale _\(source: inbox\.jsonl:L1#agent-a-2026-02-25T10:00:00\.000Z-1, inbox\.jsonl:L2#agent-a-2026-02-26T10:00:00\.000Z-2\)_/,
  );
  assert.match(
    rubricsMd,
    /Attach evidence window when available _\(source: inbox\.jsonl:L3#agent-a-2026-02-27T10:00:00\.000Z-3\)_/,
  );
});

test("rubric artifact file names stay distinct when subjects normalize to the same slug", async () => {
  const memoryDir = tmpDir("engram-compound-rubric-collision-mem");
  const sharedDir = tmpDir("engram-compound-rubric-collision-shared");
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  await writeFile(
    path.join(sharedDir, "feedback", "inbox.jsonl"),
    [
      JSON.stringify({
        agent: "Agent-A",
        decision: "approved_with_feedback",
        reason: "keep the first agent distinct",
        date: "2026-02-25T10:00:00.000Z",
        learning: "Capture evidence before merge",
      }),
      JSON.stringify({
        agent: "agent_a",
        decision: "approved_with_feedback",
        reason: "keep the second agent distinct",
        date: "2026-02-26T10:00:00.000Z",
        learning: "Re-check source freshness before merge",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  await engine.synthesizeWeekly({ weekId: "2026-W09" });

  const agentDir = path.join(memoryDir, "compounding", "rubrics", "agents");
  const agentFiles = (await readdir(agentDir)).filter((name) => name.endsWith(".md")).sort();

  assert.equal(agentFiles.length, 2);
  assert.ok(agentFiles.every((name) => name.startsWith("agent-a")));
  assert.notEqual(agentFiles[0], agentFiles[1]);

  const contents = await Promise.all(agentFiles.map((name) => readFile(path.join(agentDir, name), "utf-8")));
  assert.ok(contents.some((body) => body.includes("Agent Rubric — Agent-A")));
  assert.ok(contents.some((body) => body.includes("Agent Rubric — agent_a")));
});
