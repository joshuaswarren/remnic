/**
 * Daemon config (`~/.remnic/capture-screen/screen.json`), created by
 * `remnic-capture-screen init`. Strict and loud: an absent field takes the
 * documented default, but a present-but-invalid value throws CaptureConfigError
 * (no silent defaulting). Ports are integers in [1, 65535]; string arrays
 * (deny-lists, terminal-app globs, redaction patterns) reject non-string
 * members.
 *
 * Deny-lists, terminal-app globs, and redaction patterns here are ADDITIVE to
 * the built-in defaults (see denylist.ts / redact.ts / capture.ts).
 */

import { readFileSync } from "node:fs";

import { coerceNumber, coerceStringArray } from "./coerce.js";
import {
  DEFAULT_DEDUP_TTL_SECONDS,
  DEFAULT_HOST,
  DEFAULT_MAX_DWELL_SECONDS,
  DEFAULT_MAX_NODES,
  DEFAULT_PORT,
  DEFAULT_SESSION_GAP_SECONDS,
  DEFAULT_SIMHASH_THRESHOLD,
  DEFAULT_SPOOL_RETENTION_DAYS,
} from "./constants.js";
import { CaptureConfigError } from "./errors.js";
import { describeValue } from "./util.js";

export interface DaemonConfig {
  host: string;
  port: number;
  spoolRetentionDays: number;
  simhashThreshold: number;
  dedupTtlSeconds: number;
  sessionGapSeconds: number;
  maxNodes: number;
  maxDwellSeconds: number;
  /** Additive deny-list globs (checked in addition to the built-in defaults). */
  denyApps: string[];
  denyTitles: string[];
  denyUrls: string[];
  /** Additive terminal-class app globs (route to OCR). */
  terminalApps: string[];
  /** Additive user redaction regex source strings. */
  redactionPatterns: string[];
}

export function defaultDaemonConfig(): DaemonConfig {
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    spoolRetentionDays: DEFAULT_SPOOL_RETENTION_DAYS,
    simhashThreshold: DEFAULT_SIMHASH_THRESHOLD,
    dedupTtlSeconds: DEFAULT_DEDUP_TTL_SECONDS,
    sessionGapSeconds: DEFAULT_SESSION_GAP_SECONDS,
    maxNodes: DEFAULT_MAX_NODES,
    maxDwellSeconds: DEFAULT_MAX_DWELL_SECONDS,
    denyApps: [],
    denyTitles: [],
    denyUrls: [],
    terminalApps: [],
    redactionPatterns: [],
  };
}

const KNOWN_TOP_KEYS: Record<string, true> = {
  host: true,
  port: true,
  spoolRetentionDays: true,
  simhashThreshold: true,
  dedupTtlSeconds: true,
  sessionGapSeconds: true,
  maxNodes: true,
  maxDwellSeconds: true,
  denyApps: true,
  denyTitles: true,
  denyUrls: true,
  terminalApps: true,
  redactionPatterns: true,
};

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CaptureConfigError(`${label}: expected an object, got ${describeValue(value)}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CaptureConfigError(`${label}: expected a non-empty string, got ${describeValue(value)}`);
  }
  return value.trim();
}

export function parseDaemonConfig(raw: unknown): DaemonConfig {
  const cfg = defaultDaemonConfig();
  const obj = asObject(raw, "config");
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(KNOWN_TOP_KEYS, key)) {
      console.warn(`remnic-capture-screen: config: ignoring unknown key '${key}'`);
    }
  }

  if (obj.host !== undefined) cfg.host = requireString(obj.host, "host");
  if (obj.port !== undefined) cfg.port = coerceNumber(obj.port, "port", { integer: true, min: 1, max: 65535 });
  if (obj.spoolRetentionDays !== undefined) {
    cfg.spoolRetentionDays = coerceNumber(obj.spoolRetentionDays, "spoolRetentionDays", { integer: true, min: 1 });
  }
  if (obj.simhashThreshold !== undefined) {
    cfg.simhashThreshold = coerceNumber(obj.simhashThreshold, "simhashThreshold", { integer: true, min: 0, max: 64 });
  }
  if (obj.dedupTtlSeconds !== undefined) {
    cfg.dedupTtlSeconds = coerceNumber(obj.dedupTtlSeconds, "dedupTtlSeconds", { min: 0 });
  }
  if (obj.sessionGapSeconds !== undefined) {
    cfg.sessionGapSeconds = coerceNumber(obj.sessionGapSeconds, "sessionGapSeconds", { min: 0 });
  }
  if (obj.maxNodes !== undefined) {
    cfg.maxNodes = coerceNumber(obj.maxNodes, "maxNodes", { integer: true, min: 1 });
  }
  if (obj.maxDwellSeconds !== undefined) {
    cfg.maxDwellSeconds = coerceNumber(obj.maxDwellSeconds, "maxDwellSeconds", { min: 1 });
  }
  if (obj.denyApps !== undefined) cfg.denyApps = coerceStringArray(obj.denyApps, "denyApps");
  if (obj.denyTitles !== undefined) cfg.denyTitles = coerceStringArray(obj.denyTitles, "denyTitles");
  if (obj.denyUrls !== undefined) cfg.denyUrls = coerceStringArray(obj.denyUrls, "denyUrls");
  if (obj.terminalApps !== undefined) cfg.terminalApps = coerceStringArray(obj.terminalApps, "terminalApps");
  if (obj.redactionPatterns !== undefined) {
    cfg.redactionPatterns = coerceStringArray(obj.redactionPatterns, "redactionPatterns");
  }

  return cfg;
}

export function loadDaemonConfig(configPath: string): DaemonConfig {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    throw new CaptureConfigError(`config not found at ${configPath} — run \`remnic-capture-screen init\` first`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CaptureConfigError(`config at ${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  return parseDaemonConfig(raw);
}

export function serializeDaemonConfig(cfg: DaemonConfig): string {
  return `${JSON.stringify(cfg, null, 2)}\n`;
}
