export function raceInitializationGate(
  initialization: Promise<void> | null | undefined,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (!initialization) return Promise.resolve(true);
  if (abortSignal?.aborted) return Promise.resolve(false);
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  return Promise.race([
    initialization.then(() => true, () => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
    ...(abortSignal ? [new Promise<boolean>((resolve) => {
      onAbort = () => resolve(false);
      abortSignal.addEventListener('abort', onAbort, { once: true });
    })] : []),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (onAbort) abortSignal?.removeEventListener('abort', onAbort);
  });
}
