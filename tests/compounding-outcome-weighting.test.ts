import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

test("outcome weighting summarizes applied/skipped/failed by action", async () => {
  const memoryDir = tmpDir("engram-compound-outcomes-mem");
  const sharedDir = tmpDir("engram-compound-outcomes-shared");
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  await writeFile(
    path.join(memoryDir, "state", "memory-actions.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-02-25T10:00:00.000Z", action: "summarize_node", outcome: "applied" }),
      JSON.stringify({ timestamp: "2026-02-25T10:01:00.000Z", action: "summarize_node", outcome: "applied" }),
      JSON.stringify({ timestamp: "2026-02-25T10:02:00.000Z", action: "summarize_node", outcome: "failed" }),
      JSON.stringify({ timestamp: "2026-02-25T10:03:00.000Z", action: "store_note", outcome: "skipped" }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  const result = await engine.synthesizeWeekly({ weekId: "2026-W09" });
  const report = await readFile(result.reportPath, "utf-8");

  assert.match(report, /## Outcome Weighting/);
  assert.match(report, /summarize_node: applied=2, skipped=0, failed=1/);
  assert.match(report, /store_note: applied=0, skipped=1, failed=0/);
});

test("promotion candidates are advisory and only shown when semantic compounding is enabled", async () => {
  const memoryDir = tmpDir("engram-compound-promote-mem");
  const sharedDir = tmpDir("engram-compound-promote-shared");
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  await writeFile(
    path.join(memoryDir, "state", "memory-actions.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-02-25T11:00:00.000Z", action: "store_note", outcome: "applied" }),
      JSON.stringify({ timestamp: "2026-02-25T11:01:00.000Z", action: "store_note", outcome: "applied" }),
      JSON.stringify({ timestamp: "2026-02-25T11:02:00.000Z", action: "store_note", outcome: "applied" }),
      JSON.stringify({ timestamp: "2026-02-25T11:03:00.000Z", action: "store_note", outcome: "skipped" }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const disabled = new CompoundingEngine(buildConfig(memoryDir, sharedDir, { compoundingSemanticEnabled: false }));
  const disabledResult = await disabled.synthesizeWeekly({ weekId: "2026-W09" });
  const disabledReport = await readFile(disabledResult.reportPath, "utf-8");
  assert.equal(/## Promotion Candidates \(Advisory\)/.test(disabledReport), false);

  const enabled = new CompoundingEngine(buildConfig(memoryDir, sharedDir, { compoundingSemanticEnabled: true }));
  const enabledResult = await enabled.synthesizeWeekly({ weekId: "2026-W09" });
  const enabledReport = await readFile(enabledResult.reportPath, "utf-8");

  assert.match(enabledReport, /## Promotion Candidates \(Advisory\)/);
  assert.match(enabledReport, /Advisory only: no automatic promotion write is performed/);
  assert.ok(enabledResult.promotionCandidateCount >= 1);
});
