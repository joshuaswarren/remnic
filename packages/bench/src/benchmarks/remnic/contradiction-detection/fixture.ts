/**
 * Synthetic fixture for the contradiction-detection benchmark
 * (issue #647).
 *
 * Five fixture classes exercise every verdict in the judge taxonomy:
 *
 *   true-contradiction  — pairs that genuinely contradict
 *   near-paraphrase     — semantically equivalent, should be "duplicates"
 *   independent-similar — same topic, different claims, no conflict
 *   independent-distant — unrelated memories
 *   needs-user         — ambiguous pairs that should defer to human review
 *
 * Each case includes a deterministic "judge" that inspects the pair
 * text with simple heuristics (no LLM).  The bench runner compares
 * the heuristic verdict against the expected ground-truth to produce
 * per-verdict precision/recall metrics.
 *
 * Deterministic — no clock, RNG, or I/O.
 */

export type ContradictionFixtureVerdict =
  | "contradicts"
  | "duplicates"
  | "independent"
  | "needs-user";

export interface ContradictionBenchCase {
  id: string;
  title: string;
  /** Text of memory A. */
  textA: string;
  /** Text of memory B. */
  textB: string;
  /** Ground-truth relationship between the two memories. */
  expectedVerdict: ContradictionFixtureVerdict;
  /** Category label for A (optional). */
  categoryA?: string;
  /** Category label for B (optional). */
  categoryB?: string;
}

// ── True contradictions ──────────────────────────────────────────────────────

const TRUE_CONTRADICTIONS: ContradictionBenchCase[] = [
  {
    id: "contra-1",
    title: "Opposing toolchain choices",
    textA: "The project uses pnpm as its package manager.",
    textB: "The project switched from pnpm to npm for all package management.",
    expectedVerdict: "contradicts",
    categoryA: "decision",
    categoryB: "decision",
  },
  {
    id: "contra-2",
    title: "Conflicting API ports",
    textA: "The HTTP server listens on port 3000.",
    textB: "The gateway binds to port 8080, not 3000 — 3000 was deprecated.",
    expectedVerdict: "contradicts",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "contra-3",
    title: "Opposing feature flags",
    textA: "Feature extraction-judge is enabled by default for all new installs.",
    textB: "The extraction judge gate is disabled by default and must be opted into.",
    expectedVerdict: "contradicts",
    categoryA: "decision",
    categoryB: "decision",
  },
  {
    id: "contra-4",
    title: "Temporal flip on defaults",
    textA: "Recall uses BM25-only mode by default; vector search requires explicit opt-in.",
    textB: "Vector search is now the default retrieval path. BM25 is only used as a fallback.",
    expectedVerdict: "contradicts",
    categoryA: "decision",
    categoryB: "decision",
  },
  {
    id: "contra-5",
    title: "Opposing storage locations",
    textA: "Session state is stored in memory and lost on restart.",
    textB: "All session state is persisted to disk and survives restarts.",
    expectedVerdict: "contradicts",
    categoryA: "fact",
    categoryB: "fact",
  },
];

// ── Near-paraphrase duplicates ───────────────────────────────────────────────

const NEAR_PARAPHRASE: ContradictionBenchCase[] = [
  {
    id: "dup-1",
    title: "Identical package version",
    textA: "Remnic depends on TypeScript 5.9.",
    textB: "Remnic depends on TypeScript version 5.9.",
    expectedVerdict: "duplicates",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "dup-2",
    title: "Rewritten config description",
    textA: "The default memory directory is ~/.remnic/memories.",
    textB: "The default memory directory is set to ~/.remnic/memories.",
    expectedVerdict: "duplicates",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "dup-3",
    title: "Same architectural note",
    textA: "The orchestrator coordinates extraction, recall, and buffering in a three-phase lifecycle.",
    textB: "The orchestrator coordinates extraction, recall, and buffering through three lifecycle phases.",
    expectedVerdict: "duplicates",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "dup-4",
    title: "Same rule restated",
    textA: "Never commit API keys or secrets to the repository.",
    textB: "Never commit API keys or secrets to the repository.",
    expectedVerdict: "duplicates",
    categoryA: "principle",
    categoryB: "principle",
  },
];

