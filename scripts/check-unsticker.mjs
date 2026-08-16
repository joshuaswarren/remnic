// The ruleset evaluates each failed suite on the head, so every failed run
// remains eligible until a rerun replaces it.
export function latestFailedGuardRuns(runs) {
  return runs.filter((run) => run.status === "completed" && run.conclusion === "failure");
}

export function planGuardReruns(runs, unresolvedCount) {
  if (unresolvedCount !== 0) return [];
  return latestFailedGuardRuns(runs);
}
