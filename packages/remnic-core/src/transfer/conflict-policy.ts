const CONFLICT_POLICIES = ["skip", "overwrite", "dedupe"] as const;

export type ConflictPolicy = typeof CONFLICT_POLICIES[number];

export function parseConflictPolicy(
  value: unknown,
  context: string,
): ConflictPolicy {
  if (value === undefined) return "skip";
  if (typeof value === "string" && (CONFLICT_POLICIES as readonly string[]).includes(value)) {
    return value as ConflictPolicy;
  }
  throw new Error(
    `${context}: invalid conflict policy "${String(value)}"; expected skip, overwrite, or dedupe`,
  );
}
