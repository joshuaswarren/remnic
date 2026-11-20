import type { RecallInvocationOptions } from "./orchestration/orchestrator-helpers.js";
import { recallDeadlineSignal } from "./recall-qos.js";

export type RecallCorpusVersion = { namespace: string; version: number | null };

const DEFAULT_CAPTURE_TIMEOUT_MS = 250;

export function mergeRecallCorpusVersions(
  current: RecallCorpusVersion[],
  captured: RecallCorpusVersion[],
): RecallCorpusVersion[] {
  const versions = new Map(current.map((entry) => [entry.namespace, entry]));
  for (const entry of captured) {
    if (!versions.has(entry.namespace)) versions.set(entry.namespace, entry);
  }
  return [...versions.values()];
}

export function createRecallCorpusVersionCapture(
  orchestrator: { getStorage(namespace: string): Promise<{ getMemoryCorpusVersion(): number }> },
  signal: AbortSignal | undefined,
  setVersions: (versions: RecallCorpusVersion[]) => void,
  includeNoRecall = false,
  options: { timeoutMs?: number; deadlineMs?: number } = {},
): NonNullable<RecallInvocationOptions["onRecallPlanResolved"]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  // The client's own deadline bounds this capture too (issue #3499): the
  // request signal alone would let a stalled lookup run the full timeout.
  const captureSignal = recallDeadlineSignal(signal, options.deadlineMs);
  return async (mode, namespaces) => {
    if ((mode === "no_recall" && !includeNoRecall) || captureSignal?.aborted) return;
    const captured = await Promise.all(namespaces.map(async (namespace) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortCapture: (() => void) | undefined;
      try {
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        });
        const aborted = captureSignal
          ? new Promise<null>((resolve) => {
              if (captureSignal.aborted) {
                resolve(null);
              } else {
                abortCapture = () => resolve(null);
                captureSignal.addEventListener("abort", abortCapture, { once: true });
              }
            })
          : undefined;
        const version = await Promise.race([
          orchestrator.getStorage(namespace).then((storage) => storage.getMemoryCorpusVersion()),
          timeout,
          ...(aborted ? [aborted] : []),
        ]);
        return { namespace, version };
      } catch {
        return { namespace, version: null };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (abortCapture) captureSignal?.removeEventListener("abort", abortCapture);
      }
    }));
    if (!captureSignal?.aborted) setVersions(captured);
  };
}