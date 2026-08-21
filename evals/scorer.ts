/**
 * Shared scoring utilities for memory benchmarks.
 */

/** Exact string match (case-insensitive, trimmed). */
export function exactMatch(predicted: string, expected: string | number | unknown): number {
  return String(predicted ?? "").trim().toLowerCase() === String(expected ?? "").trim().toLowerCase() ? 1.0 : 0.0;
}

/** Token-level F1 score (frequency-aware overlap). */
export function f1Score(predicted: string, expected: string | number | unknown): number {
  const predTokens = tokenize(predicted);
  const expTokens = tokenize(expected);

  if (predTokens.length === 0 && expTokens.length === 0) return 1.0;
  if (predTokens.length === 0 || expTokens.length === 0) return 0.0;

  // Count token frequencies to avoid inflated overlap from duplicates
  const expFreq = new Map<string, number>();
  for (const t of expTokens) expFreq.set(t, (expFreq.get(t) ?? 0) + 1);

  const predFreq = new Map<string, number>();
  for (const t of predTokens) predFreq.set(t, (predFreq.get(t) ?? 0) + 1);

  let overlap = 0;
  for (const [token, expCount] of expFreq) {
    overlap += Math.min(expCount, predFreq.get(token) ?? 0);
  }

  if (overlap === 0) return 0.0;

  const precision = overlap / predTokens.length;
  const recall = overlap / expTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/** ROUGE-L score (longest common subsequence based). */
export function rougeL(predicted: string, expected: string | number | unknown): number {
  const predTokens = tokenize(predicted);
  const expTokens = tokenize(expected);

  if (predTokens.length === 0 && expTokens.length === 0) return 1.0;
  if (predTokens.length === 0 || expTokens.length === 0) return 0.0;

  const lcsLen = lcs(predTokens, expTokens);
  const precision = lcsLen / predTokens.length;
  const recall = lcsLen / expTokens.length;

  if (precision + recall === 0) return 0.0;
  return (2 * precision * recall) / (precision + recall);
}

/** Recall@K: fraction of expected items found in top-K results. */
export function recallAtK(
  retrieved: string[],
  relevant: string[],
  k: number,
): number {
  if (relevant.length === 0) return 1.0;
  const topK = retrieved.slice(0, k).map((s) => s.toLowerCase().trim());
  const relevantSet = new Set(relevant.map((s) => s.toLowerCase().trim()));
  const found = topK.filter((r) => relevantSet.has(r)).length;
  return found / relevantSet.size;
}

/** Substring containment check — does the prediction contain the expected answer? */
export function containsAnswer(predicted: string, expected: string | number | unknown): number {
  const pred = String(predicted ?? "").toLowerCase();
  const exp = String(expected ?? "").toLowerCase().trim();
  if (exp.length === 0) return 0.0;
  return pred.includes(exp) ? 1.0 : 0.0;
}

/** LLM judge score — uses the gateway's model chain for semantic evaluation. */
export async function llmJudgeScore(
  judge: { score(q: string, p: string, e: string): Promise<number> } | undefined,
  question: string,
  predicted: string,
  expected: string,
): Promise<number> {
  if (!judge) return -1; // -1 signals "judge unavailable"
  try {
    return await judge.score(question, predicted, expected);
  } catch {
    return -1;
  }
}

/** Aggregate metrics from an array of per-task scores. */
export function aggregateScores(
  scores: Array<Record<string, number>>,
): Record<string, number> {
  if (scores.length === 0) return {};

  const keys = new Set<string>();
  for (const s of scores) {
    for (const k of Object.keys(s)) keys.add(k);
  }

  const agg: Record<string, number> = {};
  for (const key of keys) {
    const values = scores
      .map((s) => s[key])
      .filter((v) => typeof v === "number" && !isNaN(v));
    if (values.length === 0) continue;
    agg[`${key}_mean`] = values.reduce((a, b) => a + b, 0) / values.length;
    agg[`${key}_min`] = Math.min(...values);
    agg[`${key}_max`] = Math.max(...values);
  }
  return agg;
}

/** Measure execution time of an async function. */
export async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: Math.round(performance.now() - start) };
}

// ── Internal helpers ──

function tokenize(text: string | number | unknown): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function lcs(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  // Space-optimized LCS
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[n];
}
