/**
 * Diff-aware review-context packer (issue #569 PR 4).
 *
 * When an agent is asked "review this PR" / "what changed in this diff" /
 * "look at this diff", the prompt that reaches recall is short and generic
 * — the real signal is the diff itself. This module:
 *
 *   1. Detects review-intent prompts via `isReviewPrompt`.
 *   2. Extracts the touched file list from a unified diff via
 *      `parseTouchedFiles`.
 *   3. Re-ranks a set of candidate memories so that memories whose
 *      `entityRefs` mention a touched path float to the top. The boost is
 *      additive and bounded so it doesn't obliterate the original ranking —
 *      it's a bias, not a filter.
 *
 * Pure — no orchestrator, no storage. Callers inject the candidate memories
 * they already have from their normal recall pipeline. This keeps the
 * module easy to test and integrates cleanly with the existing tiered-recall
 * code in `orchestrator.ts` (the tier itself can be wired later; the pure
 * surface is what PRs 5/6/7 will call).
 */

// ──────────────────────────────────────────────────────────────────────────
// Public types
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
}

// ──────────────────────────────────────────────────────────────────────────
// Review-prompt heuristic
// ──────────────────────────────────────────────────────────────────────────

/**
 * Keyword list from the #569 design doc, plus obvious paraphrases. All
 * matching is case-insensitive and whole-word (so `reviewer` doesn't trigger
 * on `review` alone).
 */
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
// Unified-diff parser — extract touched files
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
    // `diff --git a/foo/bar.ts b/foo/bar.ts`
    //
    // Paths may be quoted by git when they contain spaces or non-ASCII
    // characters, e.g. `diff --git "a/src/my file.ts" "b/src/my file.ts"`.
    // The two paths are always separated by whitespace at the top level, but
    // whitespace INSIDE quoted paths must NOT split the tokens. Parse the
    // two paths with an explicit tokenizer instead of a `\S+`-based regex
    // (which would shatter `"a/my file.ts"` into `"a/my` / `file.ts"`).
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
    // `--- a/foo/bar.ts` or `+++ b/foo/bar.ts` — or quoted:
    // `--- "a/foo bar.ts"` / `+++ "b/foo bar.ts"` when git emits C-quoted
    // paths for whitespace or non-ASCII filenames.
    //
    // Matched with an anchored prefix and an explicit tokenizer for the
    // tail so quoted paths containing whitespace are not split on the
    // first internal space. The previous `\S+` form silently dropped
    // everything after the first whitespace in a quoted path.
    const headerPrefix = line.match(/^(?:---|\+\+\+)[ \t]+/);
    if (headerPrefix) {
      const tail = line.slice(headerPrefix[0].length).replace(/[ \t]+$/, "");
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
  // Unquoted: consume up to the first tab or whitespace-run, so standard
  // `--- a/foo	<timestamp>` lines surface just `a/foo`. For ordinary
  // git-style output the tail has no whitespace at all.
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
    // Skip leading whitespace between tokens.
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
      // Unquoted path: run of non-whitespace.
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
  // Git conventionally prefixes paths with `a/` or `b/` in diffs, and
  // quotes the whole path (including the prefix) when it contains spaces or
  // non-ASCII bytes. Quote-stripping must therefore happen BEFORE the
  // prefix check — otherwise `"a/path with spaces.ts"` still starts with
  // `"a` and the prefix is never recognized.
  let s = raw;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    const decoded = decodeGitCQuotedPath(s.slice(1, -1));
    if (decoded === null) {
      return raw;
    }
    s = decoded;
  }
  // Normalize Windows-style backslashes. Must happen AFTER quote stripping
  // so that C-quote escape pairs are decoded before path separators are
  // normalized.
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
// Ranking
// ──────────────────────────────────────────────────────────────────────────

/**
 * Additive boost per matching touched-file. Tuned so that a single exact
 * match is enough to float a `score=0` candidate above a `score=0.4`
 * unmatched peer, but not so large it buries multi-signal results. `0.5`
 * per match, capped at `1.0` so three matches don't eclipse strong recall.
 */
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
    // Stable secondary sort for deterministic ordering on ties.
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return annotated;
}

// ──────────────────────────────────────────────────────────────────────────
// Packer entry point
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
