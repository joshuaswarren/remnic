import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  encodeStoragePathSegment,
  resolvePathInsideStorageRoot,
} from "./storage-paths.js";
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

const summarySnapshotUpserts = new Map<string, Promise<void>>();
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
  const previous = summarySnapshotUpserts.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  summarySnapshotUpserts.set(sessionKey, chained);

  await previous;
  try {
    return await withExclusiveSummarySnapshotFileLock(
      summarySnapshotLockPath(memoryDir, sessionKey),
      work,
    );
  } finally {
    release();
    if (summarySnapshotUpserts.get(sessionKey) === chained) {
      summarySnapshotUpserts.delete(sessionKey);
    }
  }
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

async function withExclusiveSummarySnapshotFileLock<T>(
  lockPath: string,
  callback: () => Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      let heartbeat: NodeJS.Timeout | null = null;
      if (summarySnapshotLockHeartbeatMs > 0) {
        heartbeat = setInterval(() => {
          void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
        }, summarySnapshotLockHeartbeatMs);
        heartbeat.unref?.();
      }
      try {
        return await callback();
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > summarySnapshotLockStaleMs) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt > summarySnapshotLockTimeoutMs) {
        throw new Error("timed out acquiring summary snapshot lock");
      }
      await sleep(10);
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
