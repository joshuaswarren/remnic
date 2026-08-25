import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRecallAuditEntry,
  buildRecallAuditPath,
  pruneRecallAuditEntries,
} from "./recall-audit.js";

test("appendRecallAuditEntry writes a daily per-session JSONL audit shard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-audit-"));
  const entry = {
    ts: "2026-04-12T14:30:12.445Z",
    sessionKey: "agent/main:session/1",
    agentId: "main",
    trigger: "before_prompt_build",
    queryText: "How did the CI outage resolve?",
    candidateMemoryIds: ["mem_1", "mem_2"],
    summary: "CI recovered after the flaky worker drain.",
    injectedChars: 48,
    toggleState: "enabled" as const,
    latencyMs: 123,
  };

  const filePath = await appendRecallAuditEntry(root, entry);
  assert.equal(
    filePath,
    buildRecallAuditPath(root, entry.ts, entry.sessionKey),
  );
  const raw = await readFile(filePath, "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? "{}"), entry);
});

test("pruneRecallAuditEntries removes day directories older than retention", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-prune-"));
  const keepDir = path.join(root, "transcripts", "2026-04-11");
  const deleteDir = path.join(root, "transcripts", "2026-04-01");
  await mkdir(keepDir, { recursive: true });
  await mkdir(deleteDir, { recursive: true });

  const removed = await pruneRecallAuditEntries(root, 5, new Date("2026-04-12T12:00:00.000Z"));
  assert.deepEqual(removed, [deleteDir]);

  assert.equal((await stat(keepDir)).isDirectory(), true);
  await assert.rejects(stat(deleteDir));
});

test("#2972 audit entry persists degradation when present and omits it otherwise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-audit-deg-"));
  const healthy = {
    ts: "2026-04-12T14:30:12.445Z",
    sessionKey: "agent/main:session/healthy",
    agentId: "main",
    trigger: "access-surface",
    queryText: "How did the CI outage resolve?",
    candidateMemoryIds: ["mem_1"],
    summary: "CI recovered.",
    injectedChars: 12,
    toggleState: "enabled" as const,
  };
  const degraded = {
    ...healthy,
    sessionKey: "agent/main:session/degraded",
    degradation: {
      state: "degraded" as const,
      reason: "budget-compacted" as const,
      budget: { contextBudget: 80, fullChars: 200, deliveredChars: 80 },
    },
  };

  await appendRecallAuditEntry(root, healthy);
  await appendRecallAuditEntry(root, degraded);

  const healthyPath = buildRecallAuditPath(root, healthy.ts, healthy.sessionKey);
  const degradedPath = buildRecallAuditPath(root, degraded.ts, degraded.sessionKey);
  assert.deepEqual(JSON.parse((await readFile(healthyPath, "utf8")).trim()), healthy);
  assert.equal("degradation" in JSON.parse((await readFile(healthyPath, "utf8")).trim()), false);
  assert.deepEqual(JSON.parse((await readFile(degradedPath, "utf8")).trim()), degraded);
});

