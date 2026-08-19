/**
 * Resolve journal source mode (issue #1987 leftover).
 *
 * Pure. File mode ignores heading. Vault mode needs a non-empty heading.
 */

export type JournalSourceResult =
  | { ok: true; mode: "file" }
  | { ok: true; mode: "vault"; heading: string }
  | { ok: false; error: "missing_heading" | "unknown_source" };

export function resolveJournalSource(input: {
  source: string;
  heading: string;
}): JournalSourceResult {
  if (input.source === "file") return { ok: true, mode: "file" };
  if (input.source === "vault") {
    const heading = input.heading.trim();
    if (heading.length === 0) return { ok: false, error: "missing_heading" };
    return { ok: true, mode: "vault", heading };
  }
  return { ok: false, error: "unknown_source" };
}
