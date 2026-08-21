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
