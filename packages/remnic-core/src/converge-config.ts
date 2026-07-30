import type { ConvergeConfig, ConvergeConflictPolicy } from "./types.js";

export const CONVERGE_CONFLICT_POLICIES = [
  "newest-wins",
  "manual",
  "keep-both",
] as const satisfies readonly ConvergeConflictPolicy[];

export const DEFAULT_CONVERGE_CONFLICT_POLICY: ConvergeConflictPolicy = "newest-wins";

export function parseConvergeConfig(block: unknown): ConvergeConfig {
  if (block === undefined) {
    return { conflictPolicy: DEFAULT_CONVERGE_CONFLICT_POLICY };
  }
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new Error("converge must be a plain object");
  }
  const prototype = Object.getPrototypeOf(block);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("converge must be a plain object");
  }
  const { conflictPolicy, ...unknown } = block as Record<string, unknown>;
  const unknownKey = Object.keys(unknown)[0];
  if (unknownKey !== undefined) {
    throw new Error(`converge contains unknown key ${JSON.stringify(unknownKey)}`);
  }
  if (conflictPolicy === undefined) {
    return { conflictPolicy: DEFAULT_CONVERGE_CONFLICT_POLICY };
  }
  if (
    typeof conflictPolicy === "string" &&
    CONVERGE_CONFLICT_POLICIES.includes(conflictPolicy as ConvergeConflictPolicy)
  ) {
    return { conflictPolicy: conflictPolicy as ConvergeConflictPolicy };
  }

  throw new Error(
    `converge.conflictPolicy must be one of ${CONVERGE_CONFLICT_POLICIES.join(", ")}; got ${JSON.stringify(conflictPolicy)}`
  );
}
