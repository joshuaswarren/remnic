/**
 * Prioritized embedding: batch new memory file paths and embed them via QMD
 * on a short timer so fresh writes become searchable within minutes.
 *
 * Extracted from orchestrator.ts to keep that file under the structural ratchet.
 */

const EMBED_FLUSH_MS = 30_000;
const EMBED_BATCH_MAX = 50;

export function installPrioritizedEmbedding(
  getQmd: () => unknown,
  logDebug: (msg: string) => void,
): (filePath: string) => void {
  const pendingEmbedPaths: string[] = [];
  let embedFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushEmbedBatch = (): void => {
    embedFlushTimer = null;
    // Check backend capability BEFORE dequeuing so an unavailable backend
    // does not drop queued paths (fixes "Embed queue drops on skip").
    const qmd = getQmd() as { embedFiles?: (p: string[]) => Promise<unknown> } | null | undefined;
    if (!qmd || typeof qmd.embedFiles !== "function") {
      // Backend unavailable — leave paths queued; reschedule if any remain.
      if (pendingEmbedPaths.length > 0) {
        embedFlushTimer = setTimeout(flushEmbedBatch, EMBED_FLUSH_MS);
      }
      return;
    }
    const batch = pendingEmbedPaths.splice(0, EMBED_BATCH_MAX);
    if (batch.length === 0) return;
    qmd.embedFiles(batch).then(() => {
      // Reschedule if more paths accumulated during the embed call
      // (fixes "Partial embed batch never rescheduled").
      if (pendingEmbedPaths.length > 0 && embedFlushTimer === null) {
        embedFlushTimer = setTimeout(flushEmbedBatch, EMBED_FLUSH_MS);
      }
    }).catch(() => {
      // Requeue the failed batch at the front so nothing is lost.
      pendingEmbedPaths.unshift(...batch);
      if (embedFlushTimer === null) {
        embedFlushTimer = setTimeout(flushEmbedBatch, EMBED_FLUSH_MS);
      }
    });
  };

  return (filePath: string): void => {
    pendingEmbedPaths.push(filePath);
    if (embedFlushTimer === null) {
      embedFlushTimer = setTimeout(flushEmbedBatch, EMBED_FLUSH_MS);
    }
    logDebug(`prioritized embed: queued ${filePath} (${pendingEmbedPaths.length} pending)`);
  };
}
