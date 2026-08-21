import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { SharedContextManager } from "../src/shared-context/manager.js";

function isoForDate(date: string, time: string): Date {
  return new Date(`${date}T${time}Z`);
}

async function buildManager(prefix: string) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-memory-`));
  const sharedDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-shared-`));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    sharedContextEnabled: true,
    sharedContextDir: sharedDir,
  });
  const manager = new SharedContextManager(config);
  await manager.ensureStructure();
  return { manager, memoryDir, sharedDir };
}

test("shared-context cross-signals handles empty day", async () => {
  const { manager, memoryDir, sharedDir } = await buildManager("engram-shared-empty");
  try {
    const date = "2026-02-28";
    const result = await manager.curateDaily({ date });
    const raw = JSON.parse(await readFile(result.crossSignalsPath, "utf-8"));
    const crossSignalsMarkdown = await readFile(result.crossSignalsMarkdownPath, "utf-8");
    const roundtable = await readFile(result.roundtablePath, "utf-8");

    assert.equal(raw.date, date);
    assert.equal(raw.sourceCount, 0);
    assert.equal(raw.feedbackCount, 0);
    assert.deepEqual(raw.overlaps, []);
    assert.match(crossSignalsMarkdown, /# Cross-Signals/);
    assert.match(crossSignalsMarkdown, /No multi-agent topic overlap detected/);
    assert.match(roundtable, /No multi-agent topic overlap detected/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});

test("shared-context cross-signals handles single-source day without overlap", async () => {
  const { manager, memoryDir, sharedDir } = await buildManager("engram-shared-single");
  try {
    const date = "2026-03-01";
    await manager.writeAgentOutput({
      agentId: "generalist",
      title: "Checkout reliability pass",
      content: "Reduced checkout timeout retries for stability.",
      createdAt: isoForDate(date, "10:00:00"),
    });

    const result = await manager.curateDaily({ date });
    const raw = JSON.parse(await readFile(result.crossSignalsPath, "utf-8"));

    assert.equal(raw.sourceCount, 1);
    assert.equal(raw.overlaps.length, 0);
    assert.equal(result.overlapCount, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});

test("shared-context cross-signals ignores YAML frontmatter boilerplate for overlaps", async () => {
  const { manager, memoryDir, sharedDir } = await buildManager("engram-shared-frontmatter");
  try {
    const date = "2026-03-03";
    await manager.writeAgentOutput({
      agentId: "generalist",
      title: "Alpha topic unique",
      content: "saturn venus mercury jupiter",
      createdAt: isoForDate(date, "08:00:00"),
    });
    await manager.writeAgentOutput({
      agentId: "oracle",
      title: "Beta thread distinct",
      content: "otter falcon lynx badger",
      createdAt: isoForDate(date, "08:05:00"),
    });

    const result = await manager.curateDaily({ date });
    const raw = JSON.parse(await readFile(result.crossSignalsPath, "utf-8"));

    assert.equal(raw.sourceCount, 2);
    assert.equal(raw.overlaps.length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});

test("shared-context cross-signals captures multi-source overlap and feedback counts", async () => {
  const { manager, memoryDir, sharedDir } = await buildManager("engram-shared-overlap");
  try {
    const date = "2026-03-02";
    await manager.writeAgentOutput({
      agentId: "generalist",
      title: "Checkout latency mitigation",
      content: "Investigated checkout latency and proposed cache warmup.",
      createdAt: isoForDate(date, "09:00:00"),
    });
    await manager.writeAgentOutput({
      agentId: "oracle",
      title: "Latency and checkout diagnostics",
      content: "Validated checkout latency baseline and query plan issues.",
      createdAt: isoForDate(date, "09:05:00"),
    });
    await manager.appendFeedback({
      agent: "oracle",
      decision: "approved_with_feedback",
      reason: "good direction",
      date: `${date}T12:00:00Z`,
    });

    const result = await manager.curateDaily({ date });
    const raw = JSON.parse(await readFile(result.crossSignalsPath, "utf-8"));
    const crossSignalsMarkdown = await readFile(result.crossSignalsMarkdownPath, "utf-8");
    const roundtable = await readFile(result.roundtablePath, "utf-8");

    assert.equal(raw.sourceCount, 2);
    assert.equal(raw.feedbackByDecision.approved_with_feedback, 1);
    assert.equal(raw.overlaps.length >= 1, true);
    assert.equal(raw.overlaps.some((entry: { agentCount: number }) => entry.agentCount >= 2), true);
    assert.equal(result.overlapCount >= 1, true);
    assert.match(crossSignalsMarkdown, /## Recurring Themes/);
    assert.match(crossSignalsMarkdown, /\[sources:/);
    assert.match(crossSignalsMarkdown, /No promotion candidates yet/);
    assert.match(roundtable, /Cross-signals JSON:/);
    assert.match(roundtable, /Cross-signals markdown:/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});

test("shared-context daily curation serializes same-date artifact writes", async () => {
  const { manager, memoryDir, sharedDir } = await buildManager("engram-shared-concurrent");
  try {
    const date = "2026-03-05";
    await manager.writeAgentOutput({
      agentId: "generalist",
      title: "Checkout reliability notes",
      content: "Checkout reliability and latency work stayed aligned.",
      createdAt: isoForDate(date, "09:00:00"),
    });
    await manager.writeAgentOutput({
      agentId: "oracle",
      title: "Latency reliability notes",
      content: "Latency reliability checks confirmed checkout overlap.",
      createdAt: isoForDate(date, "09:05:00"),
    });

    const results = await Promise.all([
      manager.curateDaily({ date }),
      manager.curateDaily({ date }),
      manager.curateDaily({ date }),
    ]);
    const [result] = results;
    assert.ok(result);

    const raw = JSON.parse(await readFile(result.crossSignalsPath, "utf-8"));
    const crossSignalsMarkdown = await readFile(result.crossSignalsMarkdownPath, "utf-8");
    const roundtable = await readFile(result.roundtablePath, "utf-8");

    assert.equal(raw.date, date);
    assert.equal(raw.sourceCount, 2);
    assert.match(crossSignalsMarkdown, new RegExp(`# Cross-Signals .+ ${date}`));
    assert.match(roundtable, new RegExp(`# Roundtable .+ ${date}`));
    assert.match(roundtable, /Cross-signals JSON:/);
    assert.equal(
      (await readdir(path.dirname(result.crossSignalsPath))).some((file) => file.includes(".tmp")),
      false,
    );
    assert.equal(
      (await readdir(path.dirname(result.roundtablePath))).some((file) => file.includes(".tmp")),
      false,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});

test("shared-context cross-signals ranks risks and preserves detailed roundtable feedback", async () => {
  const { manager, memoryDir, sharedDir } = await buildManager("engram-shared-feedback");
  try {
    const date = "2026-03-04";
    await manager.writeAgentOutput({
      agentId: "generalist",
      title: "Checkout rollout watch",
      content: "Observed checkout latency and approval notes.",
      createdAt: isoForDate(date, "09:00:00"),
    });
    await manager.writeAgentOutput({
      agentId: "oracle",
      title: "Checkout latency review",
      content: "Confirmed checkout latency overlap and approval notes.",
      createdAt: isoForDate(date, "09:05:00"),
    });

    for (let i = 0; i < 8; i += 1) {
      await manager.appendFeedback({
        agent: `agent-${i}`,
        decision: "approved_with_feedback",
        reason: `medium follow-up ${i}`,
        severity: "medium",
        date: `${date}T10:0${i}:00Z`,
      });
    }
    await manager.appendFeedback({
      agent: "blocker-bot",
      decision: "rejected",
      reason: "critical checkout blocker",
      severity: "high",
      date: `${date}T11:00:00Z`,
      refs: ["memory://blocker"],
    });
    await manager.appendFeedback({
      agent: "approver",
      decision: "approved",
      reason: "ship it",
      severity: "low",
      date: `${date}T11:05:00Z`,
    });

    const result = await manager.curateDaily({ date });
    const crossSignalsMarkdown = await readFile(result.crossSignalsMarkdownPath, "utf-8");
    const roundtable = await readFile(result.roundtablePath, "utf-8");

    assert.match(crossSignalsMarkdown, /\[blocker-bot\] rejected: critical checkout blocker/);
    assert.doesNotMatch(crossSignalsMarkdown, /\[agent-7\] approved_with_feedback: medium follow-up 7/);
    assert.match(roundtable, /\[approver\] approved: ship it/);
    assert.equal((roundtable.match(/Decision totals:/g) ?? []).length, 1);
    assert.match(roundtable, /\[blocker-bot\] rejected: critical checkout blocker/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});
