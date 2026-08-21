import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { TranscriptManager } from "../src/transcript.js";

test("recovery summary reports broken chain and incomplete turn counts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recovery-summary-"));
  await mkdir(path.join(memoryDir, "state"), { recursive: true });

  const config = parseConfig({
    memoryDir,
    transcriptEnabled: true,
  });
  const transcript = new TranscriptManager(config);
  await transcript.initialize();

  await transcript.append({
    timestamp: "2026-02-28T10:00:00.000Z",
    role: "user",
    content: "hello",
    sessionKey: "agent:generalist:main",
    turnId: "t1",
  });
  await transcript.append({
    timestamp: "2026-02-28T10:01:00.000Z",
    role: "user",
    content: "follow-up",
    sessionKey: "agent:generalist:main",
    turnId: "t2",
  });

  await writeFile(path.join(memoryDir, "state", "checkpoint.json"), "{bad-json", "utf-8");

  const summary = await transcript.getRecoverySummary("agent:generalist:main");
  assert.equal(summary.brokenChains > 0, true);
  assert.equal(summary.incompleteTurns > 0, true);
  assert.equal(summary.checkpointHealthy, false);
  assert.equal(summary.healthy, false);
});

test("recovery summary keeps healthy true for info-only integrity issues", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recovery-summary-info-only-"));
  const config = parseConfig({
    memoryDir,
    transcriptEnabled: true,
  });
  const transcript = new TranscriptManager(config);
  await transcript.initialize();

  const summary = await transcript.getRecoverySummary();
  assert.equal(summary.checkpointHealthy, true);
  assert.equal(summary.issueCount > 0, true);
  assert.equal(summary.healthy, true);
});
