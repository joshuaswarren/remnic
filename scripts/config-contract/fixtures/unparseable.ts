/**
 * Fixture: intentionally unparseable construct — the extractor must report
 * it LOUDLY (file:line) instead of silently emitting nothing.
 */
type Rec = Record<string, unknown>;

const DYNAMIC_KEYS = ["alpha", "beta"] as const;

export function parseFixtureUnparseableConfig(value: unknown): Rec {
  const raw = value && typeof value === "object" ? (value as Rec) : {};
  const out: Rec = {};
  for (const key of Object.keys(raw)) {
    out[key] = raw[key];
  }
  for (const key of Object.getOwnPropertyNames(raw)) {
    out[key] = raw[key];
  }
  for (const key of DYNAMIC_KEYS) {
    out[key] = raw[key as string];
  }
  return out;
}
