import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

type AccessIdempotencyEntry = {
  recordedAt: string;
  requestHash: string;
  response: unknown;
};

type AccessIdempotencyTestHooks = {
  beforeFlushWrite?: () => Promise<void> | void;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockHeartbeatMs?: number;
  beforeStaleLockUnlink?: () => Promise<void> | void;
};

let testHooks: AccessIdempotencyTestHooks | null = null;

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return candidate;
    }
    return Object.keys(candidate)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (candidate as Record<string, unknown>)[key];
        return acc;
      }, {});
  });
}

export function hashAccessIdempotencyPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function setAccessIdempotencyTestHooks(hooks: AccessIdempotencyTestHooks | null): void {
  testHooks = hooks;
}

export class AccessIdempotencyStore {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly keyLockDir: string;
  private loadedMtimeMs = 0;
  private state: Record<string, AccessIdempotencyEntry> = {};
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(memoryDir: string) {
    this.statePath = path.join(memoryDir, "state", "access-idempotency.json");
    this.lockPath = `${this.statePath}.lock`;
    this.keyLockDir = path.join(memoryDir, "state", "access-idempotency-locks");
  }

  async get(key: string, requestHash: string): Promise<{ response?: unknown; conflict: boolean }> {
    await this.writeQueue.catch(() => {});
    await this.reload({ forceRefresh: true });
    const entry = this.state[key];
    if (!entry) return { conflict: false };
    if (entry.requestHash !== requestHash) {
      return { conflict: true };
    }
    return {
      conflict: false,
      response: JSON.parse(JSON.stringify(entry.response)),
    };
  }

  async put(key: string, requestHash: string, response: unknown): Promise<void> {
    await this.withWriteQueue(async () => {
      await this.reload({ forceRefresh: true });
      this.state[key] = {
        recordedAt: new Date().toISOString(),
        requestHash,
        response: JSON.parse(JSON.stringify(response)),
      };
      await this.prune();
      await this.flush();
    });
  }

  async withKeyLock<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const keyHash = createHash("sha256").update(key).digest("hex");
    const keyLockPath = path.join(this.keyLockDir, `${keyHash}.lock`);
    return this.withExclusiveFileLock(keyLockPath, callback);
  }

  private async reload(options: { forceRefresh?: boolean } = {}): Promise<void> {
    if (options.forceRefresh === true) {
      try {
        const fileStat = await stat(this.statePath);
        if (fileStat.mtimeMs < this.loadedMtimeMs) {
          return;
        }
      } catch {
        this.state = {};
        this.loadedMtimeMs = 0;
        return;
      }
    }
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, AccessIdempotencyEntry>;
      if (parsed && typeof parsed === "object") {
        this.state = parsed;
        this.loadedMtimeMs = await this.readMtimeMs();
        return;
      }
    } catch {
      // Missing or malformed state should fail open to an empty store.
    }
    this.state = {};
    this.loadedMtimeMs = 0;
  }

  private async prune(): Promise<void> {
    const entries = Object.entries(this.state);
    if (entries.length <= 512) return;
    entries
      .sort((left, right) => right[1].recordedAt.localeCompare(left[1].recordedAt))
      .slice(512)
      .forEach(([key]) => {
        delete this.state[key];
      });
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await this.withExclusiveFileLock(this.lockPath, async () => {
      try {
        const raw = await readFile(this.statePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, AccessIdempotencyEntry>;
        if (parsed && typeof parsed === "object") {
          this.state = {
            ...parsed,
            ...this.state,
          };
          await this.prune();
        }
      } catch {
        // Fail open when there is no pre-existing shared state to merge.
      }

      await testHooks?.beforeFlushWrite?.();

      const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf-8");
        await rename(tempPath, this.statePath);
      } finally {
        await unlink(tempPath).catch(() => undefined);
      }
      this.loadedMtimeMs = await this.readMtimeMs();
    });
  }

  private async readMtimeMs(): Promise<number> {
    try {
      return (await stat(this.statePath)).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async withExclusiveFileLock<T>(lockPath: string, callback: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(lockPath), { recursive: true });
    const timeoutMs = testHooks?.lockTimeoutMs ?? 5_000;
    const staleLockMs = testHooks?.staleLockMs ?? 30_000;
    const lockHeartbeatMs = testHooks?.lockHeartbeatMs ?? Math.max(1_000, Math.floor(staleLockMs / 3));
    const startedAt = Date.now();

    while (true) {
      const ownerToken = `${process.pid}:${randomUUID()}`;
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(ownerToken, "utf-8");
        let heartbeat: NodeJS.Timeout | null = null;
        if (lockHeartbeatMs > 0) {
          heartbeat = setInterval(() => {
            void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
          }, lockHeartbeatMs);
          heartbeat.unref?.();
        }
        try {
          return await callback();
        } finally {
          if (heartbeat) {
            clearInterval(heartbeat);
          }
          await handle.close().catch(() => undefined);
          await unlinkLockIfOwner(lockPath, ownerToken);
        }
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        try {
          const lockStat = await stat(lockPath);
          const lockOwner = await readLockOwner(lockPath);
          if (Date.now() - lockStat.mtimeMs > staleLockMs) {
            await testHooks?.beforeStaleLockUnlink?.();
            const removed = await unlinkStaleLockIfUnchanged({
              lockPath,
              observedOwner: lockOwner,
              observedMtimeMs: lockStat.mtimeMs,
              staleLockMs,
            });
            if (!removed) {
              await sleep(10);
            }
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error("timed out acquiring access idempotency lock");
        }
        await sleep(10);
      }
    }
  }

  private async withWriteQueue<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function readLockOwner(lockPath: string): Promise<string | null> {
  try {
    return await readFile(lockPath, "utf-8");
  } catch {
    return null;
  }
}

async function unlinkLockIfOwner(lockPath: string, ownerToken: string): Promise<void> {
  const currentOwner = await readLockOwner(lockPath);
  if (currentOwner !== ownerToken) return;
  await unlink(lockPath).catch(() => undefined);
}

async function unlinkStaleLockIfUnchanged(options: {
  lockPath: string;
  observedOwner: string | null;
  observedMtimeMs: number;
  staleLockMs: number;
}): Promise<boolean> {
  let currentStat: Awaited<ReturnType<typeof stat>>;
  try {
    currentStat = await stat(options.lockPath);
  } catch {
    return true;
  }
  if (currentStat.mtimeMs !== options.observedMtimeMs) return false;
  if (Date.now() - currentStat.mtimeMs <= options.staleLockMs) return false;
  const currentOwner = await readLockOwner(options.lockPath);
  if (currentOwner !== options.observedOwner) return false;
  await unlink(options.lockPath);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
