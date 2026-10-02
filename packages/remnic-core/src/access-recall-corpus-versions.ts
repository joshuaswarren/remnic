import type { RecallInvocationOptions } from "./orchestration/orchestrator-helpers.js";

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
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
): NonNullable<RecallInvocationOptions["onRecallPlanResolved"]> {
  return async (mode, namespaces) => {
    if ((mode === "no_recall" && !includeNoRecall) || signal?.aborted) return;
    const captured = await Promise.all(namespaces.map(async (namespace) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortCapture: (() => void) | undefined;
      try {
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        });
        const aborted = signal
          ? new Promise<null>((resolve) => {
              if (signal.aborted) {
                resolve(null);
              } else {
                abortCapture = () => resolve(null);
                signal.addEventListener("abort", abortCapture, { once: true });
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
        if (abortCapture) signal?.removeEventListener("abort", abortCapture);
      }
    }));
    if (!signal?.aborted) setVersions(captured);
  };
}