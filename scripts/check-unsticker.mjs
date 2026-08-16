function runTime(run) {
  return Date.parse(run.run_started_at ?? run.created_at ?? "") || 0;
}

export function latestFailedGuardRuns(runs) {
  const latest = [...runs].sort((a, b) => runTime(a) - runTime(b)).at(-1);
  if (latest?.status !== "completed" || latest.conclusion !== "failure") return [];
  return runs.filter((run) => run.status === "completed" && run.conclusion === "failure");
}

export function planGuardReruns(runs, unresolvedCount) {
  if (unresolvedCount !== 0) return [];
  return latestFailedGuardRuns(runs);
}
