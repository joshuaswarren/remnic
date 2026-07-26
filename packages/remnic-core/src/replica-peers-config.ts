/**
 * `replicaPeers` config surface (issue #2149) — types + parser.
 *
 * Deliberately split out of replica-divergence.ts as a LIGHT module: it imports
 * no heavy modules (no corpus-watermark, no access-token-capabilities). PluginConfig
 * carries `replicaPeers: ReplicaPeersConfig`, so types.ts imports ReplicaPeersConfig
 * from HERE. If that type instead lived in replica-divergence.ts (which pulls in the
 * corpus census graph), then types.ts -> replica-divergence.ts -> corpus-watermark.ts
 * -> types.ts would form a heavy import cycle that rollup-plugin-dts re-expands across
 * every PluginConfig-inlining entry, OOMing the default-heap DTS worker (the issue
 * #1562 heap cliff). Keeping the config surface corpus-free severs that cycle.
 */

import { coerceBool, coerceNumber } from "./connectors/coerce.js";
import { isAgentAccessSecretRef } from "./resolve-auth-token.js";
import type { AgentAccessAuthToken } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 min
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FILE_COUNT_DELTA = 100;
const DEFAULT_MAX_WATERMARK_AGE_DELTA_MS = 900_000; // 15 min
/** Node clamps a `setTimeout`/`AbortSignal.timeout` delay above 2^31-1 ms to 1ms,
 *  which would make `withDeadline` fire immediately and mark every peer unreachable. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ReplicaPeerConfig {
  /** Base URL of the peer's agent-access HTTP server (http/https). */
  url: string;
  /**
   * Bearer token for the peer's authenticated `/health`. A literal string
   * (env-expanded) or an unresolved SecretRef preserved verbatim and resolved
   * at poll time — mirrors `agentAccessHttp.authToken` exactly.
   */
  token?: AgentAccessAuthToken;
}

export interface ReplicaPeersConfig {
  /** Master gate. Default false — a daemon with no peers behaves exactly as before. */
  enabled: boolean;
  /** Peers to poll. Default []. */
  peers: ReplicaPeerConfig[];
  /** How often a peer is re-polled (SWR TTL), ms. Default 5 min. */
  pollIntervalMs: number;
  /** Per-peer request timeout, ms. Default 10s. */
  requestTimeoutMs: number;
  /** File-count delta (per namespace) beyond which a peer is flagged diverged. Default 100. */
  maxFileCountDelta: number;
  /** Newest-write timestamp gap (per namespace) beyond which a peer is flagged diverged, ms. Default 15 min. */
  maxWatermarkAgeDeltaMs: number;
}

/**
 * Expand `${ENV_VAR}` placeholders in a config string, matching config.ts's
 * `resolveEnvVars` semantics (throw on unset var / malformed placeholder).
 * Inlined rather than imported because config.ts imports THIS module for
 * `parseReplicaPeersConfig`, so importing back would be circular — the same
 * reason extraction-liveness.ts inlines its numeric validation.
 */
function expandEnvValue(value: string): string {
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const envValue = process.env[name];
    if (envValue === undefined || envValue === "") {
      throw new Error(`replicaPeers: environment variable ${name} is not set`);
    }
    return envValue;
  });
  // An UNTERMINATED `${NAME` matches neither the replacement regex nor the
  // balanced leftover check below, so the literal typo would be sent as the
  // bearer token and surface as a misleading `http_401` (round 8, codex P2).
  const unterminated = resolved.match(/\$\{[^}]*$/);
  if (unterminated) {
    throw new Error(`replicaPeers: unterminated environment variable placeholder: ${unterminated[0]}`);
  }
  const remaining = resolved.match(/\$\{[^}]*\}/);
  if (remaining) {
    throw new Error(`replicaPeers: malformed environment variable placeholder: ${remaining[0]}`);
  }
  return resolved;
}

/**
 * An absent key falls back to the default; any PRESENT value (including an
 * explicit `null`) must coerce to an integer `>= min`, else THROW. A fractional
 * or out-of-range value is rejected, never floored/reinterpreted (§1/§17/§39).
 */
