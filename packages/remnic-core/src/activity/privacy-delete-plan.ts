/**
 * Activity retention deletion planner (issue #2053).
 *
 * Pure: decides what a retention pass may delete. Never performs I/O.
 * Safety rule: a path outside the activity-owned roots is refused, never
 * planned for deletion, so unrelated Remnic memories survive.
 */
import { shouldRetain } from "./privacy.js";

export const ACTIVITY_DELETE_SCOPES = [
  "observations",
  "cards",
  "journal",
  "weekly",
  "providerCache",
] as const;
export type ActivityDeleteScope = (typeof ACTIVITY_DELETE_SCOPES)[number];

const KNOWN_SCOPES: readonly string[] = ACTIVITY_DELETE_SCOPES;

/** Deletion only ever touches these memory-dir-relative roots. */
const OWNED_ROOTS: readonly string[] = ["activity", "wearables", "meetings"];

export interface ActivityDeleteCandidate {
  /** Which activity artifact family this item belongs to. */
  scope: string;
  /** Memory-dir-relative path, POSIX separators. */
  relPath: string;
  capturedAtMs: number;
}

export interface ActivityDeletePlan {
  deletePaths: string[];
  keptCount: number;
  /** Candidates refused because they are not activity-owned paths. */
  refused: string[];
}

function isRefusablePath(relPath: unknown): boolean {
  if (typeof relPath !== "string") return true;
  if (relPath.trim() === "") return true;
  // Validate the EXACT candidate path. Trimming first would let
  // " activity/x.md" validate as owned and then plan a delete for
  // "activity/x.md" — a path the caller never supplied. Surrounding
  // whitespace means this is not a clean owned path: refuse it.
  if (relPath !== relPath.trim()) return true;
  if (relPath.startsWith("/")) return true;
  const segments = relPath.split("/");
  if (segments.includes("..")) return true;
  const [root = "", ...rest] = segments;
  return (
    rest.length === 0 ||
    !OWNED_ROOTS.includes(root) ||
    rest.some((segment) => segment.length === 0)
  );
}

function sortedUnique(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort();
}

export function planActivityDeletion(input: {
  candidates: readonly ActivityDeleteCandidate[];
  scopes: readonly string[];
  retentionDays: number;
  nowMs: number;
}): ActivityDeletePlan {
  const { candidates, scopes, retentionDays, nowMs } = input;

  for (const scope of scopes) {
    if (!KNOWN_SCOPES.includes(scope)) {
      throw new RangeError(`unknown activity delete scope: ${scope}`);
    }
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new RangeError("retentionDays must be a non-negative integer");
  }
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be a finite number");
  }

  const selectedScopes = new Set(scopes);
  const deletePaths: string[] = [];
  const refused: string[] = [];
  let keptCount = 0;

  for (const candidate of candidates) {
    if (!KNOWN_SCOPES.includes(candidate.scope)) {
      refused.push(String(candidate.relPath));
      continue;
    }
    if (!selectedScopes.has(candidate.scope)) continue;
    if (isRefusablePath(candidate.relPath)) {
      refused.push(String(candidate.relPath));
      continue;
    }
    // A corrupt timestamp must never resolve toward deletion: every
    // comparison against NaN is false, which shouldRetain reads as
    // "not retained". Refuse the candidate instead.
    if (typeof candidate.capturedAtMs !== "number" || !Number.isFinite(candidate.capturedAtMs)) {
      refused.push(candidate.relPath);
      continue;
    }
    if (shouldRetain(candidate.capturedAtMs, nowMs, retentionDays, true)) {
      keptCount += 1;
      continue;
    }
    deletePaths.push(candidate.relPath);
  }

  return {
    deletePaths: sortedUnique(deletePaths),
    keptCount,
    refused: sortedUnique(refused),
  };
}
