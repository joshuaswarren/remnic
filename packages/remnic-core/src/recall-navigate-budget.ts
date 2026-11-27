
export type NavigateBudgetResult =
  | { ok: true; remaining: number }
  | { ok: false; error: "budget_exhausted" };

export function takeNavigateBudget(budget: number, cost: number): NavigateBudgetResult {
  if (budget < 0 || cost < 0) {
    throw new Error(
      `navigate budget and cost must be non-negative; got budget=${JSON.stringify(budget)} cost=${JSON.stringify(cost)}`,
    );
  }
  if (budget === 0 || cost > budget) {
    return { ok: false, error: "budget_exhausted" };
  }
  return { ok: true, remaining: budget - cost };
}
