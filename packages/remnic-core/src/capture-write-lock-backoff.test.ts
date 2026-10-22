import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isAbortError } from "./abort-error.js";
import {
  CAPTURE_WRITE_LOCK_BUSY_MESSAGE,
  DEFAULT_CAPTURE_WRITE_LOCK_DEADLINE_MS,
  DEFAULT_CAPTURE_WRITE_LOCK_INITIAL_DELAY_MS,
  DEFAULT_CAPTURE_WRITE_LOCK_MAX_DELAY_MS,
  MAX_CAPTURE_WRITE_LOCK_WAIT_MS,
  captureWriteLockDelayMs,
  isTombstoneBlockedCaptureWriteLockBusy,
  resolveCaptureWriteLockBackoffLimits,
} from "./capture-write-lock-backoff.js";
import { parseConfig } from "./config.js";
import { resolveConvergeCaptureWriteLockBackoff } from "./converge-config.js";
import { TombstoneBlockedCaptureWriteLock } from "./storage/tombstone-blocked-capture-mutation.js";
import type { withHeldFileLock } from "./utils/serialize-mutations.js";

const LIMITS = {
  initialDelayMs: DEFAULT_CAPTURE_WRITE_LOCK_INITIAL_DELAY_MS,
  maxDelayMs: DEFAULT_CAPTURE_WRITE_LOCK_MAX_DELAY_MS,
};

test("capture write lock backoff is bounded and capped", () => {
  assert.equal(
    captureWriteLockDelayMs(0, LIMITS, () => 0),
    25
  );
  assert.equal(
    captureWriteLockDelayMs(0, LIMITS, () => 1),
    50
  );
  assert.equal(
    captureWriteLockDelayMs(1, LIMITS, () => 1),
    100
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const exponent = Math.min(attempt, 16);
    const ceiling = Math.min(LIMITS.maxDelayMs, LIMITS.initialDelayMs * 2 ** exponent);
    const floor = Math.ceil(ceiling / 2);
    for (const unit of [0, 0.5, 1]) {
      const delay = captureWriteLockDelayMs(attempt, LIMITS, () => unit);
      assert.ok(delay >= floor && delay <= ceiling, `attempt ${attempt} unit ${unit} delay ${delay}`);
      assert.ok(delay <= DEFAULT_CAPTURE_WRITE_LOCK_MAX_DELAY_MS);
    }
  }

  const capped = { initialDelayMs: 50, maxDelayMs: 2_000 };
  assert.equal(
    captureWriteLockDelayMs(16, capped, () => 1),
    2_000
  );
  assert.equal(
    captureWriteLockDelayMs(19, capped, () => 0),
    1_000
  );
  assert.equal(
    captureWriteLockDelayMs(4, { initialDelayMs: 1, maxDelayMs: 1 }, () => 1),
    1
  );
});

