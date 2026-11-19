/**
 * paths-ignore for main-push CI and release (must stay in sync — G1 #3483).
 */
export const RELEASE_MAIN_PUSH_PATHS_IGNORE = [
  "docs/**",
  "/README.md",
  "/CHANGELOG.md",
  "/CONTRIBUTING.md",
  "/SECURITY.md",
  "/CODE_OF_CONDUCT.md",
  ".cursor/**",
  "LICENSE",
];

export const CI_MAIN_PUSH_PATHS_IGNORE = [
  ...RELEASE_MAIN_PUSH_PATHS_IGNORE,
  "**.svg",
  "**.png",
  "**.gif",
];

export const SHIPPED_MD_PREFIXES = [
  "packages/",
  "src/",
  "integrations/",
  "admin-console/",
];

export function isShippedMarkdown(path) {
  if (typeof path !== "string" || !path.endsWith(".md")) return false;
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("docs/")) return false;
  if (SHIPPED_MD_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  if (normalized.endsWith("/SKILL.md") || normalized.endsWith("/AGENTS.md")) return true;
  return false;
}
