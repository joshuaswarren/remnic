/**
 * Semantic-layer configuration for @remnic/coding-graph (issue #1556).
 *
 * Rule 30/48: the semantic layer is OFF by default. Embedding costs compute
 * and possibly tokens, so nothing in this module touches a provider, writes
 * a vector, or sends symbol text off-machine unless `enabled` is explicitly
 * true. The gate-off characterization test (`gate-off.test.ts`) asserts
 * this end to end.
 *
 * The config object is intentionally self-contained in this package rather
 * than wired into @remnic/core/config.ts — the coding-graph package is an
 * optional peer dep and must compile standalone. Host integrations
 * (core/config.ts + openclaw.plugin.json schema) resolve to this same
 * shape via `resolveSemanticConfig()`, which reads the documented env vars
 * with the `ENGRAM_` fallback (gotcha 9).
 */
import type { EdgeProvenance } from "../graph-schema.js";

/**
 * Default SIMILAR_TO cosine confirmation threshold (issue #1556 design).
 * 0.92 is the codebase-memory-mcp precedent — high enough to avoid
 * false near-clone pairs across structurally-similar but logically-distinct
 * functions, low enough to catch genuine copy-paste with a renamed
 * variable.
 */
export const DEFAULT_SIMILAR_TO_THRESHOLD = 0.92;

/**
 * Default maximum symbols embedded per indexing run. Bounds per-run
 * provider cost. 0 means unlimited (the host budget is the only cap).
 */
export const DEFAULT_MAX_SYMBOLS_PER_RUN = 0;

/**
 * Confidence band assigned to MinHash-only SIMILAR_TO edges when no
 * embedding provider is available (deterministic, local). Kept below the
 * embedding-confirmed band so consumers can distinguish provenance quality.
 * The issue designates this a distinct, documented lower band.
 */
export const MINHASH_ONLY_CONFIDENCE = 0.5;

/**
 * Confidence band assigned to embedding-confirmed SIMILAR_TO edges. Uses
 * the actual cosine similarity score (≥ similarToThreshold), so this is
 * the FLOOR for that band — the real confidence is the cosine value.
 */
export const EMBEDDING_CONFIRMED_MIN_CONFIDENCE = 0.92;

/**
 * Edge type emitted by the SIMILAR_TO pipeline. Lives in the `edges`
 * table with `provenance: "semantic"` (already in EDGE_PROVENANCE_VALUES).
 */
export const SIMILAR_TO_EDGE_TYPE = "SIMILAR_TO";

/**
 * The single provenance tag for every edge this module writes.
 */
export const SEMANTIC_PROVENANCE: EdgeProvenance = "semantic";

/**
 * Canonical-text body line budget. `signature + doc comment + first N lines
 * of body` per the issue design. N is bounded so a 5k-line function does
 * not dominate the embedded string (and the provider token budget).
 */
export const DEFAULT_CANONICAL_BODY_LINES = 16;

/**
 * Token shingle width for MinHash. 3 tokens per shingle is the standard
 * near-duplicate-detection width — small enough to catch renamed-variable
 * clones (most shingles survive a single rename), large enough that
 * boilerplate coincidence does not flood the candidate set.
 */
export const MINHASH_SHINGLE_WIDTH = 2;

/**
 * Number of MinHash permutations (hash functions). More = tighter Jaccard
 * estimate = more compute. 128 gives ~±5% Jaccard error at p=0.95 which
 * is well inside the 0.92 cosine confirmation gate's margin.
 */
export const MINHASH_NUM_PERMUTATIONS = 128;

/**
 * Number of LSH bands. More bands = more candidate pairs (higher recall,
 * lower precision before the cosine gate). 32 bands of 4 rows each is the
 * banding that pairs a Jaccard ≥ 0.4 with high probability while keeping
 * the candidate set small for typical repos.
 */
export const LSH_NUM_BANDS = 32;

/**
 * The LSH banding — derived: rows per band = permutations / bands.
 */
export const LSH_ROWS_PER_BAND = MINHASH_NUM_PERMUTATIONS / LSH_NUM_BANDS;

/**
 * LSH candidate-pair Jaccard floor implied by the banding (s ≈ (1/b)^(1/r)).
 * Below this Jaccard similarity a pair is almost never a candidate. Kept as
 * a named constant so the determinism test can assert the candidate set is
 * a pure function of (seeds, inputs) without a hidden threshold drift.
 */
export const LSH_CANDIDATE_JACCARD_FLOOR = Math.pow(1 / LSH_NUM_BANDS, 1 / LSH_ROWS_PER_BAND);

/**
 * Self-contained semantic config. Resolved from host config + env.
 *
 * `enabled` is the single gate for the whole layer. When false, every
 * semantic entry point (index-time vector writes, SIMILAR_TO edges,
 * semantic_query) returns a tagged `{ ok: false, code: "semantic_disabled" }`
 * WITHOUT touching the provider or the vectors table (gate-off parity).
 */
