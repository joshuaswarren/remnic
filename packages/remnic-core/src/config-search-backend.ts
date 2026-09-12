const SEARCH_BACKENDS = ["qmd", "remote", "noop", "lancedb", "meilisearch", "orama"] as const;

export type SearchBackendName = (typeof SEARCH_BACKENDS)[number];

export function parseSearchBackend(raw: unknown): SearchBackendName {
  if (raw === undefined) return "qmd";
  if (typeof raw === "string" && (SEARCH_BACKENDS as readonly string[]).includes(raw)) {
    return raw as SearchBackendName;
  }
  let shown: string;
  try {
    shown = JSON.stringify(raw) ?? String(raw);
  } catch {
    shown = Object.prototype.toString.call(raw);
  }
  throw new Error(`searchBackend must be one of: ${SEARCH_BACKENDS.join(", ")} (got ${shown})`);
}
