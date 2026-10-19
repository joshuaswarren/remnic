/**
 * Stop a projection-rebuild child when its parent is gone.
 *
 * A non-detached fork is reparented, not killed, when the daemon exits. The
 * IPC channel closes first. The child must observe that and refuse to publish,
 * or it can rename `memory-projection.sqlite.tmp` over a projection the
 * replacement daemon has already started serving.
 */

export function projectionRebuildParentDisconnected(): Error {
  return new Error("projection rebuild runner parent disconnected");
}

/** Abort when this process loses its parent IPC channel. */
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
