import { readFile } from "node:fs/promises";
import { isAbortError, raceAbort } from "./abort-error.js";
import { resolveNamespaceCapabilities } from "./capabilities.js";
import { checkEntityRecallAbort } from "./entity-recall-cancellation.js";
import { collectNativeKnowledgeChunks, type NativeKnowledgeChunk } from "./native-knowledge.js";
import type { PluginConfig } from "./types.js";

export async function readEntityIndexStateText(file: string, abortSignal?: AbortSignal): Promise<string> {
  checkEntityRecallAbort(abortSignal);
  // Release this waiter when cancelled; the underlying shared filesystem read
  // may still settle later. Ordinary read failures keep the existing fallback.
  const raw = await raceAbort(readFile(file, "utf-8"), abortSignal, "entity recall aborted")
    .catch((err) => {
      if (isAbortError(err)) throw err;
      return "";
    });
  checkEntityRecallAbort(abortSignal);
  return raw;
}

export async function readNativeChunks(
  config: PluginConfig,
  recallNamespaces?: string[],
  abortSignal?: AbortSignal,
): Promise<NativeKnowledgeChunk[]> {
  if (!config.nativeKnowledge?.enabled) return [];
  return collectNativeKnowledgeChunks({
    workspaceDir: config.workspaceDir,
    memoryDir: config.memoryDir,
    config: config.nativeKnowledge,
    recallNamespaces: resolveNamespaceCapabilities(config).namespaces ? recallNamespaces : undefined,
    defaultNamespace: config.defaultNamespace,
    abortSignal,
  }).catch((err) => {
    // Cancellation is the caller giving up (issue #2291); degrade only genuine
    // read/sync failures, never a cancellation.
    if (isAbortError(err)) throw err;
    return [];
  });
}
