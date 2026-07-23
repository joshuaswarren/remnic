import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { activityDatabasePath, ActivityStore } from "./store.js";
import { activityDigestPath } from "./digest.js";
import { runActivitySyncOnce } from "./runner.js";
import { activityCursorKey } from "./pipeline.js";
import type {
  ActivityConfig,
  ActivitySnapshot,
  ActivitySnapshotPage,
  ActivitySourceClient,
} from "./types.js";

const NOW = new Date("2026-07-22T18:00:00.000Z");

function snapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    machine: "wire-payload-label",
    capturedAtUtc: "2026-07-22T14:00:00.000Z",
    app: "Browser",
    windowTitle: "Example",
    text: "A synthetic activity snapshot",
    textSource: "ax",
    contentHash: "hash-1",
    ...overrides,
  };
}

/** A recording fixture daemon: serves scripted pages keyed by inbound cursor. */
function fixtureClient(
  machineLabel: string,
  pages: Map<string | null, ActivitySnapshotPage>,
): ActivitySourceClient & { seenCursors: Array<string | null> } {
  const seenCursors: Array<string | null> = [];
  return {
    machineLabel,
    seenCursors,
    async verify() {
      return { ok: true };
    },
    async fetchSnapshots({ cursor, signal }) {
      signal?.throwIfAborted();
      const key = cursor ?? null;
      seenCursors.push(key);
      const page = pages.get(key);
      if (page === undefined) throw new Error(`fixture has no page for cursor ${String(key)}`);
      return page;
    },
  };
}

function enabledConfig(overrides: Partial<ActivityConfig> = {}): ActivityConfig {
  return {
    enabled: true,
    timezone: "UTC",
    syncDays: 1,
    sources: [{ machineLabel: "workstation-a", baseUrl: "http://127.0.0.1:8760" }],
    ...overrides,
  };
}

