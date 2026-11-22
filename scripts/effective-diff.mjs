
const MANIFEST_UNSUPPORTED_PREFIXES = ["!", "/"];

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

function patternToRegExp(pattern) {
  const normalized = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let out = "";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
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
 * ({ filename } / { path }, optionally { previous_filename } for renames);
 * pagination to completion is the CALLER's responsibility (GitHub caps
 * listFiles pages at 100 entries — artifact PRs with 3000 files exist).
 *
 * Renames count as ignored only when BOTH sides are ignored: a file renamed
 * FROM a source path INTO an artifact path removes reviewable source and
 * must stay in the effective diff (review finding on #2002).
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
    const previousPath =
      typeof entry === "object" && typeof entry?.previous_filename === "string"
        ? entry.previous_filename
        : null;
    const entirelyIgnored =
      isIgnoredPath(path, patterns) &&
      (previousPath === null || isIgnoredPath(previousPath, patterns));
    (entirelyIgnored ? ignored : effective).push(path);
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
