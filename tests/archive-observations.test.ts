import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { archiveObservations } from "../src/maintenance/archive-observations.js";

async function createFile(baseDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(baseDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

test("archiveObservations defaults to dry-run and does not mutate files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-archive-observations-dry-"));
  const oldTranscript = "transcripts/main/default/2026-01-01.jsonl";
  await createFile(memoryDir, oldTranscript, "{\"role\":\"user\"}\n");

  const result = await archiveObservations({
    memoryDir,
    now: new Date("2026-02-26T00:00:00.000Z"),
    retentionDays: 14,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.archivedFiles, 0);
  assert.deepEqual(result.archivedRelativePaths, [oldTranscript]);

  const stillThere = await readFile(path.join(memoryDir, oldTranscript), "utf-8");
  assert.match(stillThere, /role/);
});

test("archiveObservations copies then removes old observation artifacts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-archive-observations-live-"));
  const files = [
    "transcripts/main/default/2026-01-01.jsonl",
    "state/tool-usage/main/default/2026-01-01.jsonl",
    "summaries/hourly/agent-main/2026-01-01.md",
  ];
  for (const rel of files) {
    await createFile(memoryDir, rel, `payload:${rel}`);
  }

  const result = await archiveObservations({
    memoryDir,
    now: new Date("2026-02-26T00:00:00.000Z"),
    retentionDays: 14,
    dryRun: false,
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.scannedFiles, 3);
  assert.equal(result.archivedFiles, 3);
  assert.deepEqual(result.archivedRelativePaths, [...files].sort());

  for (const rel of files) {
    await assert.rejects(() => stat(path.join(memoryDir, rel)));
    const archived = await readFile(path.join(result.archiveRoot, rel), "utf-8");
    assert.equal(archived, `payload:${rel}`);
  }
});

test("archiveObservations skips symlinked roots outside memoryDir", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-archive-observations-symlink-memory-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-archive-observations-symlink-outside-"));
  const outsideFile = "main/default/2026-01-01.jsonl";
  await createFile(outsideDir, outsideFile, "outside payload\n");
  await symlink(outsideDir, path.join(memoryDir, "transcripts"), "dir");

  const result = await archiveObservations({
    memoryDir,
    now: new Date("2026-02-26T00:00:00.000Z"),
    retentionDays: 14,
    dryRun: false,
  });

  assert.equal(result.scannedFiles, 0);
  assert.equal(result.archivedFiles, 0);
  assert.equal(await readFile(path.join(outsideDir, outsideFile), "utf-8"), "outside payload\n");
});

test("archiveObservations ignores recent and non-dated files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-archive-observations-filter-"));
  await createFile(memoryDir, "transcripts/main/default/current.jsonl", "{}\n");
  await createFile(memoryDir, "transcripts/main/default/2026-02-20.jsonl", "{}\n");
  await createFile(memoryDir, "summaries/hourly/main/2026-01-01.md", "old\n");

  const result = await archiveObservations({
    memoryDir,
    now: new Date("2026-02-26T00:00:00.000Z"),
    retentionDays: 14,
  });

  assert.equal(result.scannedFiles, 1);
  assert.deepEqual(result.archivedRelativePaths, ["summaries/hourly/main/2026-01-01.md"]);
});

test("archiveObservations treats retentionDays=0 as disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-archive-observations-zero-"));
  const oldFile = "transcripts/main/default/2026-01-01.jsonl";
  await createFile(memoryDir, oldFile, "{\"role\":\"user\"}\n");

  const result = await archiveObservations({
    memoryDir,
    now: new Date("2026-02-26T00:00:00.000Z"),
    retentionDays: 0,
    dryRun: false,
  });

  assert.equal(result.retentionDays, 0);
  assert.equal(result.scannedFiles, 0);
  assert.equal(result.archivedFiles, 0);
  assert.deepEqual(result.archivedRelativePaths, []);

  const raw = await readFile(path.join(memoryDir, oldFile), "utf-8");
  assert.match(raw, /role/);
});

test("archiveObservations keeps cutoff-day files for non-midnight runs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-archive-observations-cutoff-day-"));
  const cutoffDayFile = "transcripts/main/default/2026-02-12.jsonl";
  const olderFile = "transcripts/main/default/2026-02-11.jsonl";
  await createFile(memoryDir, cutoffDayFile, "{\"role\":\"user\"}\n");
  await createFile(memoryDir, olderFile, "{\"role\":\"user\"}\n");

  const result = await archiveObservations({
    memoryDir,
    now: new Date("2026-02-26T18:00:00.000Z"),
    retentionDays: 14,
    dryRun: true,
  });

  assert.deepEqual(result.archivedRelativePaths, [olderFile]);
});
