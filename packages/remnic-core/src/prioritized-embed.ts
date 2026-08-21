/**
 * Prioritized embedding: debounce and batch-trigger collection-level QMD embeds
 * so fresh memory writes become searchable within minutes. The QMD CLI does not
 * support per-file embed targeting; each trigger runs `qmd embed -c <collection>`
 * which embeds all pending files. Batching avoids hammering the CLI on every write.
 *
 * Writes are keyed by namespace so a write persisted into a non-default namespace
 * is embedded against that namespace's own QMD collection/backend, not the default
 * collection (review thread: namespace-aware prioritized embedding).
 *
 * Extracted from orchestrator.ts to keep that file under the structural ratchet.
 */

const EMBED_FLUSH_MS = 30_000;
const EMBED_BATCH_MAX = 50;

export interface PrioritizedEmbeddingHandle {
  enqueue: (filePath: string, namespace?: string) => void;
  dispose: () => void;
}

interface EmbedBackend {
  embedFiles?: (paths: string[]) => Promise<unknown>;
}

export function installPrioritizedEmbedding(
  getBackendForNamespace: (namespace: string) => unknown | Promise<unknown>,
  logDebug: (msg: string) => void,
): PrioritizedEmbeddingHandle {
  const pendingByNamespace = new Map<string, string[]>();
  let embedFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const scheduleFlush = (): void => {
    if (disposed || embedFlushTimer !== null) return;
    embedFlushTimer = setTimeout(flushEmbedBatch, EMBED_FLUSH_MS);
    // Do not keep the process alive for the flush delay — short-lived CLI
    // and import commands must exit promptly (review thread: timer unref).
    embedFlushTimer.unref?.();
  };

  const flushNamespace = async (namespace: string, paths: string[]): Promise<void> => {
    let backend: EmbedBackend | null | undefined;
    try {
      backend = (await Promise.resolve(getBackendForNamespace(namespace))) as
        | EmbedBackend
        | null
        | undefined;
    } catch {
      if (paths.length > 0) scheduleFlush();
      return;
    }
    if (!backend || typeof backend.embedFiles !== "function") {
      if (paths.length > 0) scheduleFlush();
      return;
    }
    const batch = paths.splice(0, EMBED_BATCH_MAX);
    if (paths.length === 0 && pendingByNamespace.get(namespace) === paths) {
      pendingByNamespace.delete(namespace);
    }
    if (batch.length === 0) return;
    backend.embedFiles(batch).then((ok) => {
      if (ok === false) {
        requeue(namespace, paths, batch);
        return;
      }
      // Collection-level embed drains the entire backlog. If new writes
      // were appended to the tail while the embed was in flight, reschedule
      // so they get picked up; otherwise clear the queue.
      if (pendingByNamespace.get(namespace) === paths) {
        if (paths.length > 0) {
          scheduleFlush();
        } else {
          pendingByNamespace.delete(namespace);
        }
      }
    }).catch(() => {
      requeue(namespace, paths, batch);
    });
  };

  const requeue = (namespace: string, paths: string[], batch: string[]): void => {
    const live = pendingByNamespace.get(namespace);
    if (live && live !== paths) {
      live.unshift(...batch);
    } else {
      paths.unshift(...batch);
      if (!disposed) pendingByNamespace.set(namespace, paths);
    }
    scheduleFlush();
  };

  const flushEmbedBatch = (): void => {
    embedFlushTimer = null;
    for (const [namespace, paths] of [...pendingByNamespace]) {
      void flushNamespace(namespace, paths);
    }
  };

  const dispose = (): void => {
    disposed = true;
    if (embedFlushTimer) {
      clearTimeout(embedFlushTimer);
      embedFlushTimer = null;
    }
    pendingByNamespace.clear();
  };

  const enqueue = (filePath: string, namespace?: string): void => {
    if (disposed) return;
    const key = namespace ?? "default";
    let paths = pendingByNamespace.get(key);
    if (!paths) {
      paths = [];
      pendingByNamespace.set(key, paths);
    }
    paths.push(filePath);
    scheduleFlush();
    logDebug(`prioritized embed: queued ${filePath} in namespace ${key} (${paths.length} pending)`);
  };

  return { enqueue, dispose };
}
