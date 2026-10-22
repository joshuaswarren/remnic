import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBriefing, parseBriefingWindow, type ParsedBriefingWindow } from "./briefing.js";
import { parseConfig } from "./config.js";
import { StorageManager } from "./storage.js";
import type {
  WindowedMemoryReadOptions,
  WindowedMemoryReadResult,
} from "./storage/windowed-memory-read.js";
import type { CalendarEvent, CalendarSource, PluginConfig } from "./types.js";

class GatedCorpusStorage extends StorageManager {
  constructor(
    root: string,
    config: PluginConfig,
    private readonly corpusGate: Promise<void>,
    private readonly order: string[],
  ) {
    super(root, config.entitySchemas, config.hotMemoriesCacheEnabled);
  }

  async readMemoriesWindow(options: WindowedMemoryReadOptions): Promise<WindowedMemoryReadResult> {
    await this.corpusGate;
    const result = await super.readMemoriesWindow(options);
    this.order.push("corpusRead");
    return result;
  }
}

const FACT_CONTENT = "The briefing reads memories and entities independently.";
const PENDING_CONTENT = "Record the briefing window contract.";
const ENTITY_NAME = "synthetic-entity";
const ENTITY_TYPE = "project";
const ENTITY_FACT = "synthetic entity fact";

interface SeededBriefing {
  event: CalendarEvent;
  memoryDir: string;
  storage: StorageManager;
  window: ParsedBriefingWindow;
  now: Date;
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Seeds through the real write API, then builds the window. writeMemory stamps
 * wall-clock now, so the window is captured afterwards — otherwise the memories
 * it just wrote land after `window.to` and drop out of every section.
 */
async function seedStore(memoryDir: string): Promise<SeededBriefing> {
  const config = parseConfig({ memoryDir });
  const storage = new StorageManager(memoryDir, config.entitySchemas, config.hotMemoriesCacheEnabled);
  const todayStart = startOfUtcDay(new Date());
  await storage.ensureDirectories();
  await storage.writeMemory("fact", FACT_CONTENT, { source: "test", confidence: 0.9 });
  await storage.writeMemory("fact", PENDING_CONTENT, {
    source: "test",
    confidence: 0.9,
    tags: ["pending"],
  });
  await storage.writeEntity(ENTITY_NAME, ENTITY_TYPE, [ENTITY_FACT], { source: "test" });

  const now = new Date();
  const window = parseBriefingWindow("today", now);
  assert.ok(window, "today window must parse");
  return {
    memoryDir,
    storage,
    window,
    now,
    event: {
      id: "evt-synthetic",
      title: "Synthetic event",
      start: new Date(todayStart + 9 * 3_600_000).toISOString(),
    },
  };
}

async function makeTempStore(t: TestContext): Promise<SeededBriefing> {
  const root = await mkdtemp(join(tmpdir(), "remnic-3139-calendar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return seedStore(join(root, "mem"));
}

test("the calendar read overlaps the corpus reads instead of following them", async (t) => {
  const seeded = await makeTempStore(t);
  const corpusGate = Promise.withResolvers<void>();
  const order: string[] = [];
  const storage = new GatedCorpusStorage(
    seeded.memoryDir,
    parseConfig({ memoryDir: seeded.memoryDir }),
    corpusGate.promise,
    order,
  );
  const calendarSource: CalendarSource = {
    async eventsForDate() {
      order.push("calendar");
      return [seeded.event];
    },
  };

  const pending = buildBriefing({
    storage,
    window: seeded.window,
    calendarSource,
    allowLlm: false,
    now: seeded.now,
  });

  // Drain the microtask queue until the calendar read starts; it is reached in
  // the same tick as the gated corpus read, so no real time passes and the
  // ordering cannot pass by luck.
  for (let turn = 0; turn < 50 && order.length === 0; turn += 1) await Promise.resolve();
  const orderWhileCorpusBlocked = [...order];
  corpusGate.resolve();
  const result = await pending;

  assert.deepEqual(orderWhileCorpusBlocked, ["calendar"], "calendar read must start while the corpus read is blocked");
  assert.deepEqual(order, ["calendar", "corpusRead"]);
  assert.deepEqual(result.sections.todayCalendar, [seeded.event]);
});

test("a failing calendar source still reports its error with the overlapping read", async (t) => {
  const seeded = await makeTempStore(t);
  const calendarSource: CalendarSource = {
    async eventsForDate() {
      throw new Error("calendar file unreadable");
    },
  };

  const result = await buildBriefing({
    storage: seeded.storage,
    window: seeded.window,
    calendarSource,
    allowLlm: false,
    now: seeded.now,
  });

  assert.equal(result.sections.todayCalendar, undefined);
  assert.equal(result.calendarSourceErrors?.length, 1);
  assert.deepEqual(result.sections.activeThreads.map((thread) => thread.title).sort(), [FACT_CONTENT, PENDING_CONTENT].sort());
  assert.deepEqual(
    result.sections.recentEntities.map((entity) => ({ name: entity.name, type: entity.type })),
    [{ name: ENTITY_NAME, type: ENTITY_TYPE }],
  );
});