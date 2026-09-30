import type { RecallInvocationOptions } from "./orchestrator-helpers.js";

export function createRecallCorpusVersionCapture(
  orchestrator: { getStorage(namespace: string): Promise<{ getMemoryCorpusVersion(): number }> },
  signal: AbortSignal | undefined,
  setVersions: (versions: Array<{ namespace: string; version: number }>) => void,
): NonNullable<RecallInvocationOptions["onRecallPlanResolved"]> {
  return async (mode, namespaces) => {
    if (mode === "no_recall" || signal?.aborted) return;
    setVersions(await Promise.all(namespaces.map(async (namespace) => ({
      namespace,
      version: (await orchestrator.getStorage(namespace)).getMemoryCorpusVersion(),
    }))));
  };
}
