import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { abortError } from "./abort-error.js";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { AccessObserveWriteSurface } from "./access-observe-write-surface.js";
import { Orchestrator } from "./orchestrator.js";
import { buildBriefing, type ParsedBriefingWindow } from "./briefing.js";
import type { CorpusReadOptions } from "./corpus-read-cancellation.js";
import { StorageManager } from "./storage.js";
import type { WindowedMemoryReadOptions, WindowedMemoryReadResult } from "./storage/windowed-memory-read.js";
import type { EntityFile, MemoryFile } from "./types.js";

const WINDOW: ParsedBriefingWindow = {
  from: new Date("2026-04-10T00:00:00.000Z"),
  to: new Date("2026-04-11T00:00:00.000Z"),
  label: "test-window",
};
const MEMORY: MemoryFile = {
  path: "/synthetic/mem.md",
  frontmatter: {
    id: "synthetic-mem",
    category: "fact",
    created: "2026-04-10T01:00:00.000Z",
    updated: "2026-04-10T02:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
  },
  content: "synthetic briefing memory",
};
const ENTITY: EntityFile = {
  name: "SyntheticEntity",
  type: "project",
  updated: "2026-04-10T03:00:00.000Z",
  facts: ["synthetic fact"],
  timeline: [],
  relationships: [],
  activity: [],
  aliases: [],
};

function makeStorage(t: TestContext): StorageManager {
  const dir = mkdtempSync(path.join(os.tmpdir(), "remnic-briefing-abort-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = new StorageManager(dir);
  t.mock.method(storage, "readMemoriesWindow", async (_options: WindowedMemoryReadOptions) => ({
    memories: [MEMORY],
    filePaths: [MEMORY.path],
  }));
  t.mock.method(storage, "readAllEntityFiles", async (_options?: CorpusReadOptions) => [ENTITY]);
  return storage;
}

function makeStallingStorage(t: TestContext) {
  const storage = makeStorage(t);
  const fallback = Promise.withResolvers<void>();
  // The fallback releases broken signal plumbing too, so the regression cannot hang.
  t.mock.method(
    storage,
    "readMemoriesWindow",
    (options: WindowedMemoryReadOptions): Promise<WindowedMemoryReadResult> => {
      const signal = options.abortSignal;
      if (!signal) return fallback.promise.then(() => ({ memories: [], filePaths: [] }));
      const read = Promise.withResolvers<WindowedMemoryReadResult>();
      const onAbort = () => read.reject(abortError("corpus read aborted"));
      if (signal.aborted) {
        onAbort();
        return read.promise;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void fallback.promise.then(() => {
        signal.removeEventListener("abort", onAbort);
        read.resolve({ memories: [], filePaths: [] });
      });
      return read.promise;
    }
  );
  return { storage, releaseFallback: fallback.resolve };
}

test("buildBriefing rejects with an AbortError when the caller's cancel signal fires mid-read", async (t) => {
  const { storage, releaseFallback } = makeStallingStorage(t);
  const controller = new AbortController();
  const call = buildBriefing({ storage, window: WINDOW, allowLlm: false, abortSignal: controller.signal });
  controller.abort();
  releaseFallback();
  await assert.rejects(call, { name: "AbortError", message: /abort|cancel/i });
});

test("buildBriefing rejects when the caller's cancel signal is already aborted", async (t) => {
  const { storage, releaseFallback } = makeStallingStorage(t);
  const controller = new AbortController();
  controller.abort();
  const call = buildBriefing({ storage, window: WINDOW, allowLlm: false, abortSignal: controller.signal });
  releaseFallback();
  await assert.rejects(call, { name: "AbortError" });
});

test("a cancelled briefing does not drain the correction-notification queue", async (t) => {
  const storage = makeStorage(t);
  const queueDir = path.join(storage.dir, "state", "corrections");
  mkdirSync(queueDir, { recursive: true });
  const queueFile = path.join(queueDir, "notifications.jsonl");
  writeFileSync(
    queueFile,
    `${JSON.stringify({ planId: "synthetic-plan", summary: "synthetic correction", undoCommand: "remnic correct plan synthetic-plan", createdAt: "2026-04-10T04:00:00.000Z" })}\n`
  );
  const controller = new AbortController();
  const call = buildBriefing({
    storage,
    window: WINDOW,
    abortSignal: controller.signal,
    // Cancel after reads, just before the queue-draining phase.
    followupGenerator: async () => {
      controller.abort();
      return [];
    },
  });
  await assert.rejects(call, { name: "AbortError" });
  assert.ok(existsSync(queueFile), "a cancelled briefing must not consume correction notifications");
});

test("buildBriefing returns a non-empty briefing when nothing is cancelled", async (t) => {
  const result = await buildBriefing({ storage: makeStorage(t), window: WINDOW, allowLlm: false });
  assert.equal(result.sections.activeThreads.length, 1);
  assert.equal(result.sections.recentEntities.length, 1);
  assert.ok(result.markdown.length > 0);
  assert.deepEqual(result.window, { from: "2026-04-10T00:00:00.000Z", to: "2026-04-11T00:00:00.000Z" });
});

test("an HTTP/MCP briefing cancelled during the location read keeps the notification queue", async (t) => {
  const storage = makeStorage(t);
  const queueDir = path.join(storage.dir, "state", "corrections");
  mkdirSync(queueDir, { recursive: true });
  const queueFile = path.join(queueDir, "notifications.jsonl");
  writeFileSync(
    queueFile,
    `${JSON.stringify({ planId: "synthetic-plan", summary: "synthetic correction", undoCommand: "remnic correct plan synthetic-plan", createdAt: "2026-04-10T04:00:00.000Z" })}\n`
  );
  const controller = new AbortController();
  const read: (file: string, encoding: "utf-8") => Promise<string> = fs.readFile;
  t.mock.method(fs, "readFile", async (file: string) => {
    if (file.endsWith(path.join("state", "locations", "sync.json"))) controller.abort(abortError("deadline"));
    return read(file, "utf-8");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  // Object.create yields untyped values, so no assertion is needed: briefing() reads only these members.
  const orchestrator: Orchestrator = Object.assign(Object.create(Orchestrator.prototype), {
    config: {
      briefing: { enabled: true, defaultWindow: "24h", defaultFormat: "markdown", maxFollowups: 0, llmFollowups: false },
      location: { enabled: true, tagging: { enabled: true }, timezone: "UTC" },
    },
    getStorage: async () => storage,
  });
  const surface = new AccessObserveWriteSurface(
    Object.assign(Object.create(null), { orchestrator, resolveReadableNamespace: () => "default" }),
  );

  await assert.rejects(
    surface.briefing({ includeLocation: true, abortSignal: controller.signal }),
    { name: "AbortError" },
  );
  assert.ok(existsSync(queueFile), "a briefing cancelled during the location read must not consume notifications");
});
