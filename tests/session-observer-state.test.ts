import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { SessionObserverState } from "../src/session-observer-state.ts";

test("session observer establishes baseline then triggers when threshold is crossed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-"));
  try {
    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 1_000, triggerDeltaTokens: 200 }],
    });
    await observer.load();

    const baseline = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_500,
      observedAt: "2026-02-25T00:00:00.000Z",
    });
    assert.equal(baseline.triggered, false);
    assert.equal(baseline.reason, "baseline");

    const trigger = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 11_500,
      totalTokens: 2_900,
      observedAt: "2026-02-25T00:01:00.000Z",
    });
    assert.equal(trigger.triggered, true);
    assert.equal(trigger.reason, "threshold");
    assert.equal(trigger.deltaBytes, 1_500);
    assert.equal(trigger.deltaTokens, 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer applies per-session debounce after trigger", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-debounce-"));
  try {
    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 120_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await observer.load();

    await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_500,
      observedAt: "2026-02-25T00:00:00.000Z",
    });
    const first = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 11_000,
      totalTokens: 2_700,
      observedAt: "2026-02-25T00:01:00.000Z",
    });
    assert.equal(first.triggered, true);

    const debounced = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 12_000,
      totalTokens: 2_900,
      observedAt: "2026-02-25T00:02:00.000Z",
    });
    assert.equal(debounced.triggered, false);
    assert.equal(debounced.reason, "debounced");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer persists non-threshold and debounced updates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-persist-"));
  try {
    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 120_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await observer.load();

    await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_500,
      observedAt: "2026-02-25T00:00:00.000Z",
    });
    await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_200,
      totalTokens: 2_540,
      observedAt: "2026-02-25T00:00:30.000Z",
    });
    await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_800,
      totalTokens: 2_700,
      observedAt: "2026-02-25T00:01:00.000Z",
    });
    await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 11_100,
      totalTokens: 2_760,
      observedAt: "2026-02-25T00:01:20.000Z",
    });

    const savedPath = path.join(dir, "state", "session-observer-state.json");
    const raw = await readFile(savedPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      sessions: Record<
        string,
        {
          cursorBytes: number;
          cursorTokens: number;
          lastObservedAt: string;
          lastTriggeredAt?: string;
        }
      >;
    };

    const session = parsed.sessions["agent:generalist:main"];
    assert.ok(session);
    assert.equal(session.cursorBytes, 10_800);
    assert.equal(session.cursorTokens, 2_700);
    assert.equal(session.lastObservedAt, "2026-02-25T00:01:20.000Z");
    assert.equal(session.lastTriggeredAt, "2026-02-25T00:01:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer save merges shared state across instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-merge-"));
  try {
    const a = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    const b = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await a.load();
    await b.load();

    await a.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_000,
      observedAt: "2026-02-25T00:00:00.000Z",
    });
    await b.observe({
      sessionKey: "agent:research:main",
      totalBytes: 20_000,
      totalTokens: 4_000,
      observedAt: "2026-02-25T00:00:10.000Z",
    });

    const raw = await readFile(path.join(dir, "state", "session-observer-state.json"), "utf-8");
    const parsed = JSON.parse(raw) as { sessions: Record<string, unknown> };
    assert.ok(parsed.sessions["agent:generalist:main"]);
    assert.ok(parsed.sessions["agent:research:main"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer does not trigger when both thresholds are zero", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-zero-threshold-"));
  try {
    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 0, triggerDeltaTokens: 0 }],
    });
    await observer.load();

    await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_000,
      observedAt: "2026-02-25T00:00:00.000Z",
    });
    const second = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 99_000,
      totalTokens: 9_900,
      observedAt: "2026-02-25T00:01:00.000Z",
    });
    assert.equal(second.triggered, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer concurrent saves preserve both instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-lock-"));
  try {
    const a = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    const b = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await a.load();
    await b.load();

    await Promise.all([
      a.observe({
        sessionKey: "agent:generalist:main",
        totalBytes: 10_000,
        totalTokens: 2_000,
        observedAt: "2026-02-25T00:00:00.000Z",
      }),
      b.observe({
        sessionKey: "agent:research:main",
        totalBytes: 20_000,
        totalTokens: 4_000,
        observedAt: "2026-02-25T00:00:00.000Z",
      }),
    ]);

    const raw = await readFile(path.join(dir, "state", "session-observer-state.json"), "utf-8");
    const parsed = JSON.parse(raw) as { sessions: Record<string, unknown> };
    assert.ok(parsed.sessions["agent:generalist:main"]);
    assert.ok(parsed.sessions["agent:research:main"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer concurrent instances debounce threshold decisions against shared state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-concurrent-trigger-"));
  try {
    const opts = {
      memoryDir: dir,
      debounceMs: 120_000,
      bands: [{ maxBytes: 1_000_000, triggerDeltaBytes: 100, triggerDeltaTokens: 100 }],
    };
    const a = new SessionObserverState(opts);
    const b = new SessionObserverState(opts);
    await a.load();
    await b.load();

    await a.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 0,
      totalTokens: 0,
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    await b.load();

    const decisions = await Promise.all([
      a.observe({
        sessionKey: "agent:generalist:main",
        totalBytes: 200,
        totalTokens: 200,
        observedAt: "2026-01-01T00:01:00.000Z",
      }),
      b.observe({
        sessionKey: "agent:generalist:main",
        totalBytes: 200,
        totalTokens: 200,
        observedAt: "2026-01-01T00:01:00.000Z",
      }),
    ]);

    assert.equal(decisions.filter((decision) => decision.triggered).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer recovers stale lock files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-stale-lock-"));
  try {
    const stateDir = path.join(dir, "state");
    const lockPath = path.join(stateDir, "session-observer-state.lock");
    await mkdir(stateDir, { recursive: true });
    await writeFile(lockPath, "stale", "utf-8");
    const stale = new Date(Date.now() - 5 * 60_000);
    await utimes(lockPath, stale, stale);

    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await observer.load();
    await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_000,
      observedAt: "2026-02-25T00:00:00.000Z",
    });

    const raw = await readFile(path.join(stateDir, "session-observer-state.json"), "utf-8");
    const parsed = JSON.parse(raw) as { sessions: Record<string, unknown> };
    assert.ok(parsed.sessions["agent:generalist:main"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer skips state writes when heartbeat footprint is unchanged", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-unchanged-"));
  try {
    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await observer.load();

    await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_500,
      observedAt: "2026-02-25T00:00:00.000Z",
    });

    const savedPath = path.join(dir, "state", "session-observer-state.json");
    const firstWrite = await stat(savedPath);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_500,
      observedAt: "2026-02-25T00:00:10.000Z",
    });

    const secondWrite = await stat(savedPath);
    assert.equal(result.triggered, false);
    assert.equal(result.deltaBytes, 0);
    assert.equal(result.deltaTokens, 0);
    assert.equal(secondWrite.mtimeMs, firstWrite.mtimeMs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer merge keeps monotonic cursor across stale instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-monotonic-"));
  try {
    const fresh = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    const stale = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await fresh.load();
    await stale.load();

    await fresh.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 3_000,
      totalTokens: 750,
      observedAt: "2026-02-25T00:00:00.000Z",
    });
    await stale.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 1_200,
      totalTokens: 300,
      observedAt: "2026-02-25T00:01:00.000Z",
    });

    const raw = await readFile(path.join(dir, "state", "session-observer-state.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      sessions: Record<string, { cursorBytes: number; cursorTokens: number; lastObservedAt: string }>;
    };
    const session = parsed.sessions["agent:generalist:main"];
    assert.ok(session);
    assert.equal(session.cursorBytes, 3_000);
    assert.equal(session.cursorTokens, 750);
    assert.equal(session.lastObservedAt, "2026-02-25T00:01:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer merge allows cursor reset when reset is explicitly observed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-reset-"));
  try {
    const a = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    const b = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await a.load();
    await b.load();

    await a.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 3_000,
      totalTokens: 750,
      observedAt: "2026-02-25T00:00:00.000Z",
    });
    // Simulate transcript reset on the newer observer path.
    await a.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 1_000,
      totalTokens: 250,
      observedAt: "2026-02-25T00:02:00.000Z",
    });
    // Stale instance writes an older, larger cursor with older observation timestamp.
    await b.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 2_500,
      totalTokens: 625,
      observedAt: "2026-02-25T00:01:00.000Z",
    });

    const raw = await readFile(path.join(dir, "state", "session-observer-state.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      sessions: Record<
        string,
        { cursorBytes: number; cursorTokens: number; lastObservedAt: string; lastResetAt?: string }
      >;
    };
    const session = parsed.sessions["agent:generalist:main"];
    assert.ok(session);
    assert.equal(session.cursorBytes, 1_000);
    assert.equal(session.cursorTokens, 250);
    assert.equal(session.lastObservedAt, "2026-02-25T00:02:00.000Z");
    assert.equal(session.lastResetAt, "2026-02-25T00:02:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer observe fails when save lock remains held", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-lock-timeout-"));
  try {
    const stateDir = path.join(dir, "state");
    const lockPath = path.join(stateDir, "session-observer-state.lock");
    await mkdir(stateDir, { recursive: true });
    await writeFile(lockPath, "locked", "utf-8");
    const now = new Date();
    await utimes(lockPath, now, now);

    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await observer.load();

    await assert.rejects(
      () =>
        observer.observe({
          sessionKey: "agent:generalist:main",
          totalBytes: 10_000,
          totalTokens: 2_500,
          observedAt: "2026-02-25T00:00:00.000Z",
        }),
      /save lock timeout/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer save queue recovers after transient lock failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-lock-recover-"));
  try {
    const stateDir = path.join(dir, "state");
    const lockPath = path.join(stateDir, "session-observer-state.lock");
    await mkdir(stateDir, { recursive: true });
    await writeFile(lockPath, "locked", "utf-8");
    const now = new Date();
    await utimes(lockPath, now, now);

    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await observer.load();

    await assert.rejects(
      () =>
        observer.observe({
          sessionKey: "agent:generalist:main",
          totalBytes: 10_000,
          totalTokens: 2_500,
          observedAt: "2026-02-25T00:00:00.000Z",
        }),
      /save lock timeout/i,
    );

    await unlink(lockPath);
    const second = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_200,
      totalTokens: 2_550,
      observedAt: "2026-02-25T00:01:00.000Z",
    });
    assert.equal(second.triggered, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
