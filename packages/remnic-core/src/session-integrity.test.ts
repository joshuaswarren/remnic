import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySessionRepair, planSessionRepair } from "./session-integrity.js";
import type { SessionIntegrityReport, SessionRepairPlan } from "./session-integrity.js";

test("session repair rejects forged transcript paths outside memoryDir", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-session-repair-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-session-outside-"));
  try {
    await mkdir(path.join(memoryDir, "transcripts"), { recursive: true });
    const outsideFile = path.join(outside, "forged.jsonl");
    await writeFile(outsideFile, "not json\n", "utf8");
    const plan: SessionRepairPlan = {
      generatedAt: new Date().toISOString(),
      dryRun: false,
      memoryDir,
      allowSessionFileRepair: false,
      actions: [
        {
          kind: "rewrite_transcript",
          description: "forged",
          targetPath: outsideFile,
        },
      ],
    };

    const result = await applySessionRepair({ plan });
    assert.equal(result.actionsApplied, 0);
    assert.match(result.errors.join("\n"), /escapes configured memoryDir/);
    assert.equal(await readFile(outsideFile, "utf8"), "not json\n");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("session repair rejects symlinked transcript targets", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-session-repair-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-session-outside-"));
  try {
    const transcripts = path.join(memoryDir, "transcripts");
    await mkdir(transcripts, { recursive: true });
    const outsideFile = path.join(outside, "real.jsonl");
    const linkFile = path.join(transcripts, "link.jsonl");
    await writeFile(outsideFile, "not json\n", "utf8");
    await symlink(outsideFile, linkFile);
    const plan: SessionRepairPlan = {
      generatedAt: new Date().toISOString(),
      dryRun: false,
      memoryDir,
      allowSessionFileRepair: false,
      actions: [
        {
          kind: "rewrite_transcript",
          description: "symlink",
          targetPath: linkFile,
        },
      ],
    };

    const result = await applySessionRepair({ plan });
    assert.equal(result.actionsApplied, 0);
    assert.match(result.errors.join("\n"), /repair target crosses symlink/);
    assert.equal(await readFile(outsideFile, "utf8"), "not json\n");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("planned session repair carries the report memoryDir into apply-time validation", () => {
  const report: SessionIntegrityReport = {
    generatedAt: "2026-05-22T00:00:00.000Z",
    memoryDir: "/tmp/remnic-memory",
    healthy: false,
    sessions: [],
    checkpoint: {
      present: true,
      healthy: false,
      path: "/tmp/remnic-memory/state/checkpoint.json",
    },
    issues: [
      {
        code: "checkpoint_invalid_json",
        severity: "error",
        message: "bad checkpoint",
        filePath: "/tmp/remnic-memory/state/checkpoint.json",
      },
    ],
  };

  const plan = planSessionRepair({ report, dryRun: false });
  assert.equal(plan.memoryDir, "/tmp/remnic-memory");
});
