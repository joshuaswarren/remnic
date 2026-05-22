import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { migrateObservations } from "../src/maintenance/migrate-observations.js";
import { backupAndWriteRebuiltObservations } from "../src/maintenance/observation-ledger-utils.js";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

test("migrateObservations dry-run scans legacy files without writing output", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-migrate-observations-dry-"));
  await writeText(
    memoryDir,
    "state/observation-ledger/legacy-observations.jsonl",
    JSON.stringify({
      session: "agent:main:default",
      timestamp: "2026-02-25T10:05:00.000Z",
      role: "user",
    }) + "\n",
  );

  const result = await migrateObservations({ memoryDir });
  assert.equal(result.dryRun, true);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.parsedRows, 1);
  assert.equal(result.migratedRows, 1);
  assert.deepEqual(result.sourceRelativePaths, ["state/observation-ledger/legacy-observations.jsonl"]);
  await assert.rejects(() => stat(result.outputPath));
});

test("migrateObservations canonicalizes mixed legacy shapes and writes deterministic rows", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-migrate-observations-live-"));
  await writeText(
    memoryDir,
    "state/observation-ledger/v1.jsonl",
    [
      JSON.stringify({
        session: "agent:main:default",
        hourStart: "2026-02-25T10:00:00",
        turns: 2,
        user: 1,
        assistant: 1,
      }),
      JSON.stringify({
        sessionKey: "agent:main:default",
        timestamp: "2026-02-25T10:23:00.000Z",
        role: "assistant",
      }),
    ].join("\n") + "\n",
  );
  await writeText(
    memoryDir,
    "state/observation-ledger/v2.jsonl",
    JSON.stringify({
      session_id: "agent:main:ops",
      hour: "2026-02-25T11:40:00.000Z",
      totalTurns: 3,
      userCount: 2,
      assistantCount: 1,
    }) + "\n",
  );
  await writeText(
    memoryDir,
    "state/observation-ledger/rebuilt-observations.jsonl",
    "{\"legacy\":true}\n",
  );

  const result = await migrateObservations({
    memoryDir,
    dryRun: false,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });

  assert.equal(result.scannedFiles, 2);
  assert.equal(result.parsedRows, 3);
  assert.equal(result.migratedRows, 2);
  assert.equal(result.backupPath != null, true);
  const backupRaw = await readFile(result.backupPath as string, "utf-8");
  assert.equal(backupRaw, "{\"legacy\":true}\n");

  const rebuiltRaw = await readFile(result.outputPath, "utf-8");
  const rows = rebuiltRaw.trim().split("\n").map((line) => JSON.parse(line) as any);
  assert.deepEqual(
    rows.map((row) => ({
      sessionKey: row.sessionKey,
      hour: row.hour,
      turnCount: row.turnCount,
      userTurns: row.userTurns,
      assistantTurns: row.assistantTurns,
    })),
    [
      {
        sessionKey: "agent:main:default",
        hour: "2026-02-25T10:00:00.000Z",
        turnCount: 3,
        userTurns: 1,
        assistantTurns: 2,
      },
      {
        sessionKey: "agent:main:ops",
        hour: "2026-02-25T11:00:00.000Z",
        turnCount: 3,
        userTurns: 2,
        assistantTurns: 1,
      },
    ],
  );
});

test("migrateObservations counts malformed legacy lines fail-open", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-migrate-observations-malformed-"));
  await writeText(
    memoryDir,
    "state/observation-ledger/legacy.jsonl",
    [
      "{not-json}",
      "null",
      JSON.stringify({
        session: "agent:main:default",
        timestamp: "2026-02-25T10:05:00.000Z",
      }),
      JSON.stringify({
        session: "agent:main:default",
        timestamp: "2026-02-25T10:05:00.000Z",
        role: "user",
      }),
    ].join("\n") + "\n",
  );

  const result = await migrateObservations({ memoryDir });
  assert.equal(result.parsedRows, 1);
  assert.equal(result.malformedLines, 3);
  assert.equal(result.migratedRows, 1);
});

