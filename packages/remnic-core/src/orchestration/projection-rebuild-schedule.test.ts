import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { watchProjectionRebuildParent } from "../maintenance/projection-rebuild-abort.js";
import { rebuildMemoryProjection } from "../maintenance/rebuild-memory-projection.js";
import { initLogger, resetLogger, type LoggerBackend } from "../logger.js";
import { probeProjectionHealth } from "../memory-projection-store.js";
import { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import {
  createProjectionRebuildScheduleState,
  forkProjectionRebuild,
  maybeRebuildMemoryProjectionScheduled,
  projectionRebuildChildEnv,
  projectionRebuildForkTimeoutMs,
  terminateScheduledProjectionRebuilds,
  type ProjectionRebuildForkRequest,
  type ProjectionRebuildForkResult,
} from "./projection-rebuild-schedule.js";

const PARENT_DISCONNECT_FLAG = "--projection-parent-disconnect-child";

if (process.argv.includes(PARENT_DISCONNECT_FLAG)) {
  const memoryDir = process.argv[process.argv.indexOf(PARENT_DISCONNECT_FLAG) + 1];
  if (!memoryDir) process.exit(1);
  try {
    const signal = watchProjectionRebuildParent();
    process.send?.({ ready: true });
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-06-01T00:00:00.000Z"),
      signal,
    });
  } catch {
    process.exit(1);
  }
  process.exit(0);
}

function config(memoryDir: string, overrides: Record<string, unknown> = {}): PluginConfig {
  return {
    memoryDir,
    defaultNamespace: "ns-schedule",
    projectionRebuildEnabled: true,
    projectionRebuildIntervalMs: 6 * 60 * 60 * 1000,
    projectionRebuildHeapUsageLimit: 0.6,
    ...overrides,
  } as unknown as PluginConfig;
}

function quietHeap() {
  return { used_heap_size: 1, heap_size_limit: 100 };
}

/** Windows reports TerminateProcess as an exit code, not SIGKILL. */
function assertChildKilled(child: { signalCode: NodeJS.Signals | null; exitCode: number | null }): void {
  if (process.platform === "win32") {
    assert.notEqual(child.exitCode, null);
    return;
  }
  assert.equal(child.signalCode, "SIGKILL");
}

/** A storage stand-in whose corpus reads fail the test if the daemon calls them. */
function corpusGuard(memoryDir: string): StorageManager {
  const fail = async (): Promise<never> => {
    throw new Error("daemon read the corpus");
  };
  return {
    dir: memoryDir,
    isSecureStoreUnlocked: () => false,
    readAllMemories: fail,
    readAllColdMemories: fail,
    readArchivedMemories: fail,
    iterateMemoryLifecycleEvents: async function* () {
      throw new Error("daemon read the ledger");
    },
  } as unknown as StorageManager;
}

async function seedFact(memoryDir: string): Promise<void> {
  const dir = path.join(memoryDir, "facts", "2026-01-01");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "fact-1.md"),
    [
      "---",
      "id: fact-1",
      "category: fact",
      "confidence: 0.8",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "status: active",
      "source: test",
      "---",
      "",
      "scheduled rebuild fixture",
      "",
    ].join("\n"),
    "utf8",
  );
}

test("shutting down the parent kills the projection rebuild child", async () => {
  const child = fork(process.execPath, ["-e", "setInterval(() => {}, 1e9);"], { stdio: "ignore" });
  const pending = forkProjectionRebuild(
    { memoryDir: "/tmp/unused", defaultNamespace: "default", now: new Date("2026-06-01T00:00:00.000Z") },
    { timeoutMs: 60_000, spawnChild: () => child },
  );
  terminateScheduledProjectionRebuilds();
  await assert.rejects(pending, /exited/);
  assertChildKilled(child);
});

test("a disconnected parent does not let the rebuild child publish", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-orphan-"));
  const projection = path.join(memoryDir, "state", "memory-projection.sqlite");
  try {
    await seedFact(memoryDir);
    const child = fork(fileURLToPath(import.meta.url), [
      PARENT_DISCONNECT_FLAG,
      memoryDir,
    ], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const outcome = await Promise.race([
      once(child, "message").then(() => "ready" as const),
      once(child, "exit").then(() => "exit" as const),
    ]);
    assert.equal(outcome, "ready");
    child.disconnect();
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0);
    assert.equal(existsSync(projection), false);
    assert.equal(existsSync(`${projection}.tmp`), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a hung projection rebuild child is killed at the timeout", async () => {
  const child = fork(process.execPath, ["-e", "setInterval(() => {}, 1e9);"], { stdio: "ignore" });
  await assert.rejects(
    () => forkProjectionRebuild(
      { memoryDir: "/tmp/unused", defaultNamespace: "default", now: new Date("2026-06-01T00:00:00.000Z") },
      { timeoutMs: 200, spawnChild: () => child },
    ),
    /timed out after 200ms/,
  );
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  assertChildKilled(child);
});

test("the fork hang cap follows a long interval and stays at least 30 minutes", () => {
  assert.equal(projectionRebuildForkTimeoutMs(60_000), 30 * 60 * 1000);
  assert.equal(projectionRebuildForkTimeoutMs(6 * 60 * 60 * 1000), 6 * 60 * 60 * 1000);
  assert.equal(projectionRebuildForkTimeoutMs(Number.NaN), 30 * 60 * 1000);
});

test("projection rebuild child env keeps locators and drops secrets", () => {
  const env = projectionRebuildChildEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/remnic-home",
    OPENAI_API_KEY: "sk-test",
    REMNIC_SECURE_STORE_KEY: "unlock-material",
    NODE_OPTIONS: "--conditions=remnic-source",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/remnic-home");
  assert.equal(env.NODE_OPTIONS, "--conditions=remnic-source");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.REMNIC_SECURE_STORE_KEY, undefined);
});

