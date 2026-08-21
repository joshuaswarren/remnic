import { normalizeIsoTimestamp, roundMetric } from "./schema.js";
import type {
  LedgerCalibrationBin,
  LedgerClaim,
  LedgerDomainCalibration,
  LedgerDormantTopic,
  LedgerFlippedClaim,
  LedgerReflectionOptions,
  LedgerReflectionReport,
} from "./types.js";

const DEFAULT_DORMANT_AFTER_DAYS = 60;

export function buildReflectionReport(
  claims: LedgerClaim[],
  options: LedgerReflectionOptions = {}
): LedgerReflectionReport {
  const nowIso = normalizeIsoTimestamp("reflection.now", options.now ?? new Date().toISOString());
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) {
    throw new Error(`reflection now must be a valid ISO timestamp, got ${String(options.now)}`);
  }
  const resolvedPredictions = claims.filter(
    (claim) => claim.kind === "prediction" && claim.resolution?.brierScore !== undefined
  );
  const brierScore =
    resolvedPredictions.length > 0
      ? roundMetric(mean(resolvedPredictions.map((claim) => claim.resolution?.brierScore ?? 0)))
      : undefined;

  return {
    generatedAt: new Date(now).toISOString(),
    totalClaims: claims.length,
    activeClaims: claims.filter((claim) => claim.status === "active").length,
    resolvedPredictions: resolvedPredictions.length,
    ...(brierScore !== undefined ? { brierScore } : {}),
    calibrationBins: buildCalibrationBins(resolvedPredictions),
    domains: buildDomainCalibration(resolvedPredictions),
    flippedClaims: buildFlippedClaims(claims),
    dormantTopics: buildDormantTopics(claims, now, options.dormantAfterDays ?? DEFAULT_DORMANT_AFTER_DAYS),
  };
}

function buildCalibrationBins(claims: LedgerClaim[]): LedgerCalibrationBin[] {
  const bins = [
    { minConfidence: 0, maxConfidence: 0.2 },
    { minConfidence: 0.2, maxConfidence: 0.4 },
    { minConfidence: 0.4, maxConfidence: 0.6 },
    { minConfidence: 0.6, maxConfidence: 0.8 },
    { minConfidence: 0.8, maxConfidence: 1.000001 },
  ];
  return bins
    .map((bin) => {
      const members = claims.filter(
        (claim) => claim.confidence >= bin.minConfidence && claim.confidence < bin.maxConfidence
      );
      if (members.length === 0) return null;
      const predicted = mean(members.map((claim) => claim.confidence));
      const actual = mean(members.map((claim) => claim.resolution?.actualConfidence ?? 0.5));
      return {
        minConfidence: bin.minConfidence,
        maxConfidence: bin.maxConfidence > 1 ? 1 : bin.maxConfidence,
        count: members.length,
        meanPredictedConfidence: roundMetric(predicted),
        meanActualConfidence: roundMetric(actual),
        calibrationError: roundMetric(predicted - actual),
      };
    })
    .filter((bin): bin is LedgerCalibrationBin => bin !== null);
}

function buildDomainCalibration(claims: LedgerClaim[]): LedgerDomainCalibration[] {
  const grouped = new Map<string, LedgerClaim[]>();
  for (const claim of claims) {
    const domain = claim.scope.domain?.trim() || "uncategorized";
    grouped.set(domain, [...(grouped.get(domain) ?? []), claim]);
  }

  return [...grouped.entries()]
    .map(([domain, members]) => {
      const predicted = mean(members.map((claim) => claim.confidence));
      const actual = mean(members.map((claim) => claim.resolution?.actualConfidence ?? 0.5));
      const error = predicted - actual;
      const tendency: LedgerDomainCalibration["tendency"] =
        Math.abs(error) <= 0.1 ? "well_calibrated" : error > 0 ? "overconfident" : "underconfident";
      return {
        domain,
        count: members.length,
        brierScore: roundMetric(mean(members.map((claim) => claim.resolution?.brierScore ?? 0))),
        meanPredictedConfidence: roundMetric(predicted),
        meanActualConfidence: roundMetric(actual),
        tendency,
      };
    })
    .sort((a, b) => {
      const countOrder = b.count - a.count;
      if (countOrder !== 0) return countOrder;
      return a.domain.localeCompare(b.domain);
    });
}