test("capture write lock acquire succeeds after a brief hold", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-lock-brief-"));
  try {
    let now = 0;
    let held = 0;
    let probes = 0;
    let busy = true;
    const sleeps: number[] = [];
    const debugs: string[] = [];
    const warns: string[] = [];
    const lock = new TombstoneBlockedCaptureWriteLock({
      stateDir: dir,
      lockOptions: () => ({
        captureWriteLockInitialDelayMs: 50,
        captureWriteLockMaxDelayMs: 200,
        captureWriteLockDeadlineMs: 1_000,
      }),
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        assert.equal(held, 0, "backoff must run only after every capture lock is released");
        sleeps.push(ms);
        now += ms;
        busy = false;
      },
      logDebug: (message) => debugs.push(message),
      logWarn: (message) => warns.push(message),
      withHeldFileLock: (async (_lockPath, options, task) => {
        assert.equal(options.maxWaitMs, 1);
        assert.equal(options.pollMs, 1);
        probes += 1;
        // The second lock in the chain stays busy for one attempt, while the
        // first lock is already held. Sleep must observe that hold released.
        if (probes % 2 === 0 && busy) {
          return await task(false, { failure: "timeout", refresh: async () => false });
        }
        held += 1;
        try {
          return await task(true, { refresh: async () => true });
        } finally {
          held -= 1;
        }
      }) as typeof withHeldFileLock,
    });

    const value = await lock.withCaptureWriteLock(async () => "acquired", ["first-identity", "second-identity"]);
    assert.equal(value, "acquired");
    assert.ok(sleeps.length >= 1);
    assert.ok(sleeps.every((ms) => ms <= 200));
    assert.equal(warns.length, 0);
    assert.ok(debugs.some((line) => line.includes("backing off")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture write lock deadline fails with the busy error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-lock-deadline-"));
  try {
    let now = 0;
    const held = 0;
    const sleeps: number[] = [];
    const debugs: string[] = [];
    const warns: string[] = [];
    const lock = new TombstoneBlockedCaptureWriteLock({
      stateDir: dir,
      lockOptions: () => ({
        captureWriteLockInitialDelayMs: 20,
        captureWriteLockMaxDelayMs: 20,
        captureWriteLockDeadlineMs: 80,
      }),
      now: () => now,
      random: () => 1,
      sleep: async (ms) => {
        assert.equal(held, 0, "backoff must run only after every capture lock is released");
        assert.ok(ms <= 20);
        sleeps.push(ms);
        now += ms;
      },
      logDebug: (message) => debugs.push(message),
      logWarn: (message) => warns.push(message),
      withHeldFileLock: (async (_lockPath, _options, task) => {
        return await task(false, { failure: "timeout", refresh: async () => false });
      }) as typeof withHeldFileLock,
    });

    await assert.rejects(
      lock.withCaptureWriteLock(async () => "unreachable", "held-identity"),
      (error: unknown) => {
        assert.equal(isTombstoneBlockedCaptureWriteLockBusy(error), true);
        assert.ok(error instanceof Error);
        assert.equal(error.message, CAPTURE_WRITE_LOCK_BUSY_MESSAGE);
        return true;
      }
    );
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /remained busy after 80ms/);
    assert.ok(debugs.length >= 1);
    assert.ok(sleeps.length >= 1);
    assert.ok(now >= 80);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aborted capture write lock does not probe, sleep, or write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-lock-aborted-"));
  try {
    const controller = new AbortController();
    controller.abort();
    let probes = 0;
    let slept = false;
    let ran = false;
    const warns: string[] = [];
    const lock = new TombstoneBlockedCaptureWriteLock({
      stateDir: dir,
      lockOptions: () => ({ captureWriteLockSignal: controller.signal }),
      sleep: async () => {
        slept = true;
      },
      logWarn: (message) => warns.push(message),
      withHeldFileLock: (async () => {
        probes += 1;
        return "held";
      }) as typeof withHeldFileLock,
    });
    await assert.rejects(
      lock.withCaptureWriteLock(async () => {
        ran = true;
        return "written";
      }, "path 1 x"),
      (error: unknown) => isAbortError(error)
    );
    assert.equal(probes, 0);
    assert.equal(slept, false);
    assert.equal(ran, false);
    assert.equal(warns.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort during capture write lock backoff does not run the write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-lock-abort-sleep-"));
  try {
    const controller = new AbortController();
    let probes = 0;
    let ran = false;
    const warns: string[] = [];
    const lock = new TombstoneBlockedCaptureWriteLock({
      stateDir: dir,
      signal: controller.signal,
      lockOptions: () => ({
        captureWriteLockInitialDelayMs: 40,
        captureWriteLockMaxDelayMs: 40,
        captureWriteLockDeadlineMs: 400,
      }),
      now: () => 0,
      random: () => 1,
      sleep: async () => {
        controller.abort();
      },
      logWarn: (message) => warns.push(message),
      withHeldFileLock: (async (_lockPath, _options, task) => {
        probes += 1;
        if (probes === 1) {
          return await task(false, { failure: "timeout", refresh: async () => false });
        }
        return await task(true, { refresh: async () => true });
      }) as typeof withHeldFileLock,
    });
    await assert.rejects(
      lock.withCaptureWriteLock(async () => {
        ran = true;
        return "written";
      }, "held-identity"),
      (error: unknown) => isAbortError(error)
    );
    assert.equal(probes, 1);
    assert.equal(ran, false);
    assert.equal(warns.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort is rechecked after the capture write lock is acquired", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-lock-abort-held-"));
  try {
    const controller = new AbortController();
    let ran = false;
    const lock = new TombstoneBlockedCaptureWriteLock({
      stateDir: dir,
      lockOptions: () => ({ captureWriteLockSignal: controller.signal }),
      withHeldFileLock: (async (_lockPath, _options, task) => {
        controller.abort();
        return await task(true, { refresh: async () => true });
      }) as typeof withHeldFileLock,
    });
    await assert.rejects(
      lock.withCaptureWriteLock(async () => {
        ran = true;
        return "written";
      }, "held-identity"),
      (error: unknown) => isAbortError(error)
    );
    assert.equal(ran, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture write lock backoff config rejects junk and inverted schedules", () => {
  assert.deepEqual(parseConfig({}).converge, { conflictPolicy: "newest-wins" });
  assert.deepEqual(resolveCaptureWriteLockBackoffLimits(undefined), {
    initialDelayMs: DEFAULT_CAPTURE_WRITE_LOCK_INITIAL_DELAY_MS,
    maxDelayMs: DEFAULT_CAPTURE_WRITE_LOCK_MAX_DELAY_MS,
    deadlineMs: DEFAULT_CAPTURE_WRITE_LOCK_DEADLINE_MS,
  });

  const parsed = parseConfig({
    converge: {
      captureWriteLockInitialDelayMs: 40,
      captureWriteLockMaxDelayMs: MAX_CAPTURE_WRITE_LOCK_WAIT_MS + 5,
      captureWriteLockDeadlineMs: MAX_CAPTURE_WRITE_LOCK_WAIT_MS + 9,
    },
  });
  assert.equal(parsed.converge.captureWriteLockInitialDelayMs, 40);
  assert.equal(parsed.converge.captureWriteLockMaxDelayMs, MAX_CAPTURE_WRITE_LOCK_WAIT_MS);
  assert.equal(parsed.converge.captureWriteLockDeadlineMs, MAX_CAPTURE_WRITE_LOCK_WAIT_MS);

  for (const value of [0, 1.5, -1, "50", Number.NaN]) {
    assert.throws(
      () => parseConfig({ converge: { captureWriteLockInitialDelayMs: value as number } }),
      /captureWriteLockInitialDelayMs must be a positive integer/
    );
  }
  assert.throws(
    () =>
      parseConfig({
        converge: { captureWriteLockInitialDelayMs: 80, captureWriteLockMaxDelayMs: 40 },
      }),
    /captureWriteLockInitialDelayMs \(80\) must be <= converge.captureWriteLockMaxDelayMs \(40\)/
  );
  assert.throws(
    () =>
      parseConfig({
        converge: { captureWriteLockMaxDelayMs: 500, captureWriteLockDeadlineMs: 100 },
      }),
    /captureWriteLockMaxDelayMs \(500\) must be <= converge.captureWriteLockDeadlineMs \(100\)/
  );
  assert.throws(
    () => resolveConvergeCaptureWriteLockBackoff({ conflictPolicy: "newest-wins", captureWriteLockDeadlineMs: 40 }),
    /captureWriteLockMaxDelayMs \(2000\) must be <= captureWriteLockDeadlineMs \(40\)/
  );
});

test("capture write lock backoff env yields to config", () => {
  const keys = [
    "REMNIC_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS",
    "REMNIC_CONVERGE_CAPTURE_LOCK_MAX_DELAY_MS",
    "REMNIC_CONVERGE_CAPTURE_LOCK_DEADLINE_MS",
    "ENGRAM_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS",
    "ENGRAM_CONVERGE_CAPTURE_LOCK_MAX_DELAY_MS",
    "ENGRAM_CONVERGE_CAPTURE_LOCK_DEADLINE_MS",
  ] as const;
  const saved = new Map<string, string | undefined>();
  for (const key of keys) saved.set(key, process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.REMNIC_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS = "30";
    process.env.REMNIC_CONVERGE_CAPTURE_LOCK_MAX_DELAY_MS = "90";
    process.env.REMNIC_CONVERGE_CAPTURE_LOCK_DEADLINE_MS = "400";
    assert.deepEqual(resolveConvergeCaptureWriteLockBackoff({ conflictPolicy: "newest-wins" }), {
      initialDelayMs: 30,
      maxDelayMs: 90,
      deadlineMs: 400,
    });

    for (const key of keys) delete process.env[key];
    process.env.ENGRAM_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS = "30";
    process.env.ENGRAM_CONVERGE_CAPTURE_LOCK_MAX_DELAY_MS = "90";
    process.env.ENGRAM_CONVERGE_CAPTURE_LOCK_DEADLINE_MS = "400";
    assert.equal(resolveConvergeCaptureWriteLockBackoff({ conflictPolicy: "newest-wins" }).initialDelayMs, 30);

    process.env.REMNIC_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS = "80";
    const overridden = resolveConvergeCaptureWriteLockBackoff({
      conflictPolicy: "newest-wins",
      captureWriteLockInitialDelayMs: 40,
      captureWriteLockMaxDelayMs: 80,
      captureWriteLockDeadlineMs: 200,
    });
    assert.equal(overridden.initialDelayMs, 40);

    process.env.REMNIC_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS = "0";
    assert.throws(
      () => resolveConvergeCaptureWriteLockBackoff({ conflictPolicy: "newest-wins" }),
      /REMNIC_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS must be a positive integer/
    );
    process.env.REMNIC_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS = "nope";
    assert.throws(
      () => resolveConvergeCaptureWriteLockBackoff({ conflictPolicy: "newest-wins" }),
      /REMNIC_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS must be a positive integer/
    );
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
