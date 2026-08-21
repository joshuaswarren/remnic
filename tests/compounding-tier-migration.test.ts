import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseConfig } from "../src/config.js";
import { CompoundingEngine } from "../src/compounding/engine.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("compounding tier migration budget is bounded for extraction and maintenance", async () => {
  const memoryDir = tmpDir("engram-compound-tier-budget");
  const workspaceDir = tmpDir("engram-compound-tier-budget-workspace");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const config = parseConfig({
    memoryDir,
    workspaceDir,
    qmdTierMigrationEnabled: true,
    qmdTierAutoBackfillEnabled: false,
  });
  const engine = new CompoundingEngine(config);

  const extraction = engine.tierMigrationCycleBudget("extraction");
  const maintenance = engine.tierMigrationCycleBudget("maintenance");

  assert.equal(extraction.limit > 0, true);
  assert.equal(maintenance.limit > 0, true);
  assert.equal(extraction.scanLimit >= extraction.limit, true);
  assert.equal(maintenance.scanLimit >= maintenance.limit, true);
  assert.equal(maintenance.limit >= extraction.limit, true);
});

test("compounding tier migration maintenance budget expands with auto-backfill", async () => {
  const memoryDir = tmpDir("engram-compound-tier-backfill");
  const workspaceDir = tmpDir("engram-compound-tier-backfill-workspace");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const baseline = new CompoundingEngine(parseConfig({
    memoryDir,
    workspaceDir,
    qmdTierMigrationEnabled: true,
    qmdTierAutoBackfillEnabled: false,
  }));
  const backfill = new CompoundingEngine(parseConfig({
    memoryDir,
    workspaceDir,
    qmdTierMigrationEnabled: true,
    qmdTierAutoBackfillEnabled: true,
  }));

  const baseBudget = baseline.tierMigrationCycleBudget("maintenance");
  const backfillBudget = backfill.tierMigrationCycleBudget("maintenance");
  assert.equal(backfillBudget.limit > baseBudget.limit, true);
  assert.equal(backfillBudget.scanLimit > baseBudget.scanLimit, true);
});
