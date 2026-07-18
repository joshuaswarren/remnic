import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  clearIndexes,
  deindexMemory as deindexMemorySync,
  deindexMemoryAsync as deindexMemory,
  deindexMemoriesBatchAsync,
  indexMemoriesBatch,
  indexMemory as indexMemorySync,
  indexMemoryAsync as indexMemory,
  indexesExist as indexesExistSync,
  indexesExistAsync as indexesExist,
  queryByDateRangeAsync,
  queryByTagsAsync,
  queryTemporalTimelineAsync,
  resolvePromptTagPrefilterAsync,
  setIndexReadObserverForTest,
  setIndexWriteFailureForTest,
  setIndexWriteObserverForTest,
} from "./temporal-index.js";

test("legacy temporal-index exports preserve synchronous return timing and booleans", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-sync-compat-"));
  const firstPath = "/tmp/remnic-temporal-sync-first.md";
  const secondPath = "/tmp/remnic-temporal-sync-second.md";

  const initiallyExists = indexesExistSync(memoryDir);
  assert.equal(typeof initiallyExists, "boolean");
  assert.equal(initiallyExists, false);

  assert.equal(
    indexMemorySync(memoryDir, firstPath, "2026-03-09T12:00:00.000Z", ["sync"]),
    undefined,
  );
  const afterIndex = JSON.parse(
    fs.readFileSync(join(memoryDir, "state", "index_time.json"), "utf8"),
  );
  assert.deepEqual(afterIndex.dates["2026-03-09"], [firstPath]);
  assert.equal(indexesExistSync(memoryDir), true);

  indexMemoriesBatch(memoryDir, [
    {
      path: secondPath,
      createdAt: "2026-03-10T12:00:00.000Z",
      tags: ["sync"],
    },
  ]);
  const afterBatch = JSON.parse(
    fs.readFileSync(join(memoryDir, "state", "index_time.json"), "utf8"),
  );
  assert.deepEqual(afterBatch.dates["2026-03-10"], [secondPath]);

  deindexMemorySync(memoryDir, firstPath, "2026-03-09T12:00:00.000Z", ["sync"]);
  const afterDeindex = JSON.parse(
    fs.readFileSync(join(memoryDir, "state", "index_time.json"), "utf8"),
  );
  assert.equal(afterDeindex.dates["2026-03-09"], undefined);

  clearIndexes(memoryDir);
  const afterClear = JSON.parse(
    fs.readFileSync(join(memoryDir, "state", "index_time.json"), "utf8"),
  );
  assert.deepEqual(afterClear, { version: 2, dates: {}, events: {} });
});

test("explicit async mutation exports return promises and complete when awaited", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-async-surface-"));
  const memoryPath = "/tmp/remnic-temporal-async.md";
  const pending = indexMemory(
    memoryDir,
    memoryPath,
    "2026-03-09T12:00:00.000Z",
    ["async"],
  );
  assert.ok(pending instanceof Promise);
  await pending;
  assert.deepEqual(
    await queryByTagsAsync(memoryDir, ["async"]),
    new Set([memoryPath]),
  );
  assert.equal(await indexesExist(memoryDir), true);
});

