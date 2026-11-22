
import type {
  StructuralContextDegradation,
  StructuralContextProvider,
} from "./structural-context.js";

// ──────────────────────────────────────────────────────────────────────────

/**
 * A memory candidate as fed into review-context ranking. The shape is a
 * deliberate subset of the core `MemorySummary` / recall result — only the
 * fields we actually need — so this module stays decoupled from the rest of
 * the codebase and can be reused by CLI tools, bench fixtures, etc.
 */
export interface ReviewCandidate {
  /** Opaque identifier. Echoed unchanged in the output. */
  id: string;
  /**
   * Pre-review relevance score from the upstream recall pipeline. Higher is
   * better. `0` is treated as "no prior signal" and gets the full review
   * boost when a path match is found.
   */
  score: number;
  /**
   * References the memory mentions (file paths, entity names, etc.). Used
   * to decide whether any touched file appears in the memory's scope.
   *
   * Accepts `undefined`/missing so callers can pass sparse records from
   * legacy storage without pre-filling.
   */
  entityRefs?: string[];
}

export interface ReviewContext {
  /**
   * Normalized file paths touched by the diff. Each entry is forward-slashed
   * and relative to the repo root when possible.
   */
  touchedFiles: string[];
  /**
   * Candidates re-sorted so memories whose `entityRefs` mention a touched
   * path are boosted. Shape matches the input `ReviewCandidate[]` — the
   * boost is recorded on each entry as `boost` for observability.
   */
  rankedRecall: Array<ReviewCandidate & { boost: number }>;
  /**
   * Structural-context provider degradation observed while expanding the
   * diff to touched symbols (issue #1548 Track A PR 5, #1536 pattern).
   * Present only when a provider was consulted AND it failed — a silent
   * provider failure must never look like "no structural matches"
   * (CLAUDE.md rule 34). Undefined when no provider was consulted (the
   * pure {@link packReviewContext} path) or when the provider succeeded.
   */
  structuralDegradation?: StructuralContextDegradation;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

const REVIEW_KEYWORD_PATTERNS: RegExp[] = [
  /\breview\b/i,
  /\bdiff\b/i,
  /\bwhat changed\b/i,
  /\blook at this pr\b/i,
  /\bwhat('?s|\s+is)\s+in\s+this\s+(pr|patch|diff|change)\b/i,
  /\bcode review\b/i,
];

/**
 * `true` when the prompt looks like a review / diff-explanation request.
 *
 * Empty / non-string input → `false` (the caller shouldn't branch on an
 * invalid prompt).
 */
export function isReviewPrompt(prompt: string | null | undefined): boolean {
  if (typeof prompt !== "string") return false;
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  return REVIEW_KEYWORD_PATTERNS.some((re) => re.test(trimmed));
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse a unified diff and return the set of files touched. Accepts both the
 * `diff --git` form (`diff --git a/foo b/bar`) and the `--- / +++` form
 * (`--- a/foo\n+++ b/bar`). Returns deduplicated, repo-root-relative paths
 * (with the conventional `a/` / `b/` prefixes stripped).
 *
 * Path entries of `/dev/null` (used in adds/deletes) are excluded.
 */
export function parseTouchedFiles(diff: string | null | undefined): string[] {
  if (typeof diff !== "string" || !diff.trim()) return [];
  const touched = new Set<string>();
  const lines = diff.split(/\r?\n/);

  for (const line of lines) {
    //
    // Paths may be quoted by git when they contain spaces or non-ASCII
    // characters, e.g. `diff --git "a/src/my file.ts" "b/src/my file.ts"`.
    const gitPrefix = line.match(/^diff --git\s+/);
    if (gitPrefix) {
      const rest = line.slice(gitPrefix[0].length);
      const paths = splitDiffGitPaths(rest);
      if (paths) {
        for (const raw of paths) {
          const stripped = stripDiffPathPrefix(raw);
          if (stripped && stripped !== "/dev/null") touched.add(stripped);
        }
      }
      continue;
    }
    //
    const headerPrefix = line.match(/^(?:---|\+\+\+)[ \t]+/);
    if (headerPrefix) {
      const sliced = line.slice(headerPrefix[0].length);
      let tailEnd = sliced.length;
      while (tailEnd > 0 && (sliced[tailEnd - 1] === " " || sliced[tailEnd - 1] === "\t")) tailEnd--;
      const tail = sliced.slice(0, tailEnd);
      const raw = extractSingleDiffPathToken(tail);
      if (raw) {
        const stripped = stripDiffPathPrefix(raw);
        if (stripped && stripped !== "/dev/null") touched.add(stripped);
      }
    }
  }

  return Array.from(touched).sort();
}

/**
 * Extract the single path token from the tail of a `---` / `+++` header
 * line. Returns `null` when the tail is empty or malformed (e.g. an
 * unterminated quoted path). The whole tail is consumed — trailing
 * timestamps from non-git diff frontends (`--- a/foo	2023-01-01`) fall
 * into a leading-token extraction like the quoted-form case.
 */
function extractSingleDiffPathToken(tail: string): string | null {
  if (tail.length === 0) return null;
  if (tail[0] === '"') {
    let j = 1;
    while (j < tail.length) {
      if (tail[j] === "\\" && j + 1 < tail.length) {
        j += 2;
        continue;
      }
      if (tail[j] === '"') break;
      j += 1;
    }
    if (j >= tail.length) return null; // unterminated quoted path
    return tail.slice(0, j + 1);
  }
  let j = 0;
  while (j < tail.length && tail[j] !== " " && tail[j] !== "\t") j += 1;
  return tail.slice(0, j);
}

/**
 * Split the `a-path b-path` portion of a `diff --git` line into exactly two
 * path tokens, respecting git's quoting convention. Returns `null` when the
 * input cannot be parsed into exactly two tokens.
 */
function splitDiffGitPaths(rest: string): [string, string] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length && tokens.length < 2) {
    while (i < rest.length && (rest[i] === " " || rest[i] === "\t")) i += 1;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      // Quoted path: consume up to the matching unescaped `"`. Git escapes
      // inner quotes as `\"`, so we respect backslash escaping.
      let j = i + 1;
      while (j < rest.length) {
        if (rest[j] === "\\" && j + 1 < rest.length) {
          j += 2;
          continue;
        }
        if (rest[j] === '"') break;
        j += 1;
      }
      if (j >= rest.length) return null; // unterminated quoted path
      tokens.push(rest.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < rest.length && rest[j] !== " " && rest[j] !== "\t") j += 1;
      tokens.push(rest.slice(i, j));
      i = j;
    }
  }
  if (tokens.length !== 2) return null;
  return [tokens[0]!, tokens[1]!];
}

