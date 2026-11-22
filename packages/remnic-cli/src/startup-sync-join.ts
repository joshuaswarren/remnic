/**
 * Freshness-dependent one-shot commands join the shared post-ready corpus
 * sync (#3525). A `false` resolution means the sync failed or was skipped —
 * the recall would read a stale index — so surface that instead of silently
 * proceeding.
 */
export async function joinStartupSyncOrWarn(
  orchestrator: { joinStartupSearchSync(signal?: AbortSignal): Promise<boolean> },
  warn: (message: string) => void = (message) => console.warn(`WARNING: ${message}`),
): Promise<void> {
  const synced = await orchestrator.joinStartupSearchSync();
  if (!synced) {
    warn("startup corpus sync did not complete; results may reflect a stale index");
  }
}
