export function createTaskExit(onExit?: () => void) {
  let started = false;
  let reported = false;
  const report = (): void => {
    if (reported) return;
    reported = true;
    onExit?.();
  };
  return {
    start: () => {
      started = true;
    },
    settled: () => {
      if (!started) report();
    },
    report,
  };
}
