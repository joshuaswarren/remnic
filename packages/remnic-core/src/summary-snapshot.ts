import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  encodeStoragePathSegment,
  resolvePathInsideStorageRoot,
} from "./storage-paths.js";
import {
  serializeMutations,
  withHeldFileLock,
} from "./utils/serialize-mutations.js";
import type { HourlySummary } from "./types.js";

const summarySnapshotSchemaVersion = 1;

const SummarySnapshotItemSchema = z.object({
  hour: z.string(),
  sessionKey: z.string(),
  bullets: z.array(z.string()),
  turnCount: z.number().int().nonnegative(),
  generatedAt: z.string(),
});

const SummarySnapshotSchema = z.object({
  schemaVersion: z.number().default(summarySnapshotSchemaVersion),
  sessionKey: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
  summaries: z.array(SummarySnapshotItemSchema),
});

type SummarySnapshot = z.infer<typeof SummarySnapshotSchema>;

// Lock timings for the cross-process summary-snapshot file lock. These are
// passed straight through to the shared `withHeldFileLock` utility (issue
// #1524 adoption); the previous bespoke lock used the same numbers.
const summarySnapshotLockTimeoutMs = 5_000;
const summarySnapshotLockStaleMs = 30_000;
const summarySnapshotLockHeartbeatMs = Math.max(
  1_000,
  Math.floor(summarySnapshotLockStaleMs / 3),
);

export function summarySnapshotPath(
  memoryDir: string,
  sessionKey: string,
): string {
  return resolveSummarySnapshotPath(memoryDir, sessionKey, "json");
}

function summarySnapshotLockPath(memoryDir: string, sessionKey: string): string {
  return resolveSummarySnapshotPath(memoryDir, sessionKey, "lock");
}

function summarySnapshotRoot(memoryDir: string): string {
  return resolvePathInsideStorageRoot(memoryDir, "state", "summaries");
}

function resolveSummarySnapshotPath(
  memoryDir: string,
  sessionKey: string,
  extension: "json" | "lock",
): string {
  const safeSessionKey = encodeStoragePathSegment(sessionKey, "session");
  return resolvePathInsideStorageRoot(
    summarySnapshotRoot(memoryDir),
    `${safeSessionKey}.${extension}`,
  );
}

function legacySummarySnapshotPath(
  memoryDir: string,
  sessionKey: string,
): string | null {
  if (sessionKey.includes("\0")) {
    return null;
  }
  try {
    return resolvePathInsideStorageRoot(
      summarySnapshotRoot(memoryDir),
      `${sessionKey}.json`,
    );
  } catch {
    return null;
  }
}

export async function readSummarySnapshot(
  memoryDir: string,
  sessionKey: string,
): Promise<HourlySummary[] | null> {
  const filePath = summarySnapshotPath(memoryDir, sessionKey);
  const snapshot = await readSummarySnapshotFile(filePath, sessionKey);
  if (snapshot !== null) return snapshot;

  const legacyPath = legacySummarySnapshotPath(memoryDir, sessionKey);
  if (legacyPath === null || legacyPath === filePath) return null;
  return readSummarySnapshotFile(legacyPath, sessionKey);
}

async function readSummarySnapshotFile(
  filePath: string,
  sessionKey: string,
): Promise<HourlySummary[] | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = SummarySnapshotSchema.parse(JSON.parse(raw));
    if (data.sessionKey !== sessionKey) return null;
    return data.summaries;
  } catch {
    return null;
  }
}

