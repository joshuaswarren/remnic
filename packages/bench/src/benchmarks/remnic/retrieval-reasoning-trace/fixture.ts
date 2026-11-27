
export interface ReasoningTraceBenchCandidate {
  docid: string;
  /** Absolute-style path mimicking the real storage layout. */
  path: string;
  /** Pre-boost score from the upstream QMD/hybrid tier. */
  score: number;
  /** Short snippet used only for debugging output in failures. */
  snippet: string;
}

export interface ReasoningTraceBenchCase {
  id: string;
  query: string;
  candidates: ReasoningTraceBenchCandidate[];
  /**
   * When true, the boost must promote the case's expected reasoning_trace
   * memory to rank 1. When false, the boost must NOT change the top result
   * (false-positive guard cases).
   */
  expectsTraceTopAfterBoost: boolean;
  expectedTopWithoutBoost: string;
  expectedTopWithBoost?: string;
  /**
   * Whether the query should be classified as problem-solving by the
   * shipped heuristic. Used by the scorer to verify classification.
   */
  expectedProblemSolving: boolean;
}

function trace(
  docid: string,
  score: number,
  snippet: string,
): ReasoningTraceBenchCandidate {
  return {
    docid,
    path: `reasoning-traces/2026-04-18/${docid}.md`,
    score,
    snippet,
  };
}

function fact(
  docid: string,
  score: number,
  snippet: string,
): ReasoningTraceBenchCandidate {
  return {
    docid,
    path: `facts/2026-04-18/${docid}.md`,
    score,
    snippet,
  };
}

function seedPool(
  expectedTrace: "trace-latency" | "trace-oauth-loop" = "trace-latency",
): ReasoningTraceBenchCandidate[] {
  const firstTrace = expectedTrace === "trace-latency"
    ? trace("trace-latency", 0.72, "How I debugged the staging latency spike")
    : trace("trace-oauth-loop", 0.72, "How I untangled the OAuth redirect loop");
  const secondTrace = expectedTrace === "trace-latency"
    ? trace("trace-oauth-loop", 0.68, "How I untangled the OAuth redirect loop")
    : trace("trace-latency", 0.68, "How I debugged the staging latency spike");
  return [
    fact("fact-pg-15", 0.81, "remnic runs on Postgres 15"),
    fact("fact-node-22", 0.78, "remnic requires Node 22.12 or newer"),
    fact("fact-qmd", 0.74, "remnic uses qmd for hybrid retrieval"),
    firstTrace,
    fact("fact-pnpm", 0.70, "remnic uses pnpm as the package manager"),
    secondTrace,
    fact("fact-monorepo", 0.67, "remnic lives in a pnpm workspace monorepo"),
    fact("fact-tsx", 0.60, "tests run under tsx --test"),
    fact("fact-release", 0.57, "release-please drives the release workflow"),
    fact("fact-codeql", 0.55, "CodeQL scans run on every PR"),
    fact("fact-review", 0.50, "PR reviews require both cursor and codex bots to post"),
    fact("fact-hooks", 0.47, "pre-commit hooks run lint and quick tests"),
    fact("fact-dash", 0.45, "admin console is built in the core package"),
    fact("fact-docs", 0.40, "docs are in /docs, not per-package"),
    fact("fact-export", 0.35, "@remnic/export-weclone is a separate optional package"),
  ];
}

export const REASONING_TRACE_BENCH_FIXTURE: ReasoningTraceBenchCase[] = [
  {
    id: "pos-latency-howto",
    query: "How do I debug a latency spike in staging?",
    candidates: seedPool(),
    expectsTraceTopAfterBoost: true,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedTopWithBoost: "trace-latency",
    expectedProblemSolving: true,
  },
  {
    id: "pos-oauth-step-by-step",
    query: "walk me through fixing an OAuth redirect loop step by step",
    candidates: seedPool("trace-oauth-loop"),
    expectsTraceTopAfterBoost: true,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedTopWithBoost: "trace-oauth-loop",
    expectedProblemSolving: true,
  },
  {
    id: "pos-troubleshoot-oauth",
    query: "troubleshoot the OAuth loop we hit last quarter",
    candidates: seedPool("trace-oauth-loop"),
    expectsTraceTopAfterBoost: true,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedTopWithBoost: "trace-oauth-loop",
    expectedProblemSolving: true,
  },
  {
    id: "pos-figure-out-latency",
    query: "how can I figure out why staging is slow",
    candidates: seedPool(),
    expectsTraceTopAfterBoost: true,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedTopWithBoost: "trace-latency",
    expectedProblemSolving: true,
  },
  {
    id: "pos-reason-through",
    query: "Help me reason through the staging latency incident",
    candidates: seedPool(),
    expectsTraceTopAfterBoost: true,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedTopWithBoost: "trace-latency",
    expectedProblemSolving: true,
  },
  {
    id: "neg-postgres-version",
    query: "what postgres version does remnic use",
    candidates: seedPool(),
    expectsTraceTopAfterBoost: false,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedProblemSolving: false,
  },
  {
    id: "neg-node-requirement",
    query: "node engine requirement",
    candidates: seedPool(),
    expectsTraceTopAfterBoost: false,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedProblemSolving: false,
  },
  {
    id: "neg-package-manager",
    query: "package manager for remnic",
    candidates: seedPool(),
    expectsTraceTopAfterBoost: false,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedProblemSolving: false,
  },
  {
    id: "neg-monorepo-layout",
    query: "monorepo workspace layout",
    candidates: seedPool(),
    expectsTraceTopAfterBoost: false,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedProblemSolving: false,
  },
  {
    id: "neg-release-process",
    query: "release automation tool",
    candidates: seedPool(),
    expectsTraceTopAfterBoost: false,
    expectedTopWithoutBoost: "fact-pg-15",
    expectedProblemSolving: false,
  },
];