test("migrateObservations enforces backup-first when backup write fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-migrate-observations-backup-fail-"));
  await writeText(
    memoryDir,
    "state/observation-ledger/legacy.jsonl",
    JSON.stringify({
      session: "agent:main:default",
      timestamp: "2026-02-25T10:05:00.000Z",
      role: "user",
    }) + "\n",
  );
  await writeText(memoryDir, "state/observation-ledger/rebuilt-observations.jsonl", "{\"legacy\":true}\n");

  const now = new Date("2026-02-26T12:00:00.000Z");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  await writeText(memoryDir, `archive/observations/${stamp}/state`, "not-a-directory");

  await assert.rejects(() =>
    migrateObservations({
      memoryDir,
      dryRun: false,
      now,
    }),
  );
});

test("backupAndWriteRebuiltObservations keeps active ledger unchanged when replacement write fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-migrate-observations-output-fail-"));
  const outputPath = path.join(memoryDir, "state", "observation-ledger", "rebuilt-observations.jsonl");
  await writeText(memoryDir, "state/observation-ledger/rebuilt-observations.jsonl", "{\"legacy\":true}\n");

  const now = new Date("2026-02-26T12:00:00.000Z");
  await assert.rejects(
    () =>
      backupAndWriteRebuiltObservations({
        memoryDir,
        outputPath,
        rows: [
          {
            sessionKey: "agent:main:default",
            hour: "2026-02-25T10:00:00.000Z",
            turnCount: 1,
            userTurns: 1,
            assistantTurns: 0,
          },
        ],
        now,
        atomicWrite: async (filePath, content) => {
          if (filePath === outputPath) {
            throw new Error("simulated replacement failure");
          }
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, content, "utf-8");
        },
      }),
    /simulated replacement failure/,
  );

  const activeRaw = await readFile(outputPath, "utf-8");
  assert.equal(activeRaw, "{\"legacy\":true}\n");

  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const archivedRaw = await readFile(
    path.join(
      memoryDir,
      "archive",
      "observations",
      stamp,
      "state",
      "observation-ledger",
      "rebuilt-observations.jsonl",
    ),
    "utf-8",
  );
  assert.equal(archivedRaw, "{\"legacy\":true}\n");
});

test("migrateObservations live mode is no-op when no legacy files exist", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-migrate-observations-noop-"));
  await writeText(
    memoryDir,
    "state/observation-ledger/rebuilt-observations.jsonl",
    "{\"sessionKey\":\"agent:main:default\",\"hour\":\"2026-02-25T10:00:00.000Z\",\"turnCount\":1}\n",
  );

  const result = await migrateObservations({
    memoryDir,
    dryRun: false,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });

  assert.equal(result.scannedFiles, 0);
  assert.equal(result.parsedRows, 0);
  assert.equal(result.migratedRows, 0);
  assert.equal(result.backupPath, undefined);
  const current = await readFile(result.outputPath, "utf-8");
  assert.equal(
    current,
    "{\"sessionKey\":\"agent:main:default\",\"hour\":\"2026-02-25T10:00:00.000Z\",\"turnCount\":1}\n",
  );
});

test("migrateObservations ignores negative sentinel counts and falls back to alternate fields", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-migrate-observations-neg-fallback-"));
  await writeText(
    memoryDir,
    "state/observation-ledger/legacy.jsonl",
    JSON.stringify({
      session: "agent:main:default",
      hour: "2026-02-25T10:00:00.000Z",
      turnCount: -1,
      turns: 5,
      userTurns: -1,
      userCount: 2,
      assistantTurns: -1,
      assistantCount: 3,
    }) + "\n",
  );

  const result = await migrateObservations({
    memoryDir,
    dryRun: false,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });
  assert.equal(result.parsedRows, 1);
  assert.equal(result.migratedRows, 1);
  const rows = (await readFile(result.outputPath, "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as any);
  assert.equal(rows[0]?.turnCount, 5);
  assert.equal(rows[0]?.userTurns, 2);
  assert.equal(rows[0]?.assistantTurns, 3);
});
