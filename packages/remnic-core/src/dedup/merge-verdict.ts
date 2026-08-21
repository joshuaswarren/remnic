/**
 * Strict parser for free-form merge-judge verdicts (issue #2330 slice).
 *
 * Keeps "unparseable answer" distinguishable from a deliberate "create"
 * while still failing closed: every failure carries decision "create".
 */

export const MERGE_JUDGE_VERDICTS = ["merge", "create", "uncertain"] as const;
export type MergeJudgeVerdictName = (typeof MERGE_JUDGE_VERDICTS)[number];

export type ParseMergeVerdictResult =
  | { ok: true; verdict: MergeJudgeVerdictName; decision: "merge" | "create" }
  | { ok: false; error: "empty_verdict" | "unknown_verdict"; decision: "create" };

export function parseMergeJudgeVerdict(raw: unknown): ParseMergeVerdictResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "empty_verdict", decision: "create" };
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") {
    return { ok: false, error: "empty_verdict", decision: "create" };
  }
  if (!(MERGE_JUDGE_VERDICTS as readonly string[]).includes(normalized)) {
    return { ok: false, error: "unknown_verdict", decision: "create" };
  }
  return {
    ok: true,
    verdict: normalized as MergeJudgeVerdictName,
    decision: normalized === "merge" ? "merge" : "create",
  };
}
