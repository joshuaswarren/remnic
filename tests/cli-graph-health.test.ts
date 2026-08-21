import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { runGraphHealthCliCommand } from "../src/cli.js";
import { analyzeGraphHealth } from "../src/graph.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("graph-health CLI wrapper reports integrity, coverage, and corruption counts", async () => {
  const memoryDir = tmpDir("engram-graph-health");
  const graphsDir = path.join(memoryDir, "state", "graphs");
  await mkdir(graphsDir, { recursive: true });

  const entityPath = path.join(graphsDir, "entity.jsonl");
  await writeFile(
    entityPath,
    [
      JSON.stringify({
        from: "facts/2026-02-27/a.md",
        to: "facts/2026-02-27/b.md",
        type: "entity",
        weight: 1,
        label: "project",
        ts: "2026-02-27T00:00:00.000Z",
      }),
      "not-json",
      JSON.stringify({
        from: "facts/2026-02-27/c.md",
        to: "facts/2026-02-27/d.md",
        type: "time",
        weight: 1,
        label: "thread",
        ts: "2026-02-27T00:00:00.000Z",
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const report = await runGraphHealthCliCommand({
    memoryDir,
    entityGraphEnabled: true,
    timeGraphEnabled: false,
    causalGraphEnabled: true,
    includeRepairGuidance: true,
  });

  assert.deepEqual(report.enabledTypes, ["entity", "causal"]);
  assert.equal(report.totals.totalLines, 3);
  assert.equal(report.totals.validEdges, 1);
  assert.equal(report.totals.corruptLines, 2);
  assert.equal(report.totals.uniqueNodes, 2);

  const entity = report.files.find((item) => item.type === "entity");
  assert.ok(entity);
  assert.equal(entity.exists, true);
  assert.equal(entity.totalLines, 3);
  assert.equal(entity.validEdges, 1);
  assert.equal(entity.corruptLines, 2);
  assert.equal(entity.uniqueNodes, 2);

  const causal = report.files.find((item) => item.type === "causal");
  assert.ok(causal);
  assert.equal(causal.exists, false);

  assert.ok(report.repairGuidance && report.repairGuidance.length > 0);
  assert.match(report.repairGuidance![0], /Corrupt graph lines detected/i);
});

test("analyzeGraphHealth omits repair guidance unless requested", async () => {
  const memoryDir = tmpDir("engram-graph-health-no-guidance");
  const graphsDir = path.join(memoryDir, "state", "graphs");
  await mkdir(graphsDir, { recursive: true });
  await writeFile(path.join(graphsDir, "entity.jsonl"), "", "utf8");

  const report = await analyzeGraphHealth(memoryDir, {
    entityGraphEnabled: true,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    includeRepairGuidance: false,
  });

  assert.deepEqual(report.enabledTypes, ["entity"]);
  assert.equal(report.totals.validEdges, 0);
  assert.equal(report.repairGuidance, undefined);
});
