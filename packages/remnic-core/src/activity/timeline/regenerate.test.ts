/**
 * Production regenerate flow for timeline-card analysis (issue #2050).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityStore } from "../store.js";
import type { ActivitySnapshot } from "../types.js";
import { parseActivityConfig } from "../config.js";
import { regenerateTimelineDay, timelineDayPath } from "./regenerate.js";
import type { TimelineAnalysisRemoteLlm } from "./analysis-provider.js";

const DATE = "2026-08-17";
const TZ = "UTC";

function snapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    machine: "ws-a",
    capturedAtUtc: "2026-08-17T10:00:00.000Z",
    app: "editor",
    windowTitle: "main.ts",
    text: "visible text must never reach the provider",
    textSource: "ax",
    contentHash: "hash-1",
    ...overrides,
  };
}

async function withStore(
  fn: (store: ActivityStore, memoryDir: string) => Promise<void>,
): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timeline-regen-"));
  const store = ActivityStore.open(memoryDir);
  try {
    await fn(store, memoryDir);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
}

function fakeRemote(handler: () => Promise<{ content: string } | null>): {
  remoteLlm: TimelineAnalysisRemoteLlm;
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    remoteLlm: {
      chatCompletion: async () => {
        calls += 1;
        return handler();
      },
    },
  };
}

test("disabled analysis persists deterministic cards and makes zero provider calls", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
    const result = await regenerateTimelineDay({
      date: DATE,
      timezone: TZ,
      memoryDir,
      store,
      timelineEnabled: true,
      analysis: parseActivityConfig({ timeline: { enabled: true } }).timeline.analysis,
      deps: { remoteLlm: remote.remoteLlm },
    });
    assert.equal(result.status, "disabled");
    assert.equal(result.analyzed, false);
    assert.ok(result.cards.length > 0);
    assert.equal(remote.calls, 0);
    const persisted = JSON.parse(await readFile(timelineDayPath(memoryDir, DATE), "utf8"));
    assert.deepEqual(persisted.cards, result.cards);
  });
});

test("enabled analysis runs once and a second call does not duplicate it", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
    const analysis = parseActivityConfig({
      timeline: { analysis: { enabled: true, provider: "openai", model: "gpt-test" } },
    }).timeline.analysis;
    const first = await regenerateTimelineDay({
      date: DATE,
      timezone: TZ,
      memoryDir,
      store,
      timelineEnabled: true,
      analysis,
      deps: { remoteLlm: remote.remoteLlm },
    });
    assert.equal(first.status, "ok");
    assert.equal(first.analyzed, true);
    assert.equal(remote.calls, 1);
    const second = await regenerateTimelineDay({
      date: DATE,
      timezone: TZ,
      memoryDir,
      store,
      timelineEnabled: true,
      analysis,
      deps: { remoteLlm: remote.remoteLlm },
    });
    assert.equal(second.status, "ok");
    assert.equal(second.written, false);
    assert.equal(remote.calls, 1);
  });
});

test("provider failure persists the deterministic cards", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    const remote = fakeRemote(async () => {
      throw new Error("provider down");
    });
    const analysis = parseActivityConfig({
      timeline: { analysis: { enabled: true, provider: "openai", model: "gpt-test" } },
    }).timeline.analysis;
    const result = await regenerateTimelineDay({
      date: DATE,
      timezone: TZ,
      memoryDir,
      store,
      timelineEnabled: true,
      analysis,
      deps: { remoteLlm: remote.remoteLlm },
    });
    assert.notEqual(result.status, "ok");
    assert.ok(result.cards.length > 0);
    const persisted = JSON.parse(await readFile(timelineDayPath(memoryDir, DATE), "utf8"));
    assert.deepEqual(persisted.cards, result.cards);
    assert.equal(persisted.status, result.status);
  });
});

test("timeline disabled builds nothing and makes zero provider calls", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    const remote = fakeRemote(async () => ({ content: '{"ops":[]}' }));
    const result = await regenerateTimelineDay({
      date: DATE,
      timezone: TZ,
      memoryDir,
      store,
      timelineEnabled: false,
      analysis: parseActivityConfig({
        timeline: { analysis: { enabled: true, provider: "openai", model: "gpt-test" } },
      }).timeline.analysis,
      deps: { remoteLlm: remote.remoteLlm },
    });
    assert.equal(result.status, "timeline_disabled");
    assert.deepEqual(result.cards, []);
    assert.equal(remote.calls, 0);
  });
});

test("local provider request carries the configured analysis.model", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    const seen: Array<string | undefined> = [];
    const result = await regenerateTimelineDay({
      date: DATE,
      timezone: TZ,
      memoryDir,
      store,
      timelineEnabled: true,
      analysis: parseActivityConfig({
        timeline: { analysis: { enabled: true, provider: "local", model: "qwen3.8-27b" } },
      }).timeline.analysis,
      deps: {
        localLlm: {
          chatCompletion: async (_messages, options) => {
            seen.push(options.model);
            return { content: '{"ops":[]}' };
          },
        },
      },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(seen, ["qwen3.8-27b"]);
    assert.equal(result.metadata?.model, "qwen3.8-27b");
  });
});
