import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { runSessionCheckCliCommand, runSessionRepairCliCommand } from "../src/cli.js";

async function makeMemoryDir(prefix: string): Promise<string> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(memoryDir, "transcripts", "main", "default"), { recursive: true });
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  return memoryDir;
}

test("session-check CLI wrapper returns integrity report", async () => {
  const memoryDir = await makeMemoryDir("engram-cli-session-check-");
  const transcriptPath = path.join(memoryDir, "transcripts", "main", "default", "2026-02-28.jsonl");
  await writeFile(
    transcriptPath,
    JSON.stringify({
      timestamp: "2026-02-28T10:00:00.000Z",
      role: "user",
      content: "hello",
      sessionKey: "agent:generalist:main",
      turnId: "turn-1",
    }),
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "state", "checkpoint.json"),
    JSON.stringify({
      sessionKey: "agent:generalist:main",
      capturedAt: "2026-02-28T10:00:00.000Z",
      ttl: "2026-02-28T11:00:00.000Z",
      turns: [],
    }),
    "utf-8",
  );

  const report = await runSessionCheckCliCommand({ memoryDir });
  assert.equal(report.memoryDir, memoryDir);
  assert.equal(Array.isArray(report.sessions), true);
});

test("session-repair CLI wrapper dry-run does not mutate files", async () => {
  const memoryDir = await makeMemoryDir("engram-cli-session-repair-dry-");
  const transcriptPath = path.join(memoryDir, "transcripts", "main", "default", "2026-02-28.jsonl");
  const initial = [
    JSON.stringify({
      timestamp: "2026-02-28T10:00:00.000Z",
      role: "user",
      content: "hello",
      sessionKey: "agent:generalist:main",
      turnId: "turn-1",
    }),
    "not-json",
  ].join("\n");
  await writeFile(transcriptPath, initial, "utf-8");

  const result = await runSessionRepairCliCommand({
    memoryDir,
    dryRun: true,
  });
  assert.equal(result.plan.dryRun, true);
  assert.equal(result.applyResult.applied, false);

  const after = await readFile(transcriptPath, "utf-8");
  assert.equal(after, initial);
});

test("session-repair CLI wrapper apply mutates Engram-managed files", async () => {
  const memoryDir = await makeMemoryDir("engram-cli-session-repair-apply-");
  const transcriptPath = path.join(memoryDir, "transcripts", "main", "default", "2026-02-28.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        timestamp: "2026-02-28T10:00:00.000Z",
        role: "user",
        content: "hello",
        sessionKey: "agent:generalist:main",
        turnId: "turn-1",
      }),
      "not-json",
    ].join("\n"),
    "utf-8",
  );

  const result = await runSessionRepairCliCommand({
    memoryDir,
    apply: true,
  });
  assert.equal(result.plan.dryRun, false);
  assert.equal(result.applyResult.applied, true);
  assert.equal(result.applyResult.actionsApplied > 0, true);

  const repaired = await readFile(transcriptPath, "utf-8");
  assert.equal(repaired.trim().split("\n").length, 1);
});

