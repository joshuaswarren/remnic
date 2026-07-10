import { log } from "../logger.js";

const pendingWritesByOwner = new WeakMap<object, Set<Promise<void>>>();

export function trackRecallWrite(owner: object, promise: Promise<void>, label: string): void {
  const observed = promise.catch((err) => {
    log.debug(`${label} failed: ${err}`);
  });
  const pendingWrites = pendingWritesByOwner.get(owner) ?? new Set<Promise<void>>();
  pendingWritesByOwner.set(owner, pendingWrites);
  pendingWrites.add(observed);
  void observed.finally(() => {
    pendingWrites.delete(observed);
    if (pendingWrites.size === 0) pendingWritesByOwner.delete(owner);
  });
}

export async function drainRecallWrites(owner: object): Promise<void> {
  while (true) {
    const pendingWrites = pendingWritesByOwner.get(owner);
    if (!pendingWrites || pendingWrites.size === 0) return;
    await Promise.all(pendingWrites);
  }
}
