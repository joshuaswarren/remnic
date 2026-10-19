/**
 * Projection timeline assembly.
 *
 * The lifecycle ledger is streamed one event at a time. Dedup keeps the same
 * winner as sort-then-first-wins (stable `compareMemoryLifecycleEvents`, file
 * order on ties) without materializing the unsorted ledger beside the result.
 */
import path from "node:path";
import { throwIfAborted } from "../abort-error.js";
import { log } from "../logger.js";
import type { MemoryFile, MemoryLifecycleEvent } from "../types.js";
import {
  buildLifecycleEventsForMemory,
  compareMemoryLifecycleEvents,
  memoryLifecycleEventProjectionIdentity,
  sortMemoryLifecycleEvents,
} from "../memory-lifecycle-ledger-utils.js";
import type {
  SkippedBlankIdTimelineEvent,
  SkippedDuplicateTimelineEvent,
} from "./projection-support.js";

export interface ProjectionLedgerReader {
  iterateMemoryLifecycleEvents(): AsyncIterable<MemoryLifecycleEvent>;
}

export interface ProjectionTimeline {
  events: MemoryLifecycleEvent[];
  usedLifecycleLedger: boolean;
  sourceLifecycleLedgerEventCount: number;
  skipped: SkippedDuplicateTimelineEvent[];
  skippedBlankIds: SkippedBlankIdTimelineEvent[];
}

function loadTimelineEvents(
  memories: MemoryFile[],
  lifecycleEvents: MemoryLifecycleEvent[],
): { events: MemoryLifecycleEvent[]; usedLifecycleLedger: boolean } {
  if (lifecycleEvents.length > 0) {
    return {
      events: sortMemoryLifecycleEvents(lifecycleEvents),
      usedLifecycleLedger: true,
    };
  }

  return {
    events: sortMemoryLifecycleEvents(memories.flatMap((memory) => buildLifecycleEventsForMemory(memory))),
    usedLifecycleLedger: false,
  };
}

function deduplicateTimelineEvents(
  events: MemoryLifecycleEvent[],
  sourcePathFor: (event: MemoryLifecycleEvent) => string,
): {
  events: MemoryLifecycleEvent[];
  skipped: SkippedDuplicateTimelineEvent[];
  skippedBlankIds: SkippedBlankIdTimelineEvent[];
} {
  const keptById = new Map<string, { event: MemoryLifecycleEvent; path: string }>();
  const unique: MemoryLifecycleEvent[] = [];
  const skipped: SkippedDuplicateTimelineEvent[] = [];
  const skippedBlankIds: SkippedBlankIdTimelineEvent[] = [];
  for (const event of sortMemoryLifecycleEvents(events)) {
    const sourcePath = sourcePathFor(event);
    if (!event.memoryId.trim()) {
      skippedBlankIds.push({ eventId: event.eventId, path: sourcePath });
      log.warn(
        `projection rebuild skipped timeline event with blank memory id: `
        + `event_id=${event.eventId} path=${sourcePath}`,
      );
      continue;
    }
    const kept = keptById.get(event.eventId);
    if (kept) {
      skipped.push({
        eventId: event.eventId,
        keptPath: kept.path,
        skippedPath: sourcePath,
      });
      log.warn(
        `projection rebuild skipped duplicate timeline event_id=${event.eventId}: `
        + `kept=${kept.path} skipped=${sourcePath}`,
      );
      continue;
    }
    keptById.set(event.eventId, { event, path: sourcePath });
    unique.push(event);
  }
  return { events: unique, skipped, skippedBlankIds };
}

function internPool(): <T extends string>(value: T) => T {
  const pool = new Map<string, string>();
  return <T extends string>(value: T): T => {
    const existing = pool.get(value);
    if (existing !== undefined) return existing as T;
    pool.set(value, value);
    return value;
  };
}

/** Share repeated ledger scalars so a long ledger does not keep one string per row. */
function internLedgerEvent(event: MemoryLifecycleEvent, intern: <T extends string>(value: T) => T): void {
  event.memoryId = intern(event.memoryId);
  event.eventType = intern(event.eventType);
  event.timestamp = intern(event.timestamp);
  event.actor = intern(event.actor);
  event.ruleVersion = intern(event.ruleVersion);
  if (event.reasonCode) event.reasonCode = intern(event.reasonCode);
  if (event.correlationId) event.correlationId = intern(event.correlationId);
}

/**
 * Stream ledger events into the deduped timeline. Returns null when the ledger
 * contributed no parsable row, so the caller can fall back to frontmatter.
 */
async function consumeLifecycleLedger(
  events: AsyncIterable<MemoryLifecycleEvent>,
  ledgerPath: string,
  signal?: AbortSignal,
): Promise<ProjectionTimeline | null> {
  const intern = internPool();
  const best = new Map<string, MemoryLifecycleEvent>();
  const losers: MemoryLifecycleEvent[] = [];
  const blanks: MemoryLifecycleEvent[] = [];
  const identities = new Set<string>();
  let sawEvent = false;
  for await (const event of events) {
    throwIfAborted(signal, "projection rebuild aborted");
    sawEvent = true;
    internLedgerEvent(event, intern);
    identities.add(memoryLifecycleEventProjectionIdentity(event));
    if (!event.memoryId.trim()) {
      blanks.push(event);
      continue;
    }
    const prev = best.get(event.eventId);
    if (!prev) {
      best.set(event.eventId, event);
      continue;
    }
    if (compareMemoryLifecycleEvents(event, prev) < 0) {
      losers.push(prev);
      best.set(event.eventId, event);
    } else {
      losers.push(event);
    }
  }
  if (!sawEvent) return null;
  const sourceLifecycleLedgerEventCount = identities.size;
  identities.clear();
  const skippedBlankIds = sortMemoryLifecycleEvents(blanks).map((event) => {
    log.warn(
      `projection rebuild skipped timeline event with blank memory id: `
      + `event_id=${event.eventId} path=${ledgerPath}`,
    );
    return { eventId: event.eventId, path: ledgerPath };
  });
  const skipped = sortMemoryLifecycleEvents(losers).map((event) => {
    log.warn(
      `projection rebuild skipped duplicate timeline event_id=${event.eventId}: `
      + `kept=${ledgerPath} skipped=${ledgerPath}`,
    );
    return {
      eventId: event.eventId,
      keptPath: ledgerPath,
      skippedPath: ledgerPath,
    };
  });
  return {
    events: sortMemoryLifecycleEvents([...best.values()]),
    usedLifecycleLedger: true,
    sourceLifecycleLedgerEventCount,
    skipped,
    skippedBlankIds,
  };
}

export async function loadProjectionTimeline(options: {
  storage: ProjectionLedgerReader;
  memoryDir: string;
  memories: MemoryFile[];
  signal?: AbortSignal;
}): Promise<ProjectionTimeline> {
  const ledgerPath = path.join(options.memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  const streamed = await consumeLifecycleLedger(
    options.storage.iterateMemoryLifecycleEvents(),
    ledgerPath,
    options.signal,
  );
  if (streamed) return streamed;

  const timeline = loadTimelineEvents(options.memories, []);
  const memoryPathById = new Map(
    options.memories.map((memory) => [memory.frontmatter.id, memory.path]),
  );
  const deduplicated = deduplicateTimelineEvents(
    timeline.events,
    (event) => memoryPathById.get(event.memoryId) ?? ledgerPath,
  );
  return {
    events: deduplicated.events,
    usedLifecycleLedger: false,
    sourceLifecycleLedgerEventCount: 0,
    skipped: deduplicated.skipped,
    skippedBlankIds: deduplicated.skippedBlankIds,
  };
}
