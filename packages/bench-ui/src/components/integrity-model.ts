import type { BenchIntegritySummary } from "../bench-data";

/**
 * Integrity badge levels rendered on the dashboard.
 *
 * - `verified`   — sealed hashes present, holdout split, canary under floor.
 * - `partial`    — most safeguards active, but at least one is missing or
 *                  the result is a public-split / legacy record.
 * - `unverified` — seals missing or canary above floor; treat result with
 *                  suspicion.
 */
export type IntegrityBadgeLevel = "verified" | "partial" | "unverified";

export interface IntegrityBadgeModel {
  level: IntegrityBadgeLevel;
  label: string;
  reasons: string[];
  canaryText: string;
  splitText: string;
  sealLines: string[];
}

function describeSplit(split: BenchIntegritySummary["split"]): string {
  switch (split) {
    case "holdout":
      return "Holdout split (leaderboard-eligible)";
    case "public":
      return "Public split (self-reported, not publishable)";
    default:
      return "Split unknown (legacy result)";
  }
}

function describeCanary(summary: BenchIntegritySummary): string {
  if (summary.canaryScore === null) {
    return "Canary: not recorded";
  }
  const status =
    summary.canaryUnderFloor === true
      ? "under floor"
      : summary.canaryUnderFloor === false
        ? "ABOVE FLOOR"
        : "status unknown";
  return `Canary: ${summary.canaryScore.toFixed(3)} (floor ${summary.canaryFloor.toFixed(2)}, ${status})`;
}

function describeSealLines(summary: BenchIntegritySummary): string[] {
  const lines: string[] = [];
  if (summary.qrelsSealedHashShort) {
    lines.push(`qrels ${summary.qrelsSealedHashShort}`);
  } else {
    lines.push("qrels hash missing");
  }
  if (summary.judgePromptHashShort) {
    lines.push(`judge ${summary.judgePromptHashShort}`);
  } else {
    lines.push("judge prompt hash missing");
  }
  if (summary.datasetHashShort) {
    lines.push(`dataset ${summary.datasetHashShort}`);
  } else {
    lines.push("dataset hash missing");
  }
  return lines;
}

export function describeIntegrity(summary: BenchIntegritySummary): IntegrityBadgeModel {
  const reasons: string[] = [];
  const canaryText = describeCanary(summary);
  const splitText = describeSplit(summary.split);
  const sealLines = describeSealLines(summary);

  let level: IntegrityBadgeLevel = "verified";

  if (!summary.sealsPresent) {
    level = "unverified";
    reasons.push("Sealed-artifact hashes are incomplete.");
  }
  if (summary.split === "unknown") {
    level = level === "verified" ? "partial" : level;
    reasons.push("Dataset split type was not recorded.");
  }
  if (summary.canaryUnderFloor === false) {
    level = "unverified";
    reasons.push("Canary adapter scored above the configured floor.");
  }
  if (summary.canaryScore !== null && summary.canaryUnderFloor === null) {
    level = level === "verified" ? "partial" : level;
    reasons.push("Canary floor comparison was not recorded.");
  }
  if (summary.canaryScore === null) {
    level = level === "verified" ? "partial" : level;
    reasons.push("Canary score was not attached to this result.");
  }
  if (summary.split === "public") {
    level = level === "verified" ? "partial" : level;
    reasons.push("Public-split results are not publishable.");
  }

  const label =
    level === "verified"
      ? "Integrity: verified"
      : level === "partial"
        ? "Integrity: partial"
        : "Integrity: unverified";

  return { level, label, reasons, canaryText, splitText, sealLines };
}