export async function writeSummarySnapshot(
  memoryDir: string,
  sessionKey: string,
  summaries: HourlySummary[],
): Promise<void> {
  const filePath = summarySnapshotPath(memoryDir, sessionKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: SummarySnapshot = {
    schemaVersion: summarySnapshotSchemaVersion,
    sessionKey,
    generatedAt: new Date().toISOString(),
    summaries: summaries
      .map((summary) => ({
        hour: summary.hour,
        sessionKey: summary.sessionKey,
        bullets: summary.bullets,
        turnCount: summary.turnCount,
        generatedAt: summary.generatedAt,
      }))
      .sort((a, b) => new Date(b.hour).getTime() - new Date(a.hour).getTime()),
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

// ── Concurrency primitives (issue #1524 adoption) ─────────────────────────
//
// Summary-snapshot upserts were previously guarded by TWO bespoke serializers:
//   1. an in-process `summarySnapshotUpserts` map keyed by sessionKey that
//      chained each upsert off the prior one's release (mirroring
//      `serializeMutations`), and
//   2. an on-disk `withExclusiveSummarySnapshotFileLock` that re-implemented
//      `open(path, "wx")` acquire, mtime heartbeat, stale-break, and
//      ownership-checked release.
// Both now delegate to the shared utility so there is ONE home for each
// primitive (`serializeMutations` for in-process, `withHeldFileLock` for
// cross-process). The behavior contract is preserved:
//   - in-process upserts for the SAME sessionKey are strictly serialized
//     (read-merge-write cannot interleave);
//   - a cross-process holder blocks up to `summarySnapshotLockTimeoutMs`, then
//     the upsert FAILS (a snapshot is advisory; we never race a read-merge-write
//     unlocked). To preserve this strictness on top of a best-effort utility,
//     the work callback throws when `acquired === false`.

async function withSummarySnapshotLock<T>(
  memoryDir: string,
  sessionKey: string,
  work: () => Promise<T>,
): Promise<T> {
  // In-process serialization (one upsert per sessionKey at a time). The
  // serializer recovers from rejection, so a failed upsert never poisons the
  // next one — matching the previous chain's `.then(noop, noop)` recovery.
  return serializeMutations(`summary-snapshot:${sessionKey}`, () =>
    // Cross-process mutex via the shared utility. The lock path, stale
    // threshold, bounded wait, and heartbeat cadence all flow through; the
    // utility's replacement-safe stale break (NG7Bg) and ownership-checked
    // release are stronger than the bare `unlink` this module used before.
    withHeldFileLock(
      summarySnapshotLockPath(memoryDir, sessionKey),
      {
        staleMs: summarySnapshotLockStaleMs,
        maxWaitMs: summarySnapshotLockTimeoutMs,
        heartbeatMs: summarySnapshotLockHeartbeatMs,
      },
      async (acquired) => {
        // Strict-fail when the lock could not be acquired: the upsert is a
        // read-merge-write, so a best-effort unlocked run would clobber a
        // concurrent writer. The utility's `acquired === false` covers BOTH a
        // genuine contention timeout AND a filesystem acquire failure (lock-dir
        // mkdir/open/permission errors — the advisory lock is best-effort, so
        // the util degrades rather than throwing). The bespoke lock this
        // replaced propagated fs errors verbatim and reserved the timeout
        // message for contention; we no longer claim "timed out" for an fs
        // failure (cursor Low 25143f4f) — the message names both causes so
        // upstream fail-open (runHourly) is unchanged but debugging is honest.
        if (!acquired) {
          throw new Error(
            "could not acquire summary snapshot lock (contention timeout or filesystem error)",
          );
        }
        return work();
      },
    ),
  );
}

export async function upsertSummarySnapshot(
  memoryDir: string,
  summary: HourlySummary,
): Promise<void> {
  await withSummarySnapshotLock(memoryDir, summary.sessionKey, async () => {
    const existing = await readSummarySnapshot(memoryDir, summary.sessionKey);
    const byHour = new Map<string, HourlySummary>();
    for (const item of existing ?? []) {
      byHour.set(item.hour, {
        ...item,
        generatedAt: item.generatedAt || new Date().toISOString(),
        sessionKey: summary.sessionKey,
      });
    }
    byHour.set(summary.hour, summary);
    const next = Array.from(byHour.values()).sort(
      (a, b) => new Date(b.hour).getTime() - new Date(a.hour).getTime(),
    );
    await writeSummarySnapshot(memoryDir, summary.sessionKey, next);
  });
}