function buildFlippedClaims(claims: LedgerClaim[]): LedgerFlippedClaim[] {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const groups = new Map<string, LedgerClaim[]>();
  for (const claim of claims) {
    const root = findRootClaimId(claim, byId);
    groups.set(root, [...(groups.get(root) ?? []), claim]);
  }

  return [...groups.entries()]
    .map(([rootClaimId, members]) => {
      const sorted = [...members].sort((a, b) => {
        const createdOrder = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        if (createdOrder !== 0) return createdOrder;
        return a.id.localeCompare(b.id);
      });
      let flipCount = 0;
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i - 1]?.stance !== sorted[i]?.stance) flipCount += 1;
      }
      if (flipCount === 0) return null;
      return {
        rootClaimId,
        claimIds: sorted.map((claim) => claim.id),
        statements: sorted.map((claim) => claim.statement),
        flipCount,
      };
    })
    .filter((item): item is LedgerFlippedClaim => item !== null)
    .sort((a, b) => {
      const flipOrder = b.flipCount - a.flipCount;
      if (flipOrder !== 0) return flipOrder;
      return a.rootClaimId.localeCompare(b.rootClaimId);
    });
}

function findRootClaimId(claim: LedgerClaim, byId: Map<string, LedgerClaim>): string {
  const seen = new Set<string>();
  let cursor: LedgerClaim | undefined = claim;
  while (cursor) {
    if (seen.has(cursor.id)) return cursor.id;
    seen.add(cursor.id);
    const parentId = cursor.supersedes ?? cursor.parentIds[0];
    if (!parentId) return cursor.id;
    const parent = byId.get(parentId);
    if (!parent) return parentId;
    cursor = parent;
  }
  return claim.id;
}

function buildDormantTopics(claims: LedgerClaim[], nowMs: number, dormantAfterDays: number): LedgerDormantTopic[] {
  if (!Number.isFinite(dormantAfterDays) || dormantAfterDays < 0) {
    throw new Error(`dormantAfterDays must be a non-negative number, got ${String(dormantAfterDays)}`);
  }
  const topics = new Map<string, { lastClaimAt: string; claimCount: number }>();
  for (const claim of claims) {
    const activityAt = claimActivityAt(claim);
    for (const topic of claimTopics(claim)) {
      const existing = topics.get(topic);
      if (!existing || Date.parse(activityAt) > Date.parse(existing.lastClaimAt)) {
        topics.set(topic, {
          lastClaimAt: activityAt,
          claimCount: (existing?.claimCount ?? 0) + 1,
        });
      } else {
        existing.claimCount += 1;
      }
    }
  }

  return [...topics.entries()]
    .map(([topic, entry]) => {
      const ageDays = (nowMs - Date.parse(entry.lastClaimAt)) / (24 * 60 * 60 * 1_000);
      return {
        topic,
        lastClaimAt: entry.lastClaimAt,
        daysSilent: Math.max(0, Math.floor(ageDays)),
        claimCount: entry.claimCount,
      };
    })
    .filter((topic) => topic.daysSilent >= dormantAfterDays)
    .sort((a, b) => {
      const daysOrder = b.daysSilent - a.daysSilent;
      if (daysOrder !== 0) return daysOrder;
      return a.topic.localeCompare(b.topic);
    });
}

function claimActivityAt(claim: LedgerClaim): string {
  return Date.parse(claim.updatedAt) >= Date.parse(claim.createdAt) ? claim.updatedAt : claim.createdAt;
}

function claimTopics(claim: LedgerClaim): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const topic of [...(claim.scope.domain ? [claim.scope.domain] : []), ...claim.scope.entities]) {
    const trimmed = topic.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(trimmed);
  }
  return topics;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
