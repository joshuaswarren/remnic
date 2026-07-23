/**
 * Capture-time deny-lists, checked FIRST — before any text extraction, hashing,
 * or spool write. A match records NOTHING (not even metadata): the snapshot is
 * dropped whole. Three independent lists, each glob/substring matched
 * case-insensitively: application name, window title, and browser URL. Built-in
 * defaults cover common secret managers and private-browsing windows; the
 * user's config entries are additive.
 */

/** Secret managers whose windows must never be captured. */
export const DEFAULT_DENY_APPS: readonly string[] = ["1Password*", "Bitwarden*", "KeePass*"];

/** Private/incognito window-title heuristics (browsers signal these in the title). */
export const DEFAULT_DENY_TITLES: readonly string[] = [
  "*incognito*",
  "*private browsing*",
  "*inprivate*",
  "*private window*",
];

/** No default URL denials — URL patterns are user-supplied (site-specific). */
export const DEFAULT_DENY_URLS: readonly string[] = [];

export interface DenyLists {
  apps: readonly string[];
  titles: readonly string[];
  urls: readonly string[];
}

export interface DenyCandidate {
  app: string;
  windowTitle: string;
  browserUrl?: string | null;
}

/** Compile a `*`/`?` glob to an anchored, case-insensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** True when `value` matches any glob in `patterns` (case-insensitive). */
export function matchesAnyGlob(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function firstMatch(patterns: readonly string[], value: string, kind: string): string | null {
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(value)) return `${kind}:${pattern}`;
  }
  return null;
}

/**
 * The first deny rule that fires for this candidate, or null. Built-in defaults
 * are always checked in addition to the user lists. The returned string names
 * the rule (`app:1Password*`, `title:*incognito*`, `url:...`) for the
 * `test-snapshot` diagnostic.
 */
export function matchDenyRule(candidate: DenyCandidate, lists: DenyLists): string | null {
  const appRule = firstMatch([...DEFAULT_DENY_APPS, ...lists.apps], candidate.app, "app");
  if (appRule !== null) return appRule;
  const titleRule = firstMatch([...DEFAULT_DENY_TITLES, ...lists.titles], candidate.windowTitle, "title");
  if (titleRule !== null) return titleRule;
  if (typeof candidate.browserUrl === "string" && candidate.browserUrl.length > 0) {
    const urlRule = firstMatch([...DEFAULT_DENY_URLS, ...lists.urls], candidate.browserUrl, "url");
    if (urlRule !== null) return urlRule;
  }
  return null;
}
