import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { rebuildObservations } from "../src/maintenance/rebuild-observations.js";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

test("rebuildObservations dry-run computes rows without writing output", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-dry-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-02-25T10:01:00.000Z",
        role: "user",
        content: "u1",
        sessionKey: "agent:main:default",
        turnId: "t1",
      }),
      JSON.stringify({
        timestamp: "2026-02-25T10:02:00.000Z",
        role: "assistant",
        content: "a1",
        sessionKey: "agent:main:default",
        turnId: "t2",
      }),
    ].join("\n") + "\n",
  );

  const result = await rebuildObservations({ memoryDir });
  assert.equal(result.dryRun, true);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.parsedTurns, 2);
  assert.equal(result.rebuiltRows, 1);

  await assert.rejects(() => stat(result.outputPath));
});

test("rebuildObservations writes deterministic ledger and backs up existing file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-live-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-02-25T10:01:00.000Z",
        role: "user",
        content: "u1",
        sessionKey: "agent:main:default",
        turnId: "t1",
      }),
      JSON.stringify({
        timestamp: "2026-02-25T11:02:00.000Z",
        role: "assistant",
        content: "a1",
        sessionKey: "agent:main:default",
        turnId: "t2",
      }),
    ].join("\n") + "\n",
  );
  await writeText(
    memoryDir,
    "state/observation-ledger/rebuilt-observations.jsonl",
    "{\"legacy\":true}\n",
  );

  const result = await rebuildObservations({
    memoryDir,
    dryRun: false,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });

  assert.equal(result.rebuiltRows, 2);
  assert.equal(result.backupPath != null, true);

  const backupRaw = await readFile(result.backupPath as string, "utf-8");
  assert.equal(backupRaw, "{\"legacy\":true}\n");

  const rebuiltRaw = await readFile(result.outputPath, "utf-8");
  const lines = rebuiltRaw.trim().split("\n").map((line) => JSON.parse(line) as any);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => ({ sessionKey: line.sessionKey, hour: line.hour, turnCount: line.turnCount })),
    [
      { sessionKey: "agent:main:default", hour: "2026-02-25T10:00:00.000Z", turnCount: 1 },
      { sessionKey: "agent:main:default", hour: "2026-02-25T11:00:00.000Z", turnCount: 1 },
    ],
  );
});

test("rebuildObservations rejects unreadable transcript shards without writing output", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-read-fail-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    JSON.stringify({
      timestamp: "2026-02-25T10:01:00.000Z",
      role: "user",
      content: "ok",
      sessionKey: "agent:main:default",
      turnId: "t1",
    }) + "\n",
  );
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-26.jsonl",
    JSON.stringify({
      timestamp: "2026-02-26T10:01:00.000Z",
      role: "assistant",
      content: "later",
      sessionKey: "agent:main:default",
      turnId: "t2",
    }) + "\n",
  );
  await writeText(
    memoryDir,
    "state/observation-ledger/rebuilt-observations.jsonl",
    "{\"legacy\":true}\n",
  );

  await assert.rejects(
    () =>
      rebuildObservations({
        memoryDir,
        dryRun: false,
        now: new Date("2026-02-27T12:00:00.000Z"),
        readTranscriptFile: async (file) => {
          if (file.endsWith("2026-02-26.jsonl")) {
            const err = new Error("permission denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return readFile(file, "utf-8");
        },
      }),
    /Failed to read transcript file .*2026-02-26\.jsonl: permission denied/,
  );
  assert.equal(
    await readFile(path.join(memoryDir, "state/observation-ledger/rebuilt-observations.jsonl"), "utf-8"),
    "{\"legacy\":true}\n",
  );
});

test("rebuildObservations ignores malformed transcript lines fail-open", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-malformed-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    [
      "{not-json}",
      "null",
      "123",
      JSON.stringify({
        timestamp: "2026-02-25T10:01:00.000Z",
        role: "user",
        content: "ok",
        sessionKey: "agent:main:default",
        turnId: "t1",
      }),
    ].join("\n") + "\n",
  );

  const result = await rebuildObservations({ memoryDir });
  assert.equal(result.malformedLines, 3);
  assert.equal(result.parsedTurns, 1);
  assert.equal(result.rebuiltRows, 1);
});

test("rebuildObservations enforces backup-first when existing ledger backup fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-backup-fail-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    JSON.stringify({
      timestamp: "2026-02-25T10:01:00.000Z",
      role: "user",
      content: "ok",
      sessionKey: "agent:main:default",
      turnId: "t1",
    }) + "\n",
  );
  await writeText(memoryDir, "state/observation-ledger/rebuilt-observations.jsonl", "{\"legacy\":true}\n");

  const now = new Date("2026-02-26T12:00:00.000Z");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  await writeText(
    memoryDir,
    `archive/observations/${stamp}/state`,
    "not-a-directory",
  );

  await assert.rejects(
    () =>
      rebuildObservations({
        memoryDir,
        dryRun: false,
        now,
      }),
  );
  assert.equal(
    await readFile(path.join(memoryDir, "state/observation-ledger/rebuilt-observations.jsonl"), "utf-8"),
    "{\"legacy\":true}\n",
  );
});

test("rebuildObservations skips transcript symlink loops", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-symlink-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    JSON.stringify({
      timestamp: "2026-02-25T10:01:00.000Z",
      role: "user",
      content: "ok",
      sessionKey: "agent:main:default",
      turnId: "t1",
    }) + "\n",
  );

  try {
    await symlink(
      path.join(memoryDir, "transcripts"),
      path.join(memoryDir, "transcripts", "loop"),
      "dir",
    );
  } catch {
    return;
  }

  const result = await rebuildObservations({ memoryDir });
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.parsedTurns, 1);
});

test("rebuildObservations treats timestamps without timezone suffix as UTC", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-tzless-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    JSON.stringify({
      timestamp: "2026-02-25T10:01:00",
      role: "user",
      content: "ok",
      sessionKey: "agent:main:default",
      turnId: "t1",
    }) + "\n",
  );

  const result = await rebuildObservations({
    memoryDir,
    dryRun: false,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });
  const rebuiltRaw = await readFile(result.outputPath, "utf-8");
  const rows = rebuiltRaw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { hour: string });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.hour, "2026-02-25T10:00:00.000Z");
});

test("rebuildObservations throws when transcripts root is unreadable/non-directory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-enotdir-"));
  await writeText(memoryDir, "transcripts", "not-a-directory");

  await assert.rejects(() => rebuildObservations({ memoryDir }));
});