function stripDiffPathPrefix(raw: string): string {
  let s = raw;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    const decoded = decodeGitCQuotedPath(s.slice(1, -1));
    if (decoded === null) {
      return raw;
    }
    s = decoded;
  }
  s = s.replace(/\\/g, "/");
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s;
}

function decodeGitCQuotedPath(value: string): string | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const appendText = (text: string) => {
    bytes.push(...encoder.encode(text));
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char !== "\\") {
      appendText(char);
      continue;
    }

    if (index + 1 >= value.length) {
      appendText("\\");
      continue;
    }

    const next = value[index + 1]!;
    if (next >= "0" && next <= "7") {
      let octal = next;
      let cursor = index + 2;
      while (cursor < value.length && octal.length < 3) {
        const digit = value[cursor]!;
        if (digit < "0" || digit > "7") break;
        octal += digit;
        cursor += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      index = cursor - 1;
      continue;
    }

    const escaped = cEscapeValue(next);
    if (escaped !== null) {
      appendText(escaped);
      index += 1;
      continue;
    }

    appendText(`\\${next}`);
    index += 1;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

function cEscapeValue(value: string): string | null {
  switch (value) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "\\":
    case '"':
      return value;
    default:
      return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

const BOOST_PER_MATCH = 0.5;
const MAX_BOOST = 1.0;

/**
 * Count how many touched files appear in a memory's entityRefs. Matches are
 * literal substring matches on either direction — either the ref contains
 * the path, or the path contains the ref — so both
 *   - `"src/foo.ts"` refs matching a touched `"src/foo.ts"`, and
 *   - `"foo.ts"` refs matching a touched `"src/foo.ts"`
 * succeed.
 */
function countPathHits(entityRefs: string[] | undefined, touchedFiles: string[]): number {
  if (!entityRefs || entityRefs.length === 0) return 0;
  if (touchedFiles.length === 0) return 0;
  let hits = 0;
  for (const ref of entityRefs) {
    if (typeof ref !== "string" || !ref) continue;
    const lowered = ref.toLowerCase();
    for (const file of touchedFiles) {
      const flower = file.toLowerCase();
      if (lowered === flower) {
        hits += 1;
        break;
      }
      if (lowered.includes(flower) || flower.includes(lowered)) {
        hits += 1;
        break;
      }
    }
  }
  return hits;
}

/**
 * Build a review-context ranking for a set of candidate memories.
 *
 * Contract:
 *   - `touchedFiles` is the parsed diff file list.
 *   - `candidates` is passed through unchanged when no boost applies.
 *   - When a boost applies, the result is sorted by `(score + boost)` desc,
 *     with a stable secondary sort on the original `id` for determinism
 *     (CLAUDE.md #19 — comparators must return 0 for equal items).
 */
export function rankReviewCandidates(
  candidates: ReviewCandidate[],
  touchedFiles: string[],
): Array<ReviewCandidate & { boost: number }> {
  const annotated: Array<ReviewCandidate & { boost: number }> = candidates.map((c) => {
    const hits = countPathHits(c.entityRefs, touchedFiles);
    const boost = Math.min(MAX_BOOST, hits * BOOST_PER_MATCH);
    return { ...c, boost };
  });

  annotated.sort((a, b) => {
    const adjA = a.score + a.boost;
    const adjB = b.score + b.boost;
    if (adjA !== adjB) return adjB - adjA;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return annotated;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export interface PackReviewContextInput {
  /** Unified diff, as produced by `git diff`. */
  diff: string | null | undefined;
  /** Candidate memories from the upstream recall pipeline. */
  candidates: ReviewCandidate[];
}

/**
 * Top-level entry point used by the orchestrator (and CLI / bench) when a
 * review-intent prompt is detected.
 *
 * Parses the diff, re-ranks the candidates, and returns both artefacts so
 * the caller can surface `touchedFiles` as context and `rankedRecall` as
 * the recall result.
 */
export function packReviewContext(input: PackReviewContextInput): ReviewContext {
  const touchedFiles = parseTouchedFiles(input.diff);
  const rankedRecall = rankReviewCandidates(input.candidates, touchedFiles);
  return { touchedFiles, rankedRecall };
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Input for the structural-context-aware review-context packer. The pure
 * {@link packReviewContext} stays unchanged (gate-off parity); this async
 * variant consults a {@link StructuralContextProvider} to expand the diff's
 * touched FILE paths into touched SYMBOL names, widening the match set so
 * memories that mention a changed symbol — not just the file path — float
 * up. The gate (`structuralProvider !== "none"`) is checked ONCE by the
 * caller, never inside this function (rule 39).
 */
export interface PackReviewContextStructuralInput extends PackReviewContextInput {
  /** A probed structural-context provider. Never undefined here. */
  provider: StructuralContextProvider;
  /** Cancellation forwarded to the provider subprocess (rule 40). */
  signal?: AbortSignal;
}

/**
 * Structural-context-aware packer.
 *
 * Contract (issue #1548 Track A PR 5, prove-fail-before characterization):
 *   - Provider returns symbols (`ok: true`) → symbol names are ADDED to the
 *     match set alongside touched files; memories mentioning a symbol get the
 *     same bounded additive boost as a file-path match.
 *   - Provider fails (`ok: false`, any code) → ranking falls back to
 *     FILE-PATH-ONLY boosting, BYTE-IDENTICAL to {@link packReviewContext}
 *     (the match set is exactly the touched files), AND `structuralDegradation`
 *     is populated so xray/doctor can surface the failure (rule 34).
 *
 * The underlying ranker ({@link rankReviewCandidates}) is reused unchanged,
 * so the deterministic ordering, boost cap, and tie-break are identical to
 * the pure path.
 */
export async function packReviewContextStructural(
  input: PackReviewContextStructuralInput,
): Promise<ReviewContext> {
  const touchedFiles = parseTouchedFiles(input.diff);
  const diffString = typeof input.diff === "string" ? input.diff : "";
  const result = await input.provider.symbolsForDiff(diffString, {
    signal: input.signal,
  });

  let matchTerms: string[] = touchedFiles;
  let structuralDegradation: StructuralContextDegradation | undefined;

  if (result.ok) {
    const symbolNames = result.symbols.map((sym) => sym.symbol);
    matchTerms = symbolNames.length > 0 ? [...touchedFiles, ...symbolNames] : touchedFiles;
  } else {
    structuralDegradation = {
      backend: "structural-context",
      code: result.code,
      detail: result.detail,
    };
  }

  const rankedRecall = rankReviewCandidates(input.candidates, matchTerms);
  return { touchedFiles, rankedRecall, structuralDegradation };
}
