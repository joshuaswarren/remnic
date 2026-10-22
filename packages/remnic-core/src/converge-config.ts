import { readEnvVar } from "./runtime/env.js";
import {
  type CaptureWriteLockBackoffLimits,
  normalizeCaptureWriteLockWaitMs,
  resolveCaptureWriteLockBackoffLimits,
} from "./storage/capture-write-lock-backoff.js";
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

function parseOptionalCaptureLockMs(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return normalizeCaptureWriteLockWaitMs(value, label);
}

/**
 * Config values win over env. An omitted knob stays omitted here so the
 * caller can still fall through to the built-in default. Env is read with
 * the REMNIC_ name and the legacy ENGRAM_ name.
 */
function envCaptureLockMs(name: string): number | undefined {
  const raw = readEnvVar(name);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 15) {
    throw new Error(`${name} must be a positive integer number of milliseconds; got ${JSON.stringify(raw)}`);
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 48 || code > 57) {
      throw new Error(`${name} must be a positive integer number of milliseconds; got ${JSON.stringify(raw)}`);
    }
  }
  return normalizeCaptureWriteLockWaitMs(Number(trimmed), name);
}

export function resolveConvergeCaptureWriteLockBackoff(
  config: ConvergeConfig | undefined
): CaptureWriteLockBackoffLimits {
  return resolveCaptureWriteLockBackoffLimits({
    captureWriteLockInitialDelayMs:
      config?.captureWriteLockInitialDelayMs ?? envCaptureLockMs("REMNIC_CONVERGE_CAPTURE_LOCK_INITIAL_DELAY_MS"),
    captureWriteLockMaxDelayMs:
      config?.captureWriteLockMaxDelayMs ?? envCaptureLockMs("REMNIC_CONVERGE_CAPTURE_LOCK_MAX_DELAY_MS"),
    captureWriteLockDeadlineMs:
      config?.captureWriteLockDeadlineMs ?? envCaptureLockMs("REMNIC_CONVERGE_CAPTURE_LOCK_DEADLINE_MS"),
  });
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
  const {
    conflictPolicy: rawConflictPolicy,
    peerRequestTimeoutMs,
    captureWriteLockInitialDelayMs,
    captureWriteLockMaxDelayMs,
    captureWriteLockDeadlineMs,
    ...unknown
  } = block as Record<string, unknown>;
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
    const initialDelayMs = parseOptionalCaptureLockMs(
      captureWriteLockInitialDelayMs,
      "converge.captureWriteLockInitialDelayMs"
    );
    const maxDelayMs = parseOptionalCaptureLockMs(captureWriteLockMaxDelayMs, "converge.captureWriteLockMaxDelayMs");
    const deadlineMs = parseOptionalCaptureLockMs(captureWriteLockDeadlineMs, "converge.captureWriteLockDeadlineMs");
    // Reject an inverted schedule at parse time. Omitted knobs stay omitted
    // and are filled from defaults only when the acquire runs.
    if (initialDelayMs !== undefined && maxDelayMs !== undefined && initialDelayMs > maxDelayMs) {
      throw new Error(
        `converge.captureWriteLockInitialDelayMs (${initialDelayMs}) must be <= converge.captureWriteLockMaxDelayMs (${maxDelayMs})`
      );
    }
    if (maxDelayMs !== undefined && deadlineMs !== undefined && maxDelayMs > deadlineMs) {
      throw new Error(
        `converge.captureWriteLockMaxDelayMs (${maxDelayMs}) must be <= converge.captureWriteLockDeadlineMs (${deadlineMs})`
      );
    }
    if (initialDelayMs !== undefined && deadlineMs !== undefined && initialDelayMs > deadlineMs) {
      throw new Error(
        `converge.captureWriteLockInitialDelayMs (${initialDelayMs}) must be <= converge.captureWriteLockDeadlineMs (${deadlineMs})`
      );
    }
    return {
      conflictPolicy: conflictPolicy as ConvergeConflictPolicy,
      ...(peerRequestTimeoutMs !== undefined
        ? { peerRequestTimeoutMs: parsePeerRequestTimeoutMs(peerRequestTimeoutMs, "converge.peerRequestTimeoutMs") }
        : {}),
      ...(initialDelayMs !== undefined ? { captureWriteLockInitialDelayMs: initialDelayMs } : {}),
      ...(maxDelayMs !== undefined ? { captureWriteLockMaxDelayMs: maxDelayMs } : {}),
      ...(deadlineMs !== undefined ? { captureWriteLockDeadlineMs: deadlineMs } : {}),
    };
  }

  throw new Error(
    `converge.conflictPolicy must be one of ${CONVERGE_CONFLICT_POLICIES.join(", ")}; got ${JSON.stringify(conflictPolicy)}`
  );
}
