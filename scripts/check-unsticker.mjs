export function latestFailedGuardRuns(runs) {
  return runs.filter((run) => run.status === "completed" && run.conclusion === "failure");
}

export function planGuardReruns(runs, unresolvedCount) {
  if (unresolvedCount !== 0) return [];
  return latestFailedGuardRuns(runs);
}
