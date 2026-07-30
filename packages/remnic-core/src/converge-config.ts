import { resolvePluginEntry } from "./plugin-entry-resolver.js";
import type { ConvergeConfig, ConvergeConflictPolicy } from "./types.js";

export const CONVERGE_CONFLICT_POLICIES = [
  "newest-wins",
  "manual",
] as const satisfies readonly ConvergeConflictPolicy[];

export const DEFAULT_CONVERGE_CONFLICT_POLICY: ConvergeConflictPolicy = "newest-wins";
const OPENCLAW_REMNIC_PLUGIN_IDS = ["openclaw-remnic", "openclaw-engram"] as const;

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

export function resolveConvergePluginConfigRecord(
  raw: unknown,
): Record<string, unknown> | undefined {
  const entry = resolvePluginEntry(raw, {
    candidateIds: OPENCLAW_REMNIC_PLUGIN_IDS,
    getEntries: (root) => asPlainRecord(asPlainRecord(root.plugins)?.entries),
    getSlotId: (root) => {
      const memorySlot = asPlainRecord(asPlainRecord(root.plugins)?.slots)?.memory;
      return typeof memorySlot === "string" ? memorySlot : undefined;
    },
  });
  if (entry === undefined || entry.config === undefined) {
    return entry === undefined ? undefined : {};
  }
  const config = asPlainRecord(entry.config);
  if (config === undefined) {
    throw new Error("OpenClaw Remnic plugin config must be a plain object");
  }
  return config;
}

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
