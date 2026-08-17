#!/usr/bin/env node
/**
 * Decide which same-head AI Review Gate runs a newer success may clear.
 * A later positive verdict on the SAME head means an older cancelled or
 * failed suite is dead infra, not a product defect.
 */
export function supersededGateRuns(newestSuccess, siblings) {
  if (!newestSuccess || newestSuccess.conclusion !== "success") return [];
  const newestStarted = Date.parse(newestSuccess.run_started_at || newestSuccess.created_at || "");
  if (!Number.isFinite(newestStarted)) return [];
  return siblings.filter((candidate) => {
    if (!candidate || candidate.id === newestSuccess.id) return false;
    if (candidate.status !== "completed") return false;
    if (candidate.conclusion !== "cancelled" && candidate.conclusion !== "failure") return false;
    const started = Date.parse(candidate.run_started_at || candidate.created_at || "");
    return Number.isFinite(started) && started < newestStarted;
  });
}

export function newerRunExists(newestSuccess, siblings) {
  const newestStarted = Date.parse(newestSuccess.run_started_at || newestSuccess.created_at || "");
  if (!Number.isFinite(newestStarted)) return true;
  return siblings.some((candidate) => {
    if (!candidate || candidate.id === newestSuccess.id) return false;
    const started = Date.parse(candidate.run_started_at || candidate.created_at || "");
    return Number.isFinite(started) && started > newestStarted;
  });
}
