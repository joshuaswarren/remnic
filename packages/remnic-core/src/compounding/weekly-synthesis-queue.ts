
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
