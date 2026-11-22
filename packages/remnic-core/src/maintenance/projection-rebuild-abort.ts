
export function projectionRebuildParentDisconnected(): Error {
  return new Error("projection rebuild runner parent disconnected");
}

export function watchProjectionRebuildParent(): AbortSignal {
  const abort = new AbortController();
  const stop = () => {
    if (abort.signal.aborted) return;
    abort.abort(projectionRebuildParentDisconnected());
  };
  process.on("disconnect", stop);
  if (process.connected === false) stop();
  return abort.signal;
}

/**
 * Yield so a disconnect that arrived during the previous await is applied,
 * then refuse to continue. No-op when the caller did not pass a signal.
 */
export async function throwIfProjectionRebuildAborted(
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : projectionRebuildParentDisconnected();
}