test("scheduled projection rebuild forks and does not read the corpus in the daemon", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-fork-"));
  const calls: ProjectionRebuildForkRequest[] = [];
  const timeouts: number[] = [];
  try {
    const state = createProjectionRebuildScheduleState();
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir),
      getStorage: () => corpusGuard(memoryDir),
      state,
      heapStatistics: quietHeap,
      forkRebuild: async (request, options) => {
        calls.push(request);
        if (options?.timeoutMs !== undefined) timeouts.push(options.timeoutMs);
        return { currentRows: 4, timelineRows: 5, entityMentionRows: 6 };
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(timeouts, [6 * 60 * 60 * 1000]);
    assert.equal(calls[0]?.memoryDir, memoryDir);
    assert.equal(calls[0]?.defaultNamespace, "ns-schedule");
    assert.equal(state.inFlight, false);
    assert.ok(state.lastRebuildAtMs > 0);

    const again = calls.length;
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir),
      getStorage: () => corpusGuard(memoryDir),
      state,
      heapStatistics: quietHeap,
      forkRebuild: async () => {
        calls.push({ memoryDir, defaultNamespace: "ns-schedule", now: new Date() });
        return { currentRows: 0, timelineRows: 0, entityMentionRows: 0 };
      },
    });
    assert.equal(calls.length, again, "success interval suppresses a second fork");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scheduled projection rebuild keeps in-flight and failure backoff", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-backoff-"));
  try {
    const inFlight = createProjectionRebuildScheduleState();
    inFlight.inFlight = true;
    let forks = 0;
    const forkRebuild = async (): Promise<ProjectionRebuildForkResult> => {
      forks += 1;
      return { currentRows: 0, timelineRows: 0, entityMentionRows: 0 };
    };
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir),
      state: inFlight,
      heapStatistics: quietHeap,
      forkRebuild,
    });
    assert.equal(forks, 0, "in-flight rebuild is not started again");

    const failing = createProjectionRebuildScheduleState();
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir),
      state: failing,
      heapStatistics: quietHeap,
      forkRebuild: async () => {
        throw new Error("runner failed");
      },
    });
    assert.equal(failing.inFlight, false);
    assert.equal(failing.lastRebuildAtMs, 0);
    assert.ok(failing.lastFailureAtMs > 0);
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir),
      state: failing,
      heapStatistics: quietHeap,
      forkRebuild,
    });
    assert.equal(forks, 0, "failure backoff suppresses the retry");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("heap guard postpones a scheduled projection rebuild", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-heap-"));
  const warnings: string[] = [];
  const backend: LoggerBackend = {
    info() {},
    warn(msg) {
      warnings.push(msg);
    },
    error() {},
    debug() {},
  };
  initLogger(backend, false, { timestamps: false });
  try {
    const state = createProjectionRebuildScheduleState();
    let forks = 0;
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir),
      getStorage: () => corpusGuard(memoryDir),
      state,
      heapStatistics: () => ({ used_heap_size: 70, heap_size_limit: 100 }),
      forkRebuild: async () => {
        forks += 1;
        return { currentRows: 0, timelineRows: 0, entityMentionRows: 0 };
      },
    });
    assert.equal(forks, 0);
    assert.equal(state.inFlight, false);
    assert.equal(state.lastRebuildAtMs, 0);
    assert.ok(state.lastFailureAtMs > 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /postponed/);
    assert.match(warnings[0] ?? "", /heap used 70 of limit 100/);
    assert.match(warnings[0] ?? "", /ratio 0\.700/);
    assert.match(warnings[0] ?? "", /projectionRebuildHeapUsageLimit 0\.6/);
  } finally {
    resetLogger();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("heap guard does not postpone at the limit or with an unusable cap", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-heap-ok-"));
  try {
    let forks = 0;
    const forkRebuild = async (): Promise<ProjectionRebuildForkResult> => {
      forks += 1;
      return { currentRows: 1, timelineRows: 0, entityMentionRows: 0 };
    };
    const atLimit = createProjectionRebuildScheduleState();
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir),
      state: atLimit,
      heapStatistics: () => ({ used_heap_size: 60, heap_size_limit: 100 }),
      forkRebuild,
    });
    assert.equal(forks, 1, "ratio equal to the limit still runs");

    const disabled = createProjectionRebuildScheduleState();
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir, { projectionRebuildHeapUsageLimit: 1 }),
      state: disabled,
      heapStatistics: () => ({ used_heap_size: 100, heap_size_limit: 100 }),
      forkRebuild,
    });
    assert.equal(forks, 2, "a limit of 1 never postpones");

    const unusable = createProjectionRebuildScheduleState();
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir),
      state: unusable,
      heapStatistics: () => ({ used_heap_size: 10, heap_size_limit: 0 }),
      forkRebuild,
    });
    assert.equal(forks, 3, "a non-positive heap cap does not postpone");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unlocked secure store rebuilds in-process instead of forking", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-unlocked-"));
  try {
    await seedFact(memoryDir);
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreKey(Buffer.alloc(32, 4), false);
    assert.equal(storage.isSecureStoreUnlocked(), true);
    let forks = 0;
    await maybeRebuildMemoryProjectionScheduled({
      config: config(memoryDir),
      getStorage: () => storage,
      state: createProjectionRebuildScheduleState(),
      heapStatistics: quietHeap,
      forkRebuild: async () => {
        forks += 1;
        throw new Error("forked an unlocked store");
      },
    });
    assert.equal(forks, 0);
    assert.equal(probeProjectionHealth(memoryDir).state, "openable");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