async function runIndexWorker(moduleUrl: string, memoryDir: string, workerId: number, count: number): Promise<void> {
  const workerSource = `
const { indexMemoryAsync: indexMemory } = await import(process.argv[1]);
const memoryDir = process.argv[2];
const workerId = Number(process.argv[3]);
const count = Number(process.argv[4]);
for (let i = 0; i < count; i += 1) {
  await indexMemory(
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

test("temporal index in-process promise concurrency retains every path", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-in-process-"));
  const expectedPaths = Array.from(
    { length: 40 },
    (_, index) => `/tmp/remnic-temporal-in-process-${index}.md`,
  );

  await Promise.all(
    expectedPaths.map((memoryPath) =>
      indexMemory(
        memoryDir,
        memoryPath,
        "2026-03-12T12:00:00.000Z",
        ["concurrency/in-process"],
      ),
    ),
  );

  assert.deepEqual(
    await queryByDateRangeAsync(memoryDir, "2026-03-12", "2026-03-13"),
    new Set(expectedPaths),
  );
  assert.deepEqual(
    await queryByTagsAsync(memoryDir, ["concurrency/in-process"]),
    new Set(expectedPaths),
  );
});

test("parsed cache detects a cross-process atomic replacement", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-cache-replace-"));
  const moduleUrl = new URL("./temporal-index.ts", import.meta.url).href;
  const initialPath = "/tmp/remnic-temporal-cache-initial.md";
  await indexMemory(
    memoryDir,
    initialPath,
    "2026-03-09T12:00:00.000Z",
    ["concurrency/shared"],
  );
  assert.deepEqual(
    await queryByTagsAsync(memoryDir, ["concurrency/shared"]),
    new Set([initialPath]),
  );

  await runIndexWorker(moduleUrl, memoryDir, 777, 1);

  assert.deepEqual(
    await queryByTagsAsync(memoryDir, ["concurrency/shared"]),
    new Set([initialPath, "/tmp/remnic-temporal-worker-777-memory-0.md"]),
  );
});

test("unchanged index identity skips file reads while retaining the stat freshness check", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-cache-hit-"));
  const statePath = join(memoryDir, "state");
  const tagPath = join(statePath, "index_tags.json");
  await mkdir(statePath, { recursive: true });
  await writeFile(
    tagPath,
    JSON.stringify({ version: 2, tags: { alpha: ["/tmp/alpha.md"] }, aliases: {} }),
    "utf8",
  );
  let reads = 0;
  setIndexReadObserverForTest(() => {
    reads += 1;
  });
  try {
    assert.deepEqual(await queryByTagsAsync(memoryDir, ["alpha"]), new Set(["/tmp/alpha.md"]));
    assert.deepEqual(await queryByTagsAsync(memoryDir, ["alpha"]), new Set(["/tmp/alpha.md"]));
    assert.equal(reads, 1);

    await writeFile(
      tagPath,
      JSON.stringify({ version: 2, tags: { beta: ["/tmp/beta.md"] }, aliases: {} }),
      "utf8",
    );
    assert.deepEqual(await queryByTagsAsync(memoryDir, ["beta"]), new Set(["/tmp/beta.md"]));
    assert.equal(reads, 2);
  } finally {
    setIndexReadObserverForTest();
  }
});

test("failed atomic commit never publishes a mutated temporal cache", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-failed-commit-"));
  const originalPath = "/tmp/remnic-temporal-committed.md";
  const rejectedPath = "/tmp/remnic-temporal-rejected.md";
  await indexMemory(memoryDir, originalPath, "2026-03-09T12:00:00.000Z", ["committed"]);

  const originalRename = fs.promises.rename;
  fs.promises.rename = (async (oldPath, newPath) => {
    if (String(newPath).endsWith("index_time.json")) {
      const error = new Error("injected temporal rename failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return originalRename(oldPath, newPath);
  }) as typeof originalRename;
  try {
    await indexMemory(memoryDir, rejectedPath, "2026-03-10T12:00:00.000Z", ["rejected"]);
  } finally {
    fs.promises.rename = originalRename;
  }

  assert.deepEqual(
    await queryByDateRangeAsync(memoryDir, "2026-03-09", "2026-03-11"),
    new Set([originalPath]),
  );
  // The tag half is NOT committed when the temporal write fails (issue #1911,
  // Cursor Medium): committing tags while temporal stays unchanged leaves a
  // durable mismatch. Both halves stay at their prior state, so "rejected" has
  // no tag membership until a later successful (both-halves) index.
  assert.deepEqual(
    await queryByTagsAsync(memoryDir, ["rejected"]),
    new Set<string>(),
  );

  await indexMemory(memoryDir, rejectedPath, "2026-03-10T12:00:00.000Z", ["rejected"]);
  assert.deepEqual(
    await queryByDateRangeAsync(memoryDir, "2026-03-09", "2026-03-11"),
    new Set([originalPath, rejectedPath]),
  );
});

test("date queries preserve missing, invalid, and valid-empty distinctions", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-load-states-"));
  const statePath = join(memoryDir, "state");
  const temporalPath = join(statePath, "index_time.json");
  await mkdir(statePath, { recursive: true });

  assert.equal(await queryByDateRangeAsync(memoryDir, "2026-03-09", "2026-03-10"), null);

  await writeFile(temporalPath, "{ invalid json", "utf8");
  assert.deepEqual(
    await queryByDateRangeAsync(memoryDir, "2026-03-09", "2026-03-10"),
    new Set(),
  );
  assert.equal(await queryTemporalTimelineAsync(memoryDir), null);

  await writeFile(
    temporalPath,
    JSON.stringify({ version: 2, dates: {}, events: {} }),
    "utf8",
  );
  await writeFile(
    join(statePath, "index_tags.json"),
    JSON.stringify({ version: 2, tags: {}, aliases: {} }),
    "utf8",
  );
  assert.deepEqual(
    await queryByDateRangeAsync(memoryDir, "2026-03-09", "2026-03-10"),
    new Set(),
  );
  assert.equal(await indexesExist(memoryDir), true);
});

test("index writers persist compact machine-only JSON", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-compact-"));
  await indexMemory(
    memoryDir,
    "/tmp/remnic-temporal-compact.md",
    "2026-03-09T12:00:00.000Z",
    ["compact"],
  );

  for (const filename of ["index_time.json", "index_tags.json"]) {
    const raw = await readFile(join(memoryDir, "state", filename), "utf8");
    assert.equal(raw, JSON.stringify(JSON.parse(raw)));
  }
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
const { indexMemoryAsync: indexMemory } = await import(process.argv[1]);
await indexMemory(
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
  // Both halves fail open together (issue #1911, Cursor Medium): the symlinked
  // temporal lock blocks the temporal write, so the tag half is also skipped
  // (no durable mismatch). The tag index is never created → query returns null.
  assert.equal(tagMatches, null);
});

test("tag queries distinguish missing index from valid no-match results", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-index-tag-miss-"));

  assert.equal(await queryByTagsAsync(memoryDir, []), null);
  const unavailableMatches = await queryByTagsAsync(memoryDir, ["beta"]);
  assert.equal(unavailableMatches, null);

  await indexMemory(memoryDir, "/tmp/remnic-temporal-alpha-memory.md", "2026-03-11T12:00:00.000Z", ["alpha"]);

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

  await indexMemory(memoryDir, memoryPath, "2026-01-01T00:00:00.000Z", ["alpha"]);
  await indexMemory(memoryDir, memoryPath, "2026-02-01T00:00:00.000Z", ["beta"]);

  const januaryMatches = await queryByDateRangeAsync(memoryDir, "2026-01-01", "2026-01-02");
  const februaryMatches = await queryByDateRangeAsync(memoryDir, "2026-02-01", "2026-02-02");
  const alphaMatches = await queryByTagsAsync(memoryDir, ["alpha"]);
  const betaMatches = await queryByTagsAsync(memoryDir, ["beta"]);

  assert.deepEqual(januaryMatches, new Set());
  assert.deepEqual(februaryMatches, new Set([memoryPath]));
  assert.deepEqual(alphaMatches, new Set());
  assert.deepEqual(betaMatches, new Set([memoryPath]));
});

test("temporal timeline orders event time across sessions, not ingest order", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-timeline-order-"));
  await indexMemory(memoryDir, "/tmp/rome.md", "2026-07-02T00:00:00.000Z", [], {
    validAt: "2026-05-10T00:00:00.000Z",
    observedAt: "2026-07-02T00:00:00.000Z",
    sessionKey: "session-b",
  });
  await indexMemory(memoryDir, "/tmp/paris.md", "2026-07-03T00:00:00.000Z", [], {
    validAt: "2026-03-04T00:00:00.000Z",
    observedAt: "2026-07-03T00:00:00.000Z",
    sessionKey: "session-a",
  });

  const timeline = await queryTemporalTimelineAsync(memoryDir);
  assert.deepEqual(
    timeline?.map(({ path, eventAt, sessionKey }) => ({ path, eventAt, sessionKey })),
    [
      { path: "/tmp/paris.md", eventAt: "2026-03-04T00:00:00.000Z", sessionKey: "session-a" },
      { path: "/tmp/rome.md", eventAt: "2026-05-10T00:00:00.000Z", sessionKey: "session-b" },
    ],
  );
});

test("temporal timeline uses stable observation/path ordering for event-time ties", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-timeline-tie-"));
  const eventAt = "2026-03-04T00:00:00.000Z";
  await indexMemory(memoryDir, "/tmp/z.md", eventAt, [], { validAt: eventAt, observedAt: "2026-07-03T00:00:00.000Z" });
  await indexMemory(memoryDir, "/tmp/a.md", eventAt, [], { validAt: eventAt, observedAt: "2026-07-02T00:00:00.000Z" });
  await indexMemory(memoryDir, "/tmp/b.md", eventAt, [], { validAt: eventAt, observedAt: "2026-07-02T00:00:00.000Z" });

  const first = await queryTemporalTimelineAsync(memoryDir);
  const second = await queryTemporalTimelineAsync(memoryDir);
  assert.deepEqual(first?.map((entry) => entry.path), ["/tmp/a.md", "/tmp/b.md", "/tmp/z.md"]);
  assert.deepEqual(second, first);
});

test("old or malformed temporal index shape is unavailable and requests rebuild", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-timeline-malformed-"));
  await mkdir(join(memoryDir, "state"), { recursive: true });
  await writeFile(
    join(memoryDir, "state", "index_time.json"),
    JSON.stringify({ version: 2, dates: {}, events: [] }),
    "utf8",
  );
  await writeFile(
    join(memoryDir, "state", "index_tags.json"),
    JSON.stringify({ version: 2, tags: {}, aliases: {} }),
    "utf8",
  );

  assert.deepEqual(
    await queryByDateRangeAsync(memoryDir, "2026-01-01", "2026-01-02"),
    new Set(),
  );
  assert.equal(await indexesExist(memoryDir), false);
  assert.equal(await queryTemporalTimelineAsync(memoryDir), null);

  await writeFile(
    join(memoryDir, "state", "index_time.json"),
    JSON.stringify({ version: 1, dates: {} }),
    "utf8",
  );
  assert.deepEqual(
    await queryByDateRangeAsync(memoryDir, "2026-01-01", "2026-01-02"),
    new Set(),
  );
  assert.equal(await indexesExist(memoryDir), false);
  assert.equal(await queryTemporalTimelineAsync(memoryDir), null);
});

test("deindex removes timeline rows so stale events cannot be recalled", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-timeline-delete-"));
  const memoryPath = "/tmp/deleted.md";
  const createdAt = "2026-03-04T00:00:00.000Z";
  await indexMemory(memoryDir, memoryPath, createdAt, ["trip"], { sessionKey: "session-a" });
  await deindexMemory(memoryDir, memoryPath, createdAt, ["trip"]);
  assert.deepEqual(await queryTemporalTimelineAsync(memoryDir), []);
});

test("large temporal indexes return a bounded relevant oversample before memory reads", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-timeline-bounded-"));
  for (let i = 0; i < 600; i += 1) {
    const day = String((i % 28) + 1).padStart(2, "0");
    await indexMemory(
      memoryDir,
      `/tmp/event-${String(i).padStart(4, "0")}.md`,
      `2026-03-${day}T00:00:00.000Z`,
      [],
      {
        validAt: `2026-03-${day}T00:00:00.000Z`,
        searchText: i === 317 ? "unique-marzipan-trip to Lisbon" : `routine event ${i}`,
      },
    );
  }

  const relevant = await queryTemporalTimelineAsync(memoryDir, {
    query: "When was the marzipan trip to Lisbon?",
    limit: 48,
  });
  assert.ok(relevant);
  assert.ok(relevant.length <= 48);
  assert.ok(relevant.some((entry) => entry.path.endsWith("event-0317.md")));

  const generic = await queryTemporalTimelineAsync(memoryDir, {
    query: "What happened first or last?",
    limit: 48,
  });
  assert.equal(generic?.length, 48);
  assert.equal(generic?.[0]?.eventAt, "2026-03-01T00:00:00.000Z");
  assert.equal(generic?.at(-1)?.eventAt, "2026-03-28T00:00:00.000Z");
});

test("temporal timeline generic edge selection honors small and zero limits", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-temporal-timeline-small-limit-"));
  for (let day = 1; day <= 4; day += 1) {
    const timestamp = `2026-04-0${day}T00:00:00.000Z`;
    await indexMemory(memoryDir, `/tmp/edge-${day}.md`, timestamp, [], {
      validAt: timestamp,
      searchText: `unrelated event ${day}`,
    });
  }

  const genericQuery = "What happened first or last?";
  const limitOne = await queryTemporalTimelineAsync(memoryDir, {
    query: genericQuery,
    limit: 1,
  });
  assert.deepEqual(limitOne?.map((entry) => entry.path), ["/tmp/edge-1.md"]);

  const limitTwo = await queryTemporalTimelineAsync(memoryDir, {
    query: genericQuery,
    limit: 2,
  });
  assert.deepEqual(limitTwo?.map((entry) => entry.path), [
    "/tmp/edge-1.md",
    "/tmp/edge-4.md",
  ]);

  assert.deepEqual(
    await queryTemporalTimelineAsync(memoryDir, { query: genericQuery, limit: 0 }),
    [],
  );
  assert.deepEqual(
    await queryTemporalTimelineAsync(memoryDir, { query: genericQuery, limit: -3 }),
    [],
  );
  assert.deepEqual(
    (await queryTemporalTimelineAsync(memoryDir, {
      query: genericQuery,
      limit: 1.9,
    }))?.map((entry) => entry.path),
    ["/tmp/edge-1.md"],
  );
  assert.equal(
    (await queryTemporalTimelineAsync(memoryDir, {
      query: genericQuery,
      limit: Number.POSITIVE_INFINITY,
    }))?.length,
    4,
  );
});

// ─── #1911B: batch de-index ─────────────────────────────────────────────────

interface DeindexEntry {
  path: string;
  createdAt: string;
  tags: string[];
}

// A spread of memories across distinct dates with hierarchical (alias-producing)
// and flat tags, so equivalence covers date sets, event map, tag graph, and aliases.
function sampleMemories(prefix: string, count: number): DeindexEntry[] {
  const entries: DeindexEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = String((i % 28) + 1).padStart(2, "0");
    entries.push({
      path: `/tmp/${prefix}-memory-${i}.md`,
      createdAt: `2026-05-${day}T09:00:00.000Z`,
      tags: ["project/remnic", `worker/${i % 3}`, "shared", `flat-${i}`],
    });
  }
  return entries;
}

async function seedIndex(memoryDir: string, entries: DeindexEntry[]): Promise<void> {
  for (const e of entries) {
    await indexMemory(memoryDir, e.path, e.createdAt, e.tags);
  }
}

async function readRawIndexes(memoryDir: string): Promise<{ temporal: unknown; tags: unknown }> {
  const temporal = JSON.parse(
    await readFile(join(memoryDir, "state", "index_time.json"), "utf8"),
  );
  const tags = JSON.parse(
    await readFile(join(memoryDir, "state", "index_tags.json"), "utf8"),
  );
  return { temporal, tags };
}

test("#1911B batch de-index yields the same final index as per-memory de-index", async () => {
  const sequentialDir = await mkdtemp(join(tmpdir(), "remnic-deindex-seq-"));
  const batchDir = await mkdtemp(join(tmpdir(), "remnic-deindex-batch-"));
  const all = sampleMemories("equiv", 12);
  await seedIndex(sequentialDir, all);
  await seedIndex(batchDir, all);

  // Remove a non-contiguous subset in a scrambled order; batching must not depend
  // on removal order to reach the same final index.
  const removed = [all[10], all[1], all[7], all[4], all[0]];

  for (const e of removed) {
    await deindexMemory(sequentialDir, e.path, e.createdAt, e.tags);
  }
  await deindexMemoriesBatchAsync(batchDir, removed);

  const seq = await readRawIndexes(sequentialDir);
  const batch = await readRawIndexes(batchDir);
  assert.deepEqual(batch.temporal, seq.temporal);
  assert.deepEqual(batch.tags, seq.tags);

  // Survivors remain, removed paths are gone from both indexes.
  const survivorPaths = all.filter((e) => !removed.includes(e)).map((e) => e.path);
  const stillIndexed = await queryByTagsAsync(batchDir, ["shared"]);
  assert.deepEqual(stillIndexed, new Set(survivorPaths));
});

test("#1911B de-indexing N memories performs exactly one temporal + one tag write", async () => {
  const batchDir = await mkdtemp(join(tmpdir(), "remnic-deindex-writes-batch-"));
  const seqDir = await mkdtemp(join(tmpdir(), "remnic-deindex-writes-seq-"));
  const entries = sampleMemories("writes", 8);
  await seedIndex(batchDir, entries);
  await seedIndex(seqDir, entries);

  const countWrites = (dir: string) => {
    let temporal = 0;
    let tags = 0;
    setIndexWriteObserverForTest((filePath) => {
      // Scope to this directory so unrelated index writes never skew the count.
      if (!filePath.startsWith(dir)) return;
      if (filePath.endsWith("index_time.json")) temporal += 1;
      else if (filePath.endsWith("index_tags.json")) tags += 1;
    });
    return () => {
      setIndexWriteObserverForTest(undefined);
      return { temporal, tags };
    };
  };

  // try/finally guarantees the global observer is cleared even if an awaited
  // op throws, so it can never leak into a later test.
  let batchWrites = { temporal: 0, tags: 0 };
  const stopBatch = countWrites(batchDir);
  try {
    await deindexMemoriesBatchAsync(batchDir, entries);
  } finally {
    batchWrites = stopBatch();
  }
  assert.deepEqual(batchWrites, { temporal: 1, tags: 1 });

  let seqWrites = { temporal: 0, tags: 0 };
  const stopSeq = countWrites(seqDir);
  try {
    for (const e of entries) {
      await deindexMemory(seqDir, e.path, e.createdAt, e.tags);
    }
  } finally {
    seqWrites = stopSeq();
  }
  // The per-memory path is the O(N) amplification this batch API replaces.
  assert.deepEqual(seqWrites, { temporal: entries.length, tags: entries.length });
});

test("#1911B empty batch is a no-op that performs no writes", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-deindex-empty-"));
  await seedIndex(memoryDir, sampleMemories("empty", 2));
  let writes = 0;
  setIndexWriteObserverForTest(() => {
    writes += 1;
  });
  try {
    await deindexMemoriesBatchAsync(memoryDir, []);
  } finally {
    setIndexWriteObserverForTest(undefined);
  }
  assert.equal(writes, 0);
});

test("#1911B batch de-index keeps tag index consistent when the temporal write fails", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-deindex-partialfail-"));
  const entries = sampleMemories("partial", 4);
  await seedIndex(memoryDir, entries);
  const before = await readRawIndexes(memoryDir);

  // Deterministically fail the temporal write via the test-only hook. chmod is a
  // no-op for privileged users (common in CI) and differs on Windows; the hook
  // fails the same branch in every environment. Temporal fails first, so the tag
  // half is skipped, leaving BOTH indexes at their pre-batch contents.
  setIndexWriteFailureForTest((filePath) => filePath.endsWith("index_time.json"));
  try {
    await deindexMemoriesBatchAsync(memoryDir, entries);
  } finally {
    setIndexWriteFailureForTest(undefined);
  }

  const after = await readRawIndexes(memoryDir);
  assert.deepEqual(after.temporal, before.temporal);
  assert.deepEqual(after.tags, before.tags);
});

test("#1911B a throwing write observer cannot fail a committed index write", async () => {
  const throwDir = await mkdtemp(join(tmpdir(), "remnic-deindex-observer-throw-"));
  const controlDir = await mkdtemp(join(tmpdir(), "remnic-deindex-observer-control-"));
  const entries = sampleMemories("obsthrow", 3);
  await seedIndex(throwDir, entries);
  await seedIndex(controlDir, entries);

  // Control: a clean batch de-index with no observer installed.
  await deindexMemoriesBatchAsync(controlDir, entries);

  // Same batch, but the committed-write observer throws. The exception fires
  // only after the temporal rename has committed; if it escaped, the write would
  // retry and ultimately report failure, skipping the paired tag phase and
  // leaving a half-applied index. Isolation must keep the outcome identical to
  // the control on BOTH indexes.
  const observedWrites: string[] = [];
  setIndexWriteObserverForTest((filePath) => {
    // Scope to this directory so a concurrent test's index write never counts.
    if (filePath.startsWith(throwDir)) observedWrites.push(filePath);
    throw new Error("observer boom");
  });
  try {
    await deindexMemoriesBatchAsync(throwDir, entries);
  } finally {
    setIndexWriteObserverForTest(undefined);
  }

  // The observer must have fired once per committed index write, in order:
  // temporal commits first, then tags. This guards against a silent regression
  // where observer dispatch is dropped and the isolation assertions below pass
  // vacuously because nothing ever threw.
  assert.equal(observedWrites.length, 2);
  assert.ok(observedWrites[0]?.endsWith("index_time.json"));
  assert.ok(observedWrites[1]?.endsWith("index_tags.json"));

  const control = await readRawIndexes(controlDir);
  const thrown = await readRawIndexes(throwDir);
  assert.deepEqual(thrown.temporal, control.temporal);
  assert.deepEqual(thrown.tags, control.tags);
});
