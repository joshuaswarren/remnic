import { AsyncLocalStorage } from "node:async_hooks";
import type { CaptureWriteLockBackoffLimits, CaptureWriteLockLimitSource } from "./capture-write-lock-backoff.js";
import type { StorageManager } from "./storage.js";

type CaptureLockOwner = Pick<StorageManager, "dir">;

const captureScope = new AsyncLocalStorage<{ storage: CaptureLockOwner; limits: CaptureWriteLockLimitSource }>();

export function withCaptureWriteLockBackoff<T>(
  storage: CaptureLockOwner,
  limits: CaptureWriteLockBackoffLimits,
  run: () => Promise<T>
): Promise<T> {
  return captureScope.run(
    {
      storage,
      limits: {
        captureWriteLockInitialDelayMs: limits.initialDelayMs,
        captureWriteLockMaxDelayMs: limits.maxDelayMs,
        captureWriteLockDeadlineMs: limits.deadlineMs,
      },
    },
    run
  );
}

export function scopedCaptureWriteLockLimits(storage: CaptureLockOwner): CaptureWriteLockLimitSource | undefined {
  const scope = captureScope.getStore();
  return scope?.storage === storage ? scope.limits : undefined;
}
