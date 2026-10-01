import type { RecallInvocationOptions } from "./orchestration/orchestrator-helpers.js";

export type RecallCorpusVersion = { namespace: string; version: number | null };

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
): NonNullable<RecallInvocationOptions["onRecallPlanResolved"]> {
  return async (mode, namespaces) => {
    if ((mode === "no_recall" && !includeNoRecall) || signal?.aborted) return;
    const captured = await Promise.all(namespaces.map(async (namespace) => {
      try {
        const storage = await orchestrator.getStorage(namespace);
        return { namespace, version: storage.getMemoryCorpusVersion() };
      } catch {
        return { namespace, version: null };
      }
    }));
    if (!signal?.aborted) setVersions(captured);
  };
}