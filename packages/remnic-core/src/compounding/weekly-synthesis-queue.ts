/**
 * Single-flight boundary for weekly synthesis, keyed by memory directory.
 * The daemon scheduler and the access surface each drive their own engine
 * instance against the same files; without serialization, concurrent
 * read-modify-write of mistakes.json, rubrics, and the calibration index
 * would let the last finisher discard the other run's updates.
 */

const weeklySynthesisTails = new Map<string, Promise<void>>();

export function queueWeeklySynthesis<T>(memoryDir: string, run: () => Promise<T>): Promise<T> {
  const prior = weeklySynthesisTails.get(memoryDir);
  const next = prior === undefined ? run() : prior.then(run, run);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  weeklySynthesisTails.set(memoryDir, tail);
  void tail.then(() => {
    if (weeklySynthesisTails.get(memoryDir) === tail) weeklySynthesisTails.delete(memoryDir);
  });
  return next;
}
