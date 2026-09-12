const SEARCH_BACKENDS = ["qmd", "remote", "noop", "lancedb", "meilisearch", "orama"] as const;

export type SearchBackendName = (typeof SEARCH_BACKENDS)[number];

export function parseSearchBackend(raw: unknown): SearchBackendName {
  if (raw === undefined || raw === null) return "qmd";
  if (typeof raw === "string" && (SEARCH_BACKENDS as readonly string[]).includes(raw)) {
    return raw as SearchBackendName;
  }
  throw new Error(
    `searchBackend must be one of: ${SEARCH_BACKENDS.join(", ")} (got ${JSON.stringify(raw)})`,
  );
}
