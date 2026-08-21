import path from "node:path";
import type {
  MemoryFile,
  MemoryLifecycleEvent,
  MemoryLifecycleEventType,
  MemoryLifecycleStateSummary,
  MemoryFrontmatter,
  MemoryStatus,
} from "./types.js";

export const MEMORY_LIFECYCLE_RULE_VERSION = "memory-lifecycle-ledger.v1";

export const MEMORY_LIFECYCLE_EVENT_SORT_ORDER: Record<MemoryLifecycleEventType, number> = {
  created: 0,
  updated: 1,
  promoted: 2,
  explicit_capture_accepted: 3,
  explicit_capture_queued: 4,
  imported: 5,
  merged: 6,
  restored: 7,
  superseded: 8,
  rejected: 9,
  archived: 10,
};

const FRONTMATTER_DERIVED_EVENT_TYPES: Record<string, true> = {
  created: true,
  updated: true,
  superseded: true,
  archived: true,
};

export function isFrontmatterDerivedLifecycleEventType(eventType: string): boolean {
  return FRONTMATTER_DERIVED_EVENT_TYPES[eventType] === true;
}

export function memoryLifecycleEventProjectionIdentity(event: {
  eventId: string;
  memoryId: string;
  eventType: string;
  timestamp: string;
}): string {
  if (!isFrontmatterDerivedLifecycleEventType(event.eventType)) return `event\u0000${event.eventId}`;
  return `frontmatter\u0000${event.memoryId}\u0000${event.eventType}\u0000${event.timestamp}`;
}

/**
 * Deterministic sort rank for a lifecycle event type. The ledger readers admit
 * any structurally valid row (permissive `eventType`, issue #1910), so an
 * unknown/typoed type must still sort deterministically: it ranks AFTER every
 * known type and keeps the comparator total. Without this fallback,
 * `map[unknown] - map[known]` is `NaN`, an invalid comparator result.
 */
const UNKNOWN_LIFECYCLE_EVENT_SORT_RANK = Number.MAX_SAFE_INTEGER;

export function lifecycleEventSortRank(eventType: string): number {
  return (
    MEMORY_LIFECYCLE_EVENT_SORT_ORDER[eventType as MemoryLifecycleEventType] ??
    UNKNOWN_LIFECYCLE_EVENT_SORT_RANK
  );
}

/**
 * Cross-process lock path guarding lifecycle-ledger mutations (issue #1910,
 * codex): `appendMemoryLifecycleEvents` and the compaction rewrite both hold
 * this lock so a lifecycle event appended during compaction's read->rewrite
 * window cannot be clobbered by the atomic rename that replaces the ledger.
 */
export function memoryLifecycleLedgerLockPath(ledgerPath: string): string {
  return `${ledgerPath}.lock`;
}

/** Stale-break window for the lifecycle-ledger lock, shared by append + rewrite. */
export const MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS = 30_000;

/**
 * Acquisition budget for a lifecycle append waiting on the shared ledger lock
 * (issue #2033). Set to twice the stale-break window so a normal append waits
 * out an in-progress compaction rewrite instead of giving up at
 * withHeldFileLock's 5s default and dropping the event: a live compaction
 * releases within its own runtime, and a crashed holder's lock is stale-broken
 * at MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS, so the append still acquires well
 * inside this budget rather than failing open.
 */
export const MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS =
  MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS * 2;

export function toMemoryPathRel(baseDir: string, filePath: string): string {
  if (!baseDir) return filePath.split(path.sep).join("/");
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

export function isArchivedMemoryPath(pathRel: string): boolean {
  return pathRel === "archive" || pathRel.startsWith("archive/");
}

export function inferMemoryStatus(
  frontmatter: MemoryFrontmatter,
  pathRel: string,
  fallbackStatus: MemoryStatus = "active",
): MemoryStatus {
  if (frontmatter.status && frontmatter.status !== "active") return frontmatter.status;
  if (frontmatter.archivedAt) return "archived";
  if (isArchivedMemoryPath(pathRel)) return "archived";
  if (frontmatter.status) return frontmatter.status;
  return fallbackStatus;
}

export function isActiveMemoryStatus(status: MemoryStatus | string | undefined): boolean {
  return status === undefined || status === "active";
}

export function summarizeMemoryLifecycleState(memory: MemoryFile): MemoryLifecycleStateSummary {
  return {
    category: memory.frontmatter.category,
    path: memory.path,
    status: memory.frontmatter.status ?? "active",
    lifecycleState: memory.frontmatter.lifecycleState,
  };
}

export function makeRebuiltMemoryLifecycleEvent(
  memory: MemoryFile,
  eventType: MemoryLifecycleEventType,
  timestamp: string,
): MemoryLifecycleEvent {
  return {
    eventId: `rebuild-${memory.frontmatter.id}-${eventType}-${timestamp}`,
    memoryId: memory.frontmatter.id,
    eventType,
    timestamp,
    actor: "maintenance.rebuildMemoryLifecycleLedger",
    ruleVersion: MEMORY_LIFECYCLE_RULE_VERSION,
    after: summarizeMemoryLifecycleState(memory),
    relatedMemoryIds: [
      ...(memory.frontmatter.supersededBy ? [memory.frontmatter.supersededBy] : []),
      ...(memory.frontmatter.supersedes ? [memory.frontmatter.supersedes] : []),
      ...((memory.frontmatter.lineage ?? []).filter(Boolean)),
    ],
  };
}

export function buildLifecycleEventsForMemory(memory: MemoryFile): MemoryLifecycleEvent[] {
  const events: MemoryLifecycleEvent[] = [];
  const created = memory.frontmatter.created;
  const updated = memory.frontmatter.updated;
  const archivedAt = memory.frontmatter.archivedAt;
  const supersededAt = memory.frontmatter.supersededAt;
  const effectiveArchivedAt =
    archivedAt ?? (memory.frontmatter.status === "archived" && updated ? updated : undefined);

  events.push(makeRebuiltMemoryLifecycleEvent(memory, "created", created));
  if (
    updated &&
    updated !== created &&
    updated !== effectiveArchivedAt &&
    updated !== supersededAt
  ) {
    events.push(makeRebuiltMemoryLifecycleEvent(memory, "updated", updated));
  }
  if (supersededAt) {
    events.push(makeRebuiltMemoryLifecycleEvent(memory, "superseded", supersededAt));
  }
  if (effectiveArchivedAt) {
    events.push(makeRebuiltMemoryLifecycleEvent(memory, "archived", effectiveArchivedAt));
  }

  return events;
}

export function compareMemoryLifecycleEvents(
  a: MemoryLifecycleEvent,
  b: MemoryLifecycleEvent,
): number {
  if (a.memoryId !== b.memoryId) return a.memoryId.localeCompare(b.memoryId);
  if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
  return lifecycleEventSortRank(a.eventType) - lifecycleEventSortRank(b.eventType);
}

export function sortMemoryLifecycleEvents(events: MemoryLifecycleEvent[]): MemoryLifecycleEvent[] {
  return [...events].sort(compareMemoryLifecycleEvents);
}
