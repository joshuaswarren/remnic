import type { ConvergeConfig, ConvergeConflictPolicy } from "./types.js";

export const CONVERGE_CONFLICT_POLICIES = [
  "newest-wins",
  "manual",
] as const satisfies readonly ConvergeConflictPolicy[];

export const DEFAULT_CONVERGE_CONFLICT_POLICY: ConvergeConflictPolicy = "newest-wins";

/** Default per-request peer HTTP timeout. Boot-scale corpora (100k+ files in one
 *  namespace) can take well over 30s to serve a manifest snapshot. */
export const DEFAULT_CONVERGE_PEER_REQUEST_TIMEOUT_MS = 30_000;
/** Ceiling for the configured timeout — a peer that has not answered in an hour
 *  is unreachable, not slow. */
export const MAX_CONVERGE_PEER_REQUEST_TIMEOUT_MS = 3_600_000;
/**
 * ONE normalization policy for every override source (config JSON, env, CLI
 * flag, programmatic options): malformed values are rejected, valid values
 * clamped to the one-hour ceiling. Returns the clamped ms value.
 */
export function normalizeConvergePeerRequestTimeoutMs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer number of milliseconds; got ${JSON.stringify(value)}`);
  }
  return Math.min(value, MAX_CONVERGE_PEER_REQUEST_TIMEOUT_MS);
}

/** Env override, evaluated lazily so tests control time. Junk is rejected. */
export function envConvergePeerRequestTimeoutMs(): number {
  const raw = process.env.REMNIC_CONVERGE_PEER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONVERGE_PEER_REQUEST_TIMEOUT_MS;
  return normalizeConvergePeerRequestTimeoutMs(Number(raw), "REMNIC_CONVERGE_PEER_TIMEOUT_MS");
}

/** Config-block value: absent -> default, present -> normalized. */
function parsePeerRequestTimeoutMs(value: unknown, label: string): number {
  if (value === undefined) return DEFAULT_CONVERGE_PEER_REQUEST_TIMEOUT_MS;
  return normalizeConvergePeerRequestTimeoutMs(value, label);
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
  const { conflictPolicy: rawConflictPolicy, peerRequestTimeoutMs, ...unknown } = block as Record<string, unknown>;
  let conflictPolicy: unknown = rawConflictPolicy;
  const unknownKey = Object.keys(unknown)[0];
  if (unknownKey !== undefined) {
    throw new Error(`converge contains unknown key ${JSON.stringify(unknownKey)}`);
  }
  if (conflictPolicy === undefined) {
    conflictPolicy = DEFAULT_CONVERGE_CONFLICT_POLICY;
  }
  if (
    typeof conflictPolicy === "string" &&
    CONVERGE_CONFLICT_POLICIES.includes(conflictPolicy as ConvergeConflictPolicy)
  ) {
    return {
      conflictPolicy: conflictPolicy as ConvergeConflictPolicy,
      ...(peerRequestTimeoutMs !== undefined
        ? { peerRequestTimeoutMs: parsePeerRequestTimeoutMs(peerRequestTimeoutMs, "converge.peerRequestTimeoutMs") }
        : {}),
    };
  }

  throw new Error(
    `converge.conflictPolicy must be one of ${CONVERGE_CONFLICT_POLICIES.join(", ")}; got ${JSON.stringify(conflictPolicy)}`
  );
}