// ── Independent but similar (same topic, no conflict) ────────────────────────

const INDEPENDENT_SIMILAR: ContradictionBenchCase[] = [
  {
    id: "ind-sim-1",
    title: "Same project, different subsystems",
    textA: "The extraction engine uses GPT-5.2 via the Responses API.",
    textB: "Recall search is powered by QMD with hybrid BM25 and vector retrieval.",
    expectedVerdict: "independent",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "ind-sim-2",
    title: "Same person, different facts",
    textA: "Joshua works on the Remnic memory layer.",
    textB: "Joshua prefers pnpm and uses Neovim for development.",
    expectedVerdict: "independent",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "ind-sim-3",
    title: "Same config area, different keys",
    textA: "The extraction judge gate uses an LLM-as-judge with configurable defer cap.",
    textB: "The extraction judge training data collection is opt-in via collectJudgeTrainingPairs.",
    expectedVerdict: "independent",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "ind-sim-4",
    title: "Same module, different functions",
    textA: "The buffer tracks turn counts and extraction timing per session key.",
    textB: "The buffer's surprise-gated flush triggers when surprise exceeds the configured threshold.",
    expectedVerdict: "independent",
    categoryA: "fact",
    categoryB: "fact",
  },
];

// ── Independent and dissimilar ───────────────────────────────────────────────

const INDEPENDENT_DISSIMILAR: ContradictionBenchCase[] = [
  {
    id: "ind-dis-1",
    title: "Completely unrelated domains",
    textA: "The consolidation cron runs nightly at 3 AM server time.",
    textB: "Page versioning stores snapshots in a numbered sidecar directory.",
    expectedVerdict: "independent",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "ind-dis-2",
    title: "Different concerns entirely",
    textA: "The CLI supports a recall-explain command with session and format flags.",
    textB: "Memory importers are available for ChatGPT, Claude, Gemini, and Mem0.",
    expectedVerdict: "independent",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "ind-dis-3",
    title: "No topic overlap",
    textA: "The gateway uses launchd for process management on macOS.",
    textB: "The taxonomy resolver uses MECE mutually-exclusive categorization.",
    expectedVerdict: "independent",
    categoryA: "fact",
    categoryB: "fact",
  },
];

// ── Needs-user (ambiguous / defer to human) ──────────────────────────────────

const NEEDS_USER: ContradictionBenchCase[] = [
  {
    id: "needs-user-1",
    title: "Contradiction signal but unrelated topic",
    textA: "The timezone is set to UTC for all cron jobs.",
    textB: "The database driver was replaced with a connection pool implementation.",
    expectedVerdict: "needs-user",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "needs-user-2",
    title: "Switch keyword with no semantic link",
    textA: "The color scheme preference is dark mode.",
    textB: "The build system switched from webpack to vite for faster builds.",
    expectedVerdict: "needs-user",
    categoryA: "fact",
    categoryB: "fact",
  },
  {
    id: "needs-user-3",
    title: "Deprecated mention with no context overlap",
    textA: "The configuration file format is JSON only.",
    textB: "YAML support was deprecated last quarter in favor of TOML.",
    expectedVerdict: "needs-user",
    categoryA: "decision",
    categoryB: "decision",
  },
];

// ── Exports ──────────────────────────────────────────────────────────────────

export const CONTRADICTION_DETECTION_FIXTURE: ContradictionBenchCase[] = [
  ...TRUE_CONTRADICTIONS,
  ...NEAR_PARAPHRASE,
  ...INDEPENDENT_SIMILAR,
  ...INDEPENDENT_DISSIMILAR,
  ...NEEDS_USER,
];

export const CONTRADICTION_DETECTION_SMOKE_FIXTURE: ContradictionBenchCase[] = [
  TRUE_CONTRADICTIONS[0],
  NEAR_PARAPHRASE[0],
  INDEPENDENT_SIMILAR[0],
  INDEPENDENT_DISSIMILAR[0],
  NEEDS_USER[0],
];