function parseIntegerAtLeast(value: unknown, min: number, dflt: number, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return dflt;
  const coerced = coerceNumber(value);
  if (coerced === undefined || !Number.isFinite(coerced) || !Number.isInteger(coerced) || coerced < min) {
    throw new Error(`${label} must be an integer greater than or equal to ${min}; got ${JSON.stringify(value)}`);
  }
  if (coerced > max) {
    throw new Error(`${label} must be an integer no greater than ${max}; got ${JSON.stringify(value)}`);
  }
  return coerced;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseReplicaPeerToken(raw: unknown, index: number): AgentAccessAuthToken | undefined {
  // Only an OMITTED token selects unauthenticated polling. A present `null` (round
  // 4, codex P2) or an explicit empty/whitespace string (round 6, codex P2) is a
  // present-but-invalid credential: silently dropping it polls without the token
  // and surfaces a healthy peer as `http_401`, hiding the real config error.
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new Error(`replicaPeers.peers[${index}].token must be a non-empty string or a SecretRef object`);
    }
    // Re-validate AFTER expansion: `${PEER_TOKEN}` pointing at a whitespace-only
    // env value clears the check above, then resolveAgentAccessAuthToken
    // normalizes it to undefined — silently downgrading an explicitly
    // authenticated peer to an unauthenticated poll read as http_401 (round 9).
    const expanded = expandEnvValue(trimmed);
    if (expanded.trim().length === 0) {
      throw new Error(`replicaPeers.peers[${index}].token expanded to an empty value`);
    }
    return expanded;
  }
  if (isAgentAccessSecretRef(raw)) return raw;
  throw new Error(`replicaPeers.peers[${index}].token must be a string or a SecretRef object`);
}

function parseReplicaPeer(value: unknown, index: number): ReplicaPeerConfig {
  const record = asRecord(value, `replicaPeers.peers[${index}]`);
  if (typeof record.url !== "string" || record.url.trim().length === 0) {
    throw new Error(`replicaPeers.peers[${index}].url must be a non-empty string`);
  }
  const url = expandEnvValue(record.url.trim());
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`replicaPeers.peers[${index}].url is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`replicaPeers.peers[${index}].url must be an http(s) URL (got ${parsed.protocol})`);
  }
  // The health path is appended to this base by string concatenation, so a query
  // or fragment would corrupt the request URL (`https://h?x` + `/engram/v1/health`
  // targets `/` with a mangled query; a fragment drops the path). Reject them at
  // parse time — a peer URL must be a clean base (round 6, codex). Embedded
  // credentials (`user:pass@host`) are rejected too: Node's fetch refuses to
  // construct a request from a URL with credentials, so a healthy peer would
  // falsely read as unreachable while redaction hid the config mistake.
  if (parsed.search.length > 0 || parsed.hash.length > 0 || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`replicaPeers.peers[${index}].url must be a clean base URL (no query, fragment, or embedded credentials)`);
  }
  const token = parseReplicaPeerToken(record.token, index);
  return token === undefined ? { url } : { url, token };
}

/**
 * Parse the `replicaPeers` config block. Mirrors the nested-block validation of
 * the other config-block parsers; coerces string booleans (§24) and rejects
 * invalid numbers/urls/shapes (§1/§39).
 */
/**
 * Strict boolean for the parse path: absent -> the default, present -> must be
 * a recognized boolean token. A value like `1` must NOT silently reinterpret as
 * `false`, which would leave monitoring off after an operator tried to enable
 * it (round 3, codex P2). The lenient read-boundary resolver still defaults.
 */
function parseStrictBool(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(`${label} must be a boolean (got ${JSON.stringify(value)})`);
  }
  return coerced;
}

