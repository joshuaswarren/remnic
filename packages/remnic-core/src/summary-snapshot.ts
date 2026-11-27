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


async function withSummarySnapshotLock<T>(
  memoryDir: string,
  sessionKey: string,
  work: () => Promise<T>,
): Promise<T> {
  return serializeMutations(`summary-snapshot:${sessionKey}`, () =>
    withHeldFileLock(
      summarySnapshotLockPath(memoryDir, sessionKey),
      {
        staleMs: summarySnapshotLockStaleMs,
        maxWaitMs: summarySnapshotLockTimeoutMs,
        heartbeatMs: summarySnapshotLockHeartbeatMs,
      },
      async (acquired) => {
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
