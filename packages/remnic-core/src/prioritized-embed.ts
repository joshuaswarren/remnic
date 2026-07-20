const EMBED_BATCH_MAX = 5;
const EMBED_DEBOUNCE_MS = 2_000;

/**
 * #2019: prioritized embedding — new memory writes get embedded within
 * minutes instead of waiting for the next full maintenance cycle.
 * Installs a debounced, capped batcher on `storage.onMemoryWrite` that
 * flushes up to {@link EMBED_BATCH_MAX} paths per tick via the backend's
 * `embedFiles` method. Fire-and-forget: failures are swallowed so the
 * write path is never blocked.
 */
export function installPrioritizedEmbedding(
  storage: { onMemoryWrite?: (filePath: string) => void },
  getQmd: () => unknown,
): void {
  const pendingEmbedPaths: string[] = [];
  let embedFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushEmbedBatch = (): void => {
    embedFlushTimer = null;
    const batch = pendingEmbedPaths.splice(0, EMBED_BATCH_MAX);
    if (batch.length === 0) return;
    const qmd = getQmd() as { embedFiles?: (p: string[]) => Promise<unknown> } | null | undefined;
    if (!qmd || typeof qmd.embedFiles !== "function") return;
    qmd.embedFiles(batch).catch(() => {});
  };

  storage.onMemoryWrite = (filePath: string): void => {
    if (pendingEmbedPaths.length >= EMBED_BATCH_MAX * 3) return;
    pendingEmbedPaths.push(filePath);
    if (embedFlushTimer === null) {
      embedFlushTimer = setTimeout(flushEmbedBatch, EMBED_DEBOUNCE_MS);
      if (typeof embedFlushTimer === "object" && "unref" in embedFlushTimer) embedFlushTimer.unref();
    }
  };
}