export function parseReplicaPeersConfig(cfg: Record<string, unknown>): ReplicaPeersConfig {
  const raw = cfg.replicaPeers;
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(`replicaPeers must be a plain object (got ${JSON.stringify(raw)})`);
  }
  const block = (raw ?? {}) as Record<string, unknown>;
  if (block.peers !== undefined && !Array.isArray(block.peers)) {
    throw new Error(`replicaPeers.peers must be an array (got ${JSON.stringify(block.peers)})`);
  }
  const peers = (block.peers ?? []).map(parseReplicaPeer);
  return {
    enabled: parseStrictBool(block.enabled, false, "replicaPeers.enabled"),
    peers,
    pollIntervalMs: parseIntegerAtLeast(block.pollIntervalMs, 1, DEFAULT_POLL_INTERVAL_MS, "replicaPeers.pollIntervalMs"),
    requestTimeoutMs: parseIntegerAtLeast(block.requestTimeoutMs, 1, DEFAULT_REQUEST_TIMEOUT_MS, "replicaPeers.requestTimeoutMs", MAX_TIMER_DELAY_MS),
    maxFileCountDelta: parseIntegerAtLeast(block.maxFileCountDelta, 0, DEFAULT_MAX_FILE_COUNT_DELTA, "replicaPeers.maxFileCountDelta"),
    maxWatermarkAgeDeltaMs: parseIntegerAtLeast(
      block.maxWatermarkAgeDeltaMs,
      0,
      DEFAULT_MAX_WATERMARK_AGE_DELTA_MS,
      "replicaPeers.maxWatermarkAgeDeltaMs",
    ),
  };
}

/**
 * READ-boundary resolver (mirrors `resolveExtractionLivenessConfig`, issue #2155).
 * `parseConfig` always populates `replicaPeers`, but a host adapter, an older
 * persisted config, or a hand-built `PluginConfig` can hand a READ surface
 * (/health, doctor) an absent, partial, or loosely-typed block. Every replica
 * surface must degrade to the documented default (disabled, no peers, no polling)
 * rather than throw — `/health` must stay answerable. Unlike the strict parser, a
 * present-but-invalid field falls back to its default here instead of throwing, and
 * a malformed peer entry is dropped rather than aborting the whole block.
 */
export function resolveReplicaPeersConfig(block: unknown): ReplicaPeersConfig {
  const record =
    block !== null && typeof block === "object" && !Array.isArray(block) ? (block as Record<string, unknown>) : {};
  return {
    enabled: coerceBool(record.enabled) ?? false,
    peers: resolveReplicaPeers(record.peers),
    pollIntervalMs: resolveIntegerAtLeast(record.pollIntervalMs, 1, DEFAULT_POLL_INTERVAL_MS),
    requestTimeoutMs: resolveIntegerAtLeast(record.requestTimeoutMs, 1, DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMER_DELAY_MS),
    maxFileCountDelta: resolveIntegerAtLeast(record.maxFileCountDelta, 0, DEFAULT_MAX_FILE_COUNT_DELTA),
    maxWatermarkAgeDeltaMs: resolveIntegerAtLeast(record.maxWatermarkAgeDeltaMs, 0, DEFAULT_MAX_WATERMARK_AGE_DELTA_MS),
  };
}

/** Lenient sibling of {@link parseIntegerAtLeast}: a present-but-invalid value falls back, never throws. */
function resolveIntegerAtLeast(value: unknown, min: number, dflt: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return dflt;
  const coerced = coerceNumber(value);
  return coerced !== undefined && Number.isFinite(coerced) && Number.isInteger(coerced) && coerced >= min && coerced <= max ? coerced : dflt;
}

/** Lenient peer list: a non-array is empty; a malformed entry is dropped, never thrown (read boundary). */
function resolveReplicaPeers(value: unknown): ReplicaPeerConfig[] {
  if (!Array.isArray(value)) return [];
  const peers: ReplicaPeerConfig[] = [];
  value.forEach((entry, index) => {
    try {
      peers.push(parseReplicaPeer(entry, index));
    } catch {
      // Read surfaces never throw on a bad peer — parseConfig is the enforcing boundary.
    }
  });
  return peers;
}
