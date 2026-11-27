export const MAX_REFINES_PER_INVOCATION = 2;

export type RefineRewriteResult =
  | { ok: true; refinedQuery: string }
  | {
      ok: false;
      stop: true;
      reason: "empty_rewrite" | "identical_rewrite" | "refine_budget_spent";
    };

export function validateRefineRewrite(input: {
  currentQuery: string;
  refinedQuery: unknown;
  refinesUsed: number;
}): RefineRewriteResult {
  if (!Number.isInteger(input.refinesUsed) || input.refinesUsed < 0) {
    throw new RangeError(
      `refinesUsed must be a non-negative integer; got ${JSON.stringify(input.refinesUsed)}`,
    );
  }
  if (input.refinesUsed >= MAX_REFINES_PER_INVOCATION) {
    return { ok: false, stop: true, reason: "refine_budget_spent" };
  }
  if (
    typeof input.refinedQuery !== "string" ||
    input.refinedQuery.trim() === ""
  ) {
    return { ok: false, stop: true, reason: "empty_rewrite" };
  }
  const trimmed = input.refinedQuery.trim();
  const currentKey = input.currentQuery
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const refinedKey = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (refinedKey === currentKey) {
    return { ok: false, stop: true, reason: "identical_rewrite" };
  }
  return { ok: true, refinedQuery: trimmed };
}
