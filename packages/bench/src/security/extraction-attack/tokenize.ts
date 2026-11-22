
/**
 * Lowercase, split on non-alphanumeric, drop tokens of length <= 2.
 * Matches the regex the harness has used since PR 2 — keep in lockstep
 * with any downstream consumer's expectations (fixtures declare explicit
 * `tokens` arrays that must be reachable through this pipeline).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 2);
}
