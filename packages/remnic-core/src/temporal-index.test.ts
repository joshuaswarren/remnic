import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  indexMemory,
  queryByDateRangeAsync,
  queryByTagsAsync,
  resolvePromptTagPrefilterAsync,
} from "./temporal-index.js";

async function runIndexWorker(moduleUrl: string, memoryDir: string, workerId: number, count: number): Promise<void> {
  const workerSource = `
const { indexMemory } = await import(process.argv[1]);
const memoryDir = process.argv[2];
const workerId = Number(process.argv[3]);
const count = Number(process.argv[4]);
for (let i = 0; i < count; i += 1) {
  indexMemory(
    memoryDir,
    \`/tmp/remnic-temporal-worker-\${workerId}-memory-\${i}.md\`,
    "2026-03-09T12:00:00.000Z",
    ["concurrency/shared", \`concurrency/worker-\${workerId}\`],
  );
}
`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "-e", workerSource, moduleUrl, memoryDir, String(workerId), String(count)],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`index worker ${workerId} exited ${code}: ${stderr}`));
    });
  });
}

test("temporal index concurrent writers retain every date and tag path", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-concurrent-"));
  const moduleUrl = new URL("./temporal-index.ts", import.meta.url).href;
  const workerCount = 4;
  const entriesPerWorker = 12;
  const expectedPaths = new Set<string>();

  for (let workerId = 0; workerId < workerCount; workerId += 1) {
    for (let i = 0; i < entriesPerWorker; i += 1) {
      expectedPaths.add(`/tmp/remnic-temporal-worker-${workerId}-memory-${i}.md`);
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, (_, workerId) =>
      runIndexWorker(moduleUrl, memoryDir, workerId, entriesPerWorker)
    )
  );

  const dateMatches = await queryByDateRangeAsync(memoryDir, "2026-03-09", "2026-03-10");
  const tagMatches = await queryByTagsAsync(memoryDir, ["concurrency/shared"]);

  assert.deepEqual(dateMatches, expectedPaths);
  assert.deepEqual(tagMatches, expectedPaths);

  const timeIndex = JSON.parse(await readFile(join(memoryDir, "state", "index_time.json"), "utf8"));
  const tagIndex = JSON.parse(await readFile(join(memoryDir, "state", "index_tags.json"), "utf8"));
  assert.equal(timeIndex.dates["2026-03-09"].length, expectedPaths.size);
  assert.equal(tagIndex.tags["concurrency/shared"].paths.length, expectedPaths.size);
});

test("temporal index writers wait for old locks owned by live processes", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-live-lock-"));
  const stateDir = join(memoryDir, "state");
  const lockDir = join(stateDir, "index_time.json.lock.d");
  const moduleUrl = new URL("./temporal-index.ts", import.meta.url).href;
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid }), "utf8");
  const oldLockTime = new Date(Date.now() - 120_000);
  await utimes(lockDir, oldLockTime, oldLockTime);

  const workerSource = `
const { indexMemory } = await import(process.argv[1]);
indexMemory(
  process.argv[2],
  "/tmp/remnic-temporal-live-lock-memory.md",
  "2026-03-10T12:00:00.000Z",
  ["concurrency/live-lock"],
);
`;
  let closed = false;
  const workerDone = new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", workerSource, moduleUrl, memoryDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      closed = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`live-lock worker exited ${code}: ${stderr}`));
    });
  });

  await delay(150);
  assert.equal(closed, false);
  await rm(lockDir, { recursive: true, force: true });
  await workerDone;

  const dateMatches = await queryByDateRangeAsync(memoryDir, "2026-03-10", "2026-03-11");
  const tagMatches = await queryByTagsAsync(memoryDir, ["concurrency/live-lock"]);
  assert.deepEqual(dateMatches, new Set(["/tmp/remnic-temporal-live-lock-memory.md"]));
  assert.deepEqual(tagMatches, new Set(["/tmp/remnic-temporal-live-lock-memory.md"]));
});

test("temporal index writers clear stale locks whose owner pid was recycled", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-recycled-pid-"));
  const stateDir = join(memoryDir, "state");
  const lockDir = join(stateDir, "index_time.json.lock.d");
  const moduleUrl = new URL("./temporal-index.ts", import.meta.url).href;
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      processStartedAtMs: Date.now() - 7 * 86_400_000,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    }),
    "utf8"
  );
  const oldLockTime = new Date(Date.now() - 120_000);
  await utimes(lockDir, oldLockTime, oldLockTime);

  await runIndexWorker(moduleUrl, memoryDir, 99, 1);

  const dateMatches = await queryByDateRangeAsync(memoryDir, "2026-03-09", "2026-03-10");
  const tagMatches = await queryByTagsAsync(memoryDir, ["concurrency/shared"]);
  assert.deepEqual(dateMatches, new Set(["/tmp/remnic-temporal-worker-99-memory-0.md"]));
  assert.deepEqual(tagMatches, new Set(["/tmp/remnic-temporal-worker-99-memory-0.md"]));
});

