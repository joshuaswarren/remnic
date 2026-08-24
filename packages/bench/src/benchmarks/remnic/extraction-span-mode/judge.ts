/**
 * Deterministic judge for the span-mode Phase A experiment (issue #2333).
 *
 * Scores a persisted memory against the gold statement as gold-token coverage
 * (recall over the gold's token multiset, 0–100). Same yardstick for both
 * modes. Materialized frame+span memories carry extra verbatim context tokens;
 * a precision term would penalize the format rather than memory quality, so
 * coverage is the honest recall-side proxy for "did the memory retain the
 * information".
 *
 * ponytail: recall-only proxy, no contradiction detection — upgrade to a
 * model-backed judge if Phase A is ever re-run against a real provider.
 */

export function tokenizeForJudge(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export function judgeMemoryScore(memory: string, gold: string): number {
  const goldTokens = tokenizeForJudge(gold);
  if (goldTokens.length === 0) {
    return 0;
  }
  const memoryTokens = tokenizeForJudge(memory);
  const available = new Map<string, number>();
  for (const token of memoryTokens) {
    available.set(token, (available.get(token) ?? 0) + 1);
  }
  let covered = 0;
  for (const token of goldTokens) {
    const count = available.get(token) ?? 0;
    if (count > 0) {
      covered += 1;
      available.set(token, count - 1);
    }
  }
  return (covered / goldTokens.length) * 100;
}
