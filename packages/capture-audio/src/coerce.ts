/**
 * Config-layer coercion. Every helper THROWS on an unrecognized value
 * (never silently defaults — rule 39); callers apply defaults only when a
 * field is absent. Boolean-ish strings coerce per the shared connector
 * convention (rule 24/36): true/1/yes/on and false/0/no/off.
 */

import { CaptureConfigError } from "./errors.js";
import { describeValue } from "./util.js";

const BOOL_TOKENS: Record<string, boolean> = {
  true: true,
  "1": true,
  yes: true,
  on: true,
  false: false,
  "0": false,
  no: false,
  off: false,
};

export function coerceBool(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (Object.hasOwn(BOOL_TOKENS, token)) return BOOL_TOKENS[token];
  }
  throw new CaptureConfigError(
    `${label}: expected a boolean (true/false/1/0/yes/no/on/off), got ${describeValue(value)}`,
  );
}

export interface NumberBounds {
  min?: number;
  max?: number;
  integer?: boolean;
}

export function coerceNumber(value: unknown, label: string, bounds: NumberBounds = {}): number {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    n = Number(value);
  } else {
    throw new CaptureConfigError(`${label}: expected a number, got ${describeValue(value)}`);
  }
  if (!Number.isFinite(n)) {
    throw new CaptureConfigError(`${label}: '${String(value)}' is not a finite number`);
  }
  if (bounds.integer && !Number.isInteger(n)) {
    throw new CaptureConfigError(`${label}: expected an integer, got ${n}`);
  }
  if (bounds.min !== undefined && n < bounds.min) {
    throw new CaptureConfigError(`${label}: must be >= ${bounds.min}, got ${n}`);
  }
  if (bounds.max !== undefined && n > bounds.max) {
    throw new CaptureConfigError(`${label}: must be <= ${bounds.max}, got ${n}`);
  }
  return n;
}