test("temporal index writers remove regular file lock blockers", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-file-lock-"));
  const stateDir = join(memoryDir, "state");
  const lockPath = join(stateDir, "index_time.json.lock.d");
  const moduleUrl = new URL("./temporal-index.ts", import.meta.url).href;
  await mkdir(stateDir, { recursive: true });
  await writeFile(lockPath, "not a lock directory", "utf8");

  await runIndexWorker(moduleUrl, memoryDir, 100, 1);

  const dateMatches = await queryByDateRangeAsync(memoryDir, "2026-03-09", "2026-03-10");
  const tagMatches = await queryByTagsAsync(memoryDir, ["concurrency/shared"]);
  assert.deepEqual(dateMatches, new Set(["/tmp/remnic-temporal-worker-100-memory-0.md"]));
  assert.deepEqual(tagMatches, new Set(["/tmp/remnic-temporal-worker-100-memory-0.md"]));
});

test("temporal index writers fail open on symlink lock blockers", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-symlink-lock-"));
  const stateDir = join(memoryDir, "state");
  const lockPath = join(stateDir, "index_time.json.lock.d");
  const symlinkTarget = join(memoryDir, "outside-lock-target");
  const moduleUrl = new URL("./temporal-index.ts", import.meta.url).href;
  await mkdir(stateDir, { recursive: true });
  await writeFile(symlinkTarget, "do not follow", "utf8");
  await symlink(symlinkTarget, lockPath);

  await runIndexWorker(moduleUrl, memoryDir, 101, 1);

  const dateMatches = await queryByDateRangeAsync(memoryDir, "2026-03-09", "2026-03-10");
  const tagMatches = await queryByTagsAsync(memoryDir, ["concurrency/shared"]);
  assert.equal(dateMatches, null);
  assert.deepEqual(tagMatches, new Set(["/tmp/remnic-temporal-worker-101-memory-0.md"]));
});

test("tag queries distinguish missing index from valid no-match results", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-tag-miss-"));

  const unavailableMatches = await queryByTagsAsync(memoryDir, ["beta"]);
  assert.equal(unavailableMatches, null);

  indexMemory(memoryDir, "/tmp/remnic-temporal-alpha-memory.md", "2026-03-11T12:00:00.000Z", ["alpha"]);

  const matchingPaths = await queryByTagsAsync(memoryDir, ["alpha"]);
  assert.deepEqual(matchingPaths, new Set(["/tmp/remnic-temporal-alpha-memory.md"]));

  const noMatchPaths = await queryByTagsAsync(memoryDir, ["beta"]);
  assert.deepEqual(noMatchPaths, new Set());

  const promptPrefilter = await resolvePromptTagPrefilterAsync(memoryDir, "find #beta notes");
  assert.deepEqual(promptPrefilter.matchedTags, ["beta"]);
  assert.deepEqual(promptPrefilter.paths, new Set());

  const noFilterPrefilter = await resolvePromptTagPrefilterAsync(memoryDir, "find project notes");
  assert.deepEqual(noFilterPrefilter.matchedTags, []);
  assert.deepEqual(noFilterPrefilter.expandedTags, []);
  assert.equal(noFilterPrefilter.paths, null);
});

test("indexMemory replaces stale date and tag memberships for an existing path", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-update-"));
  const memoryPath = "/tmp/remnic-temporal-updated-memory.md";

  indexMemory(memoryDir, memoryPath, "2026-01-01T00:00:00.000Z", ["alpha"]);
  indexMemory(memoryDir, memoryPath, "2026-02-01T00:00:00.000Z", ["beta"]);

  const januaryMatches = await queryByDateRangeAsync(memoryDir, "2026-01-01", "2026-01-02");
  const februaryMatches = await queryByDateRangeAsync(memoryDir, "2026-02-01", "2026-02-02");
  const alphaMatches = await queryByTagsAsync(memoryDir, ["alpha"]);
  const betaMatches = await queryByTagsAsync(memoryDir, ["beta"]);

  assert.deepEqual(januaryMatches, new Set());
  assert.deepEqual(februaryMatches, new Set([memoryPath]));
  assert.deepEqual(alphaMatches, new Set());
  assert.deepEqual(betaMatches, new Set([memoryPath]));
});
