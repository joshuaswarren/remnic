/**
 * Effective-diff computation for AI-review scope fences (issue #1991,
 * umbrella #1988).
 *
 * The AI review gate wastes reviewer rounds on PRs whose diff is dominated
 * by generated artifacts (PR #1863 pushed 52k lines of bench artifacts
 * through the bots). `.github/ai-review-ignore` lists artifact paths; the
 * gate computes the PR's EFFECTIVE diff (changed files minus ignored paths)
 * and skips bot-review enforcement when the effective diff is empty.
 *
 * This module is the TESTED MIRROR of the helpers inlined in
 * `.github/workflows/ai-review-gate.yml` (same convention as
 * `scripts/ai-review-gate.mjs`). Keep the two copies in sync when editing.
 *
 * Manifest syntax (deliberately a strict, documented subset of gitignore):
 *   - one pattern per line, repo-root-relative, forward slashes;
 *   - `#` starts a comment; blank lines are skipped;
 *   - `*` matches within a path segment, `**` matches across segments,
 *     `?` matches a single non-separator character;
 *   - a trailing `/` anchors a directory prefix (equivalent to `dir/**`);
 *   - negation (`!`) and leading-slash forms are NOT supported and are a
 *     manifest ERROR — never silently reinterpreted (AGENTS.md §39).
 */

const MANIFEST_UNSUPPORTED_PREFIXES = ["!", "/"];

/**
 * Parse the ignore manifest text into a list of pattern strings.
 * Throws on unsupported syntax so a bad manifest fails the gate loudly
 * instead of silently reviewing (or silently skipping) the wrong files.
 */
export function parseIgnoreManifest(text) {
  if (typeof text !== "string") {
    throw new Error("ai-review-ignore manifest must be a string");
  }
  const patterns = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0 || raw.startsWith("#")) continue;
    for (const prefix of MANIFEST_UNSUPPORTED_PREFIXES) {
      if (raw.startsWith(prefix)) {
        throw new Error(
          `ai-review-ignore line ${i + 1}: unsupported pattern ${JSON.stringify(raw)} — negation and leading-slash forms are not supported (see scripts/effective-diff.mjs)`,
        );
      }
    }
    if (raw.includes("\\")) {
      throw new Error(
        `ai-review-ignore line ${i + 1}: use forward slashes (got ${JSON.stringify(raw)})`,
      );
    }
    patterns.push(raw);
  }
  return patterns;
}

/** Convert one manifest pattern to an anchored RegExp. */
function patternToRegExp(pattern) {
  // Trailing `/` = directory prefix.
  const normalized = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let out = "";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        // `**/` after a slash (or at start) may match zero segments.
        if (normalized[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

/** True when a repo-relative posix path matches any manifest pattern. */
export function isIgnoredPath(path, patterns) {
  if (typeof path !== "string" || path.length === 0) return false;
  const normalized = path.replaceAll("\\", "/");
  for (const pattern of patterns) {
    if (patternToRegExp(pattern).test(normalized)) return true;
  }
  return false;
}

/**
 * Split a PR's changed files into effective (reviewable) and ignored sets.
 *
 * `files` entries may be strings or GitHub API file objects
 * ({ filename } / { path }); pagination to completion is the CALLER's
 * responsibility (GitHub caps listFiles pages at 100 entries — artifact
 * PRs with 3000 files exist).
 */
export function splitEffectiveDiff(files, patterns) {
  if (!Array.isArray(files)) {
    throw new Error("splitEffectiveDiff: files must be an array");
  }
  const effective = [];
  const ignored = [];
  for (const entry of files) {
    const path =
      typeof entry === "string" ? entry : (entry?.filename ?? entry?.path ?? "");
    if (typeof path !== "string" || path.length === 0) {
      throw new Error(
        `splitEffectiveDiff: file entry has no usable path: ${JSON.stringify(entry)}`,
      );
    }
    (isIgnoredPath(path, patterns) ? ignored : effective).push(path);
  }
  return { effective, ignored };
}

/**
 * The artifact-only exception: a PR with at least one changed file whose
 * effective diff is empty needs no AI review round. A PR with ZERO changed
 * files is never artifact-only (that state is anomalous — let the normal
 * gate handle it).
 */
export function isArtifactOnlyPullRequest(files, patterns) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return splitEffectiveDiff(files, patterns).effective.length === 0;
}
