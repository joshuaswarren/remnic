/**
 * Production regenerate flow for timeline-card analysis (issue #2050).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityStore } from "../store.js";
import type { ActivitySnapshot } from "../types.js";
import { parseActivityConfig } from "../config.js";
import {
  listPersistedTimelineDates,
  localDatesForUtcRange,
  regenerateTimelineDay,
  resolveTimelineLoadDates,
  timelineDayPath,
} from "./regenerate.js";
import type { TimelineAnalysisRemoteLlm } from "./analysis-provider.js";
import { TimelineCorrectionStore } from "./corrections.js";

const DATE = "2026-08-17";
const TZ = "UTC";
const DATE_B = "2026-08-18";

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

function recordingRemote() {
  const prompts: string[] = [];
  const remoteLlm: TimelineAnalysisRemoteLlm = {
    chatCompletion: async (messages) => {
      prompts.push(messages[0]?.content ?? "");
      return { content: '{"ops":[]}' };
    },
  };
  return { remoteLlm, prompts };
}

function persistCorrection(
  memoryDir: string,
  cardId: string,
  title: string,
  editedAtUtc: string,
): void {
  const corrections = TimelineCorrectionStore.open(memoryDir);
  try {
    corrections.upsert({ cardId, title, editedAtUtc });
  } finally {
    corrections.close();
  }
}

function persistedSourceHash(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("sourceHash" in parsed) ||
    typeof parsed.sourceHash !== "string"
  ) {
    throw new Error("persisted day missing sourceHash");
  }
  return parsed.sourceHash;
}

function priorEditsFromPrompt(prompt: string): unknown {
  const parsed: unknown = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
  if (parsed === null || typeof parsed !== "object" || !("priorEdits" in parsed)) {
    throw new Error("analysis prompt missing priorEdits");
  }
  return parsed.priorEdits;
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

test("enabled analysis prewrites pending, and a pending day is re-analyzed", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    const seenOnDisk: string[] = [];
    let calls = 0;
    const remote: TimelineAnalysisRemoteLlm = {
      chatCompletion: async () => {
        calls += 1;
        const onDisk = JSON.parse(await readFile(timelineDayPath(memoryDir, DATE), "utf8")) as {
          status: string;
        };
        seenOnDisk.push(onDisk.status);
        return { content: '{"ops":[]}' };
      },
    };
    const analysis = parseActivityConfig({
      timeline: { analysis: { enabled: true, provider: "openai", model: "gpt-test" } },
    }).timeline.analysis;
    const run = () =>
      regenerateTimelineDay({
        date: DATE,
        timezone: TZ,
        memoryDir,
        store,
        timelineEnabled: true,
        analysis,
        deps: { remoteLlm: remote },
      });
    const first = await run();
    assert.equal(first.status, "ok");
    assert.deepEqual(seenOnDisk, ["pending"], "the deterministic prewrite must persist pending, not disabled");
    // Simulate a crash between the prewrite and the final write.
    const persisted = JSON.parse(await readFile(timelineDayPath(memoryDir, DATE), "utf8")) as {
      status: string;
    };
    persisted.status = "pending";
    await writeFile(timelineDayPath(memoryDir, DATE), `${JSON.stringify(persisted)}\n`);
    const second = await run();
    assert.equal(second.status, "ok");
    assert.equal(calls, 2, "a pending prewrite must be re-analyzed, not skipped forever");
  });
});

test("a legacy disabled file is re-analyzed once analysis is enabled", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    let calls = 0;
    const remote: TimelineAnalysisRemoteLlm = {
      chatCompletion: async () => {
        calls += 1;
        return { content: '{"ops":[]}' };
      },
    };
    const analysis = parseActivityConfig({
      timeline: { analysis: { enabled: true, provider: "openai", model: "gpt-test" } },
    }).timeline.analysis;
    const run = () =>
      regenerateTimelineDay({
        date: DATE,
        timezone: TZ,
        memoryDir,
        store,
        timelineEnabled: true,
        analysis,
        deps: { remoteLlm: remote },
      });
    await run();
    // Simulate the old prewrite behavior: enabled input, disabled file.
    const persisted = JSON.parse(await readFile(timelineDayPath(memoryDir, DATE), "utf8")) as {
      status: string;
    };
    persisted.status = "disabled";
    await writeFile(timelineDayPath(memoryDir, DATE), `${JSON.stringify(persisted)}\n`);
    const second = await run();
    assert.equal(second.status, "ok");
    assert.equal(calls, 2, "a disabled file under an enabled request must be re-analyzed");
  });
});

test("a completed provider failure is terminal for unchanged evidence", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    let calls = 0;
    const remote: TimelineAnalysisRemoteLlm = {
      chatCompletion: async () => {
        calls += 1;
        throw new Error("provider down");
      },
    };
    const analysis = parseActivityConfig({
      timeline: { analysis: { enabled: true, provider: "openai", model: "gpt-test" } },
    }).timeline.analysis;
    const run = () =>
      regenerateTimelineDay({
        date: DATE,
        timezone: TZ,
        memoryDir,
        store,
        timelineEnabled: true,
        analysis,
        deps: { remoteLlm: remote },
      });
    const first = await run();
    assert.equal(first.status, "provider_failed");
    const second = await run();
    assert.equal(second.status, "provider_failed");
    assert.equal(second.written, false);
    assert.equal(calls, 1, "unchanged evidence must not repeat the provider call");
  });
});

test("resolveTimelineLoadDates keeps a bounded window and expands an unbounded one", () => {
  const store = {
    snapshotCaptureExtent: () => ({ firstUtc: "2026-05-01T01:00:00.000Z", lastUtc: "2026-05-03T23:00:00.000Z" }),
  };
  const bounded = resolveTimelineLoadDates({
    window: { from: "2026-05-02T00:00:00.000Z", to: "2026-05-04T00:00:00.000Z" },
    timezone: "UTC",
    today: "2026-08-23",
    store,
    persistedDates: [],
  });
  assert.deepEqual(bounded, ["2026-05-02", "2026-05-03"]);
  const unbounded = resolveTimelineLoadDates({
    window: {},
    timezone: "UTC",
    today: "2026-08-23",
    store,
    persistedDates: ["2026-04-28"],
  });
  assert.deepEqual(unbounded, ["2026-04-28", "2026-05-01", "2026-05-02", "2026-05-03", "2026-08-23"]);
  const empty = resolveTimelineLoadDates({
    window: {},
    timezone: "UTC",
    today: "2026-08-23",
    store: { snapshotCaptureExtent: () => null },
    persistedDates: [],
  });
  assert.deepEqual(empty, ["2026-08-23"]);
});

test("resolveTimelineLoadDates loads the local day of a lone bound, never today (#2931)", () => {
  const store = { snapshotCaptureExtent: () => null };
  const base = { timezone: "UTC" as const, today: "2026-08-23", store, persistedDates: [] as string[] };

  const loneTo = resolveTimelineLoadDates({
    ...base,
    window: { to: "2026-05-02T12:00:00.000Z" },
  });
  assert.deepEqual(loneTo, ["2026-05-02"], "a lone --to must load the day of the to instant, not today");

  const loneFrom = resolveTimelineLoadDates({
    ...base,
    window: { from: "2026-05-02T12:00:00.000Z" },
  });
  assert.deepEqual(loneFrom, ["2026-05-02"], "a lone --from keeps loading its own day");

  const futureTo = resolveTimelineLoadDates({
    ...base,
    window: { to: "2026-09-01T12:00:00.000Z" },
  });
  assert.deepEqual(futureTo, ["2026-09-01"], "a lone future --to loads that future day, not today");
});

test("resolveTimelineLoadDates resolves a lone --to day through the configured timezone (#2931)", () => {
  const store = { snapshotCaptureExtent: () => null };
  // 2026-08-20T23:30Z is 2026-08-21 13:30 in Kiritimati (UTC+14) but still
  // 2026-08-20 in Adak (UTC-10): the same instant must load different local
  // days under the two configured zones, proving the configured timezone —
  // not UTC and not today — drives the resolution.
  const east = resolveTimelineLoadDates({
    window: { to: "2026-08-20T23:30:00.000Z" },
    timezone: "Pacific/Kiritimati",
    today: "2026-08-23",
    store,
    persistedDates: [],
  });
  assert.deepEqual(east, ["2026-08-21"]);

  const west = resolveTimelineLoadDates({
    window: { to: "2026-08-20T23:30:00.000Z" },
    timezone: "America/Adak",
    today: "2026-08-23",
    store,
    persistedDates: [],
  });
  assert.deepEqual(west, ["2026-08-20"]);
});

test("localDatesForUtcRange covers a multi-year span for unbounded search", () => {
  const dates = localDatesForUtcRange(
    Date.parse("2020-01-01T00:00:00.000Z"),
    Date.parse("2026-08-23T00:00:00.000Z"),
    "UTC",
  );
  assert.equal(dates[0], "2020-01-01");
  assert.equal(dates[dates.length - 1], "2026-08-22");
  assert.ok(dates.length > 2400, `expected full history, got ${dates.length} days`);
});

test("listPersistedTimelineDates lists only valid day files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timeline-days-"));
  try {
    const dir = path.join(memoryDir, "activity", "timeline");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "2026-08-17.json"), "{}\n");
    await writeFile(path.join(dir, "2026-08-18.json.tmp"), "{}\n");
    await writeFile(path.join(dir, "notes.txt"), "");
    assert.deepEqual(listPersistedTimelineDates(memoryDir), ["2026-08-17"]);
    assert.deepEqual(listPersistedTimelineDates(path.join(memoryDir, "missing")), []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a correction for another day does not change this day's hash, cache, or provider input", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    store.insertSnapshot(
      snapshot({ capturedAtUtc: "2026-08-18T10:00:00.000Z", contentHash: "hash-2", windowTitle: "other.ts" }),
    );
    const analysis = parseActivityConfig({
      timeline: { analysis: { enabled: true, provider: "openai", model: "gpt-test" } },
    }).timeline.analysis;
    const remote = recordingRemote();
    const runA = () =>
      regenerateTimelineDay({
        date: DATE,
        timezone: TZ,
        memoryDir,
        store,
        timelineEnabled: true,
        analysis,
        deps: { remoteLlm: remote.remoteLlm },
      });
    const first = await runA();
    assert.equal(first.status, "ok");
    assert.equal(remote.prompts.length, 1);
    assert.deepEqual(priorEditsFromPrompt(remote.prompts[0] ?? ""), []);
    const firstHash = persistedSourceHash(await readFile(timelineDayPath(memoryDir, DATE), "utf8"));

    const dayB = await regenerateTimelineDay({
      date: DATE_B,
      timezone: TZ,
      memoryDir,
      store,
      timelineEnabled: true,
      analysis: parseActivityConfig({ timeline: { enabled: true } }).timeline.analysis,
    });
    const dayBCard = dayB.cards.find((card) => card.kind === "activity");
    assert.ok(dayBCard);
    persistCorrection(memoryDir, dayBCard.id, "Other-day title", "2026-08-18T12:00:00.000Z");

    const cached = await runA();
    assert.equal(cached.written, false);
    assert.equal(cached.analyzed, false);
    assert.equal(remote.prompts.length, 1);
    assert.equal(persistedSourceHash(await readFile(timelineDayPath(memoryDir, DATE), "utf8")), firstHash);

    await rm(timelineDayPath(memoryDir, DATE));
    const rebuilt = await runA();
    assert.equal(rebuilt.status, "ok");
    assert.equal(remote.prompts.length, 2);
    assert.deepEqual(priorEditsFromPrompt(remote.prompts[1] ?? ""), []);
    assert.equal(persistedSourceHash(await readFile(timelineDayPath(memoryDir, DATE), "utf8")), firstHash);
  });
});

test("a same-day correction updates hash, cards, and priorEdits", async () => {
  await withStore(async (store, memoryDir) => {
    store.insertSnapshot(snapshot());
    const analysis = parseActivityConfig({
      timeline: { analysis: { enabled: true, provider: "openai", model: "gpt-test" } },
    }).timeline.analysis;
    const remote = recordingRemote();
    const run = () =>
      regenerateTimelineDay({
        date: DATE,
        timezone: TZ,
        memoryDir,
        store,
        timelineEnabled: true,
        analysis,
        deps: { remoteLlm: remote.remoteLlm },
      });
    const first = await run();
    const activity = first.cards.find((card) => card.kind === "activity");
    assert.ok(activity);
    const firstHash = persistedSourceHash(await readFile(timelineDayPath(memoryDir, DATE), "utf8"));
    persistCorrection(memoryDir, activity.id, "Same-day title", "2026-08-17T12:00:00.000Z");

    const second = await run();
    assert.equal(second.status, "ok");
    assert.equal(second.analyzed, true);
    assert.equal(remote.prompts.length, 2);
    const edited = second.cards.find((card) => card.id === activity.id);
    assert.equal(edited?.title, "Same-day title");
    assert.equal(edited?.manualEdit?.title, "Same-day title");
    assert.deepEqual(priorEditsFromPrompt(remote.prompts[1] ?? ""), [
      { cardId: activity.id, title: "Same-day title", editedAtUtc: "2026-08-17T12:00:00.000Z" },
    ]);
    assert.notEqual(persistedSourceHash(await readFile(timelineDayPath(memoryDir, DATE), "utf8")), firstHash);
  });
});

