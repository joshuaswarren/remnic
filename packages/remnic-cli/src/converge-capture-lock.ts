import { resolveConvergeCaptureWriteLockBackoff } from "@remnic/core";
import { isTombstoneBlockedCaptureWriteLockBusy } from "@remnic/core/capture-write-lock-backoff.js";
import type { ConvergeConfig } from "@remnic/core/types.js";

import { createOfflineStorageIo, type OfflineStorageIo } from "./offline-storage-io.js";

/** Open a storage IO bound to the converge capture-lock backoff and abort signal. */
export function createConvergeStorageIoOpener(
  convergeConfig: ConvergeConfig | undefined,
  signal: AbortSignal | undefined
): (rootDir: string) => Promise<OfflineStorageIo> {
  const backoff = resolveConvergeCaptureWriteLockBackoff(convergeConfig);
  return (rootDir: string) => createOfflineStorageIo(rootDir, undefined, undefined, backoff, signal);
}

type TransferEntry = { namespace?: string; path?: string };

/**
 * Handle one batch of settled transfer results. A capture lock that stayed
 * busy fails that transfer only — counted and logged — so other entries in
 * the batch, and later batches, still run. Any other rejection is rethrown.
 */
export function handleConvergeTransferResults(
  results: readonly PromiseSettledResult<unknown>[],
  batch: readonly TransferEntry[],
  onFailed: () => void
): void {
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result || result.status === "fulfilled") continue;
    if (isTombstoneBlockedCaptureWriteLockBusy(result.reason)) {
      onFailed();
      const entry = batch[index];
      const namespace = entry?.namespace ?? "unknown";
      const entryPath = entry?.path ?? "";
      process.stderr.write(
        `converge: tombstone-blocked capture write lock remained busy for ${namespace} ${entryPath}; continuing the cycle\n`
      );
      continue;
    }
    throw result.reason;
  }
}