test("disabled config makes no client, no HTTP call, and no store write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-runner-"));
  try {
    let clientBuilt = false;
    const summary = await runActivitySyncOnce({
      config: {
        enabled: false,
        timezone: "UTC",
        syncDays: 1,
        sources: [{ machineLabel: "workstation-a", baseUrl: "http://127.0.0.1:8760" }],
      },
      memoryDir,
      now: NOW,
      createSourceClient: () => {
        clientBuilt = true;
        throw new Error("disabled runner must never build a source client");
      },
    });

    assert.equal(summary.enabled, false);
    assert.deepEqual(summary.results, []);
    assert.equal(summary.ranCount, 0);
    assert.equal(clientBuilt, false, "no client instantiated while disabled");
    await assert.rejects(
      access(activityDatabasePath(memoryDir)),
      "disabled runner must not open (create) the activity store",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("enabled source syncs from parsed config: persists, renders digest, advances cursor", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-runner-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const client = fixtureClient(
      "workstation-a",
      new Map([
        [null, { snapshots: [snapshot()], nextCursor: "c1" }],
        ["c1", { snapshots: [snapshot({ contentHash: "hash-2" })], nextCursor: null }],
      ]),
    );

    const summary = await runActivitySyncOnce({
      config: enabledConfig(),
      memoryDir,
      store,
      now: NOW,
      createSourceClient: () => client,
    });

    assert.equal(summary.enabled, true);
    assert.equal(summary.ranCount, 1);
    assert.equal(summary.errorCount, 0);
    assert.equal(summary.totalInserted, 2);
    assert.deepEqual(summary.results[0], {
      machineLabel: "workstation-a",
      ran: true,
      fetched: 2,
      inserted: 2,
      duplicates: 0,
      digestsWritten: 1,
      cursor: "c1",
    });
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), "c1");
    assert.match(await readFile(activityDigestPath(memoryDir, "2026-07-22"), "utf8"), /snapshotCount: 2/);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("multi-source: one source's fault is isolated and never advances the other", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-runner-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const healthy = fixtureClient(
      "workstation-a",
      new Map([[null, { snapshots: [snapshot()], nextCursor: null }]]),
    );
    const faulty: ActivitySourceClient = {
      machineLabel: "workstation-b",
      async verify() {
        return { ok: true };
      },
      async fetchSnapshots() {
        throw new Error("daemon connection refused");
      },
    };

    const summary = await runActivitySyncOnce({
      config: enabledConfig({
        sources: [
          { machineLabel: "workstation-a", baseUrl: "http://127.0.0.1:8760" },
          { machineLabel: "workstation-b", baseUrl: "http://127.0.0.1:8761" },
        ],
      }),
      memoryDir,
      store,
      now: NOW,
      createSourceClient: (source) => (source.machineLabel === "workstation-a" ? healthy : faulty),
    });

    assert.equal(summary.ranCount, 1);
    assert.equal(summary.errorCount, 1);
    const byLabel = new Map(summary.results.map((item) => [item.machineLabel, item]));
    assert.equal(byLabel.get("workstation-a")?.ran, true);
    assert.equal(byLabel.get("workstation-a")?.inserted, 1);
    assert.equal(byLabel.get("workstation-a")?.error, undefined);
    assert.equal(byLabel.get("workstation-b")?.ran, false);
    assert.match(byLabel.get("workstation-b")?.error ?? "", /connection refused/);
    // The healthy source still committed; the faulty one never wrote a cursor.
    assert.equal(store.getCursor(activityCursorKey("workstation-b", "2026-07-22")), null);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("error stays distinguishable from an empty page", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-runner-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const empty = fixtureClient(
      "empty-src",
      new Map([[null, { snapshots: [], nextCursor: null }]]),
    );
    const faulty: ActivitySourceClient = {
      machineLabel: "fault-src",
      async verify() {
        return { ok: true };
      },
      async fetchSnapshots() {
        throw new Error("HTTP 503");
      },
    };

    const summary = await runActivitySyncOnce({
      config: enabledConfig({
        sources: [
          { machineLabel: "empty-src", baseUrl: "http://127.0.0.1:8760" },
          { machineLabel: "fault-src", baseUrl: "http://127.0.0.1:8761" },
        ],
      }),
      memoryDir,
      store,
      now: NOW,
      createSourceClient: (source) => (source.machineLabel === "empty-src" ? empty : faulty),
    });

    const byLabel = new Map(summary.results.map((item) => [item.machineLabel, item]));
    // Empty page: a real, successful sync that fetched and inserted nothing.
    assert.equal(byLabel.get("empty-src")?.ran, true);
    assert.equal(byLabel.get("empty-src")?.inserted, 0);
    assert.equal(byLabel.get("empty-src")?.error, undefined);
    // Fault: surfaced as an error, not silently conflated with an empty result.
    assert.equal(byLabel.get("fault-src")?.ran, false);
    assert.notEqual(byLabel.get("fault-src")?.error, undefined);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("stop: an aborted run leaves the cursor unadvanced", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-runner-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const client = fixtureClient(
      "workstation-a",
      new Map([[null, { snapshots: [snapshot()], nextCursor: null }]]),
    );

    const summary = await runActivitySyncOnce({
      config: enabledConfig(),
      memoryDir,
      store,
      now: NOW,
      signal: AbortSignal.abort(),
      createSourceClient: () => client,
    });

    assert.equal(summary.errorCount, 1);
    assert.equal(summary.ranCount, 0);
    assert.equal(client.seenCursors.length, 0, "aborted before any fetch reached the daemon");
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), null, "no cursor persisted on abort");
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("restart: a fresh run resumes from the persisted cursor", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-runner-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const first = fixtureClient(
      "workstation-a",
      new Map([
        [null, { snapshots: [snapshot()], nextCursor: "c1" }],
        ["c1", { snapshots: [snapshot({ contentHash: "hash-2" })], nextCursor: null }],
      ]),
    );
    await runActivitySyncOnce({
      config: enabledConfig(),
      memoryDir,
      store,
      now: NOW,
      createSourceClient: () => first,
    });
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), "c1");

    // Simulate a process restart: a brand-new client that only knows how to
    // continue from the persisted cursor. If the runner ignored it, this
    // fixture would throw ("no page for cursor null").
    const second = fixtureClient(
      "workstation-a",
      new Map([["c1", { snapshots: [snapshot({ contentHash: "hash-3" })], nextCursor: null }]]),
    );
    const summary = await runActivitySyncOnce({
      config: enabledConfig(),
      memoryDir,
      store,
      now: NOW,
      createSourceClient: () => second,
    });

    assert.deepEqual(second.seenCursors, ["c1"], "restart resumed from the stored cursor");
    assert.equal(summary.results[0]?.inserted, 1);
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), "c1");
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("reindexSearch is forwarded per source and a failure never fails the run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-runner-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const client = fixtureClient(
      "workstation-a",
      new Map([[null, { snapshots: [snapshot()], nextCursor: null }]]),
    );
    let reindexCalls = 0;
    const summary = await runActivitySyncOnce({
      config: enabledConfig(),
      memoryDir,
      store,
      now: NOW,
      createSourceClient: () => client,
      reindexSearch: async () => {
        reindexCalls += 1;
        throw new Error("qmd offline");
      },
    });

    assert.equal(reindexCalls, 1, "the runner forwards reindexSearch to the source sync");
    assert.equal(summary.ranCount, 1, "a reindex failure does not fail the source");
    assert.equal(summary.errorCount, 0);
    assert.equal(summary.results[0]?.ran, true);
    assert.equal(summary.results[0]?.inserted, 1);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