export interface SemanticConfig {
  /** Master gate. Default false (rule 30/48). */
  readonly enabled: boolean;
  /** Cosine threshold for SIMILAR_TO confirmation. Default 0.92. */
  readonly similarToThreshold: number;
  /** Per-run embedding budget (0 = unlimited). Default 0. */
  readonly maxSymbolsPerRun: number;
  /** Canonical-text body line budget. Default 16. */
  readonly canonicalBodyLines: number;
}

/**
 * Environment variable names. `REMNIC_*` is primary; `ENGRAM_*` is the
 * fallback (gotcha 9 — legacy env names still bind).
 */
const ENV_ENABLED = ["REMNIC_CODING_GRAPH_SEMANTIC_ENABLED", "ENGRAM_CODING_GRAPH_SEMANTIC_ENABLED"];
const ENV_THRESHOLD = ["REMNIC_CODING_GRAPH_SEMANTIC_SIMILAR_TO_THRESHOLD", "ENGRAM_CODING_GRAPH_SEMANTIC_SIMILAR_TO_THRESHOLD"];
const ENV_MAX_SYMBOLS = ["REMNIC_CODING_GRAPH_SEMANTIC_MAX_SYMBOLS_PER_RUN", "ENGRAM_CODING_GRAPH_SEMANTIC_MAX_SYMBOLS_PER_RUN"];

/**
 * Resolve a boolean env var. Accepts true/false/1/0 (case-insensitive).
 */
/**
 * Coerce a host-provided boolean (which may arrive as a string/number from
 * JSON or CLI config) to a real boolean, so "false"/"0"/"no" do not become
 * truthy and silently enable vector indexing despite an explicit opt-out
 * (chatgpt-codex-connector: 'Coerce host enabled before trusting it').
 * undefined/null → undefined (fall through to env/default).
 */
function coerceHostBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    // Fail CLOSED: only explicit affirmatives enable the layer. Any other
    // value ("false"/"0"/"no"/"off"/"disabled"/""/unknown) is an opt-out,
    // so a malformed or unrecognized host string can never silently enable
    // remote embedding against operator intent (cursor Bugbot: 'Unknown
    // enabled strings enable semantic').
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    return false;
  }
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

/**
 * Coerce a host-provided number (which may arrive as a numeric string from
 * JSON/CLI config) to a finite number, so a malformed value like
 * maxSymbolsPerRun:"abc" cannot become NaN and silently disable the vector
 * budget (NaN > 0 is false → unlimited) or break cosine confirmation
 * (comparisons against NaN are false). undefined/null/non-finite → undefined
 * (fall through to env/default). Negative finite numbers pass through so the
 * downstream clamp still controls range (chatgpt-codex-connector: 'Validate
 * host numeric config before clamping').
 */
function coerceHostNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function resolveBoolEnv(names: readonly string[], fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined) continue;
    const v = raw.trim().toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    // Malformed value: ignore (do not throw — a typo must not crash indexing).
  }
  return fallback;
}

/**
 * Resolve a positive-number env var. Ignores malformed/NaN/negative values
 * rather than throwing (a config typo must not crash the indexer).
 */
function resolveNumberEnv(names: readonly string[], fallback: number, env: NodeJS.ProcessEnv): number {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/**
 * Resolve the semantic config from an optional host-provided partial plus
 * the environment. Explicit host values win; env vars fill the gaps;
 * documented defaults apply last.
 *
 * `env` defaults to `process.env` but is a parameter so tests can pin the
 * environment deterministically (rule 38 — no implicit process state).
 */
export function resolveSemanticConfig(
  host?: Partial<SemanticConfig>,
  env: NodeJS.ProcessEnv = process.env,
): SemanticConfig {
  const enabled =
    coerceHostBool(host?.enabled) ?? resolveBoolEnv(ENV_ENABLED, false, env);
  const similarToThreshold =
    coerceHostNumber(host?.similarToThreshold) ?? resolveNumberEnv(ENV_THRESHOLD, DEFAULT_SIMILAR_TO_THRESHOLD, env);
  const maxSymbolsPerRun =
    coerceHostNumber(host?.maxSymbolsPerRun) ?? resolveNumberEnv(ENV_MAX_SYMBOLS, DEFAULT_MAX_SYMBOLS_PER_RUN, env);
  const canonicalBodyLines =
    coerceHostNumber(host?.canonicalBodyLines) ?? DEFAULT_CANONICAL_BODY_LINES;
  return {
    enabled,
    // Clamp threshold into [0,1] — a malformed env must not produce an
    // out-of-range confidence gate.
    similarToThreshold: Math.min(1, Math.max(0, similarToThreshold)),
    maxSymbolsPerRun: Math.max(0, Math.floor(maxSymbolsPerRun)),
    // canonicalBodyLines: a negative/zero value must NOT clamp to 0 because
    // extractBodyText treats <= 0 as unlimited — sending full symbol bodies to
    // the embedding provider instead of the bounded excerpt (defeats the
    // privacy/cost cap). Fall back to the default instead (#1680).
    canonicalBodyLines: canonicalBodyLines >= 1 ? Math.floor(canonicalBodyLines) : DEFAULT_CANONICAL_BODY_LINES,
  };
}
