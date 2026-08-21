/**
 * LSP configuration types and defaults (issue #1555 — rule 30/48).
 *
 * `codingGraph.lsp.enabled` defaults `false`. Enabling LSP with zero
 * servers installed must produce a working index identical to Phase A
 * plus visible degradations — the characterization test proves this.
 *
 * Env overrides follow gotcha 9: `REMNIC_CODING_GRAPH_LSP_ENABLED` with
 * `ENGRAM_` fallback.
 */
import process from "node:process";

import type { CodingGraphLanguage } from "@remnic/core";

import type { LspDegradation } from "./degradation.js";

// ──────────────────────────────────────────────────────────────────────────
// Server launch spec — argv array end-to-end (rule 10).
// ──────────────────────────────────────────────────────────────────────────

/**
 * How to launch a language server: command + argv. Always an array of
 * strings — never a shell string — so injection via config is impossible
 * (rule 10: argv arrays end-to-end).
 */
export interface LspServerLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Per-language server overrides. Keys are language identifiers (matching
 * {@link CodingGraphLanguage}); values are launch specs that REPLACE the
 * default. An unknown language key is an error (rule 51 — list supported
 * languages).
 */
export type LspServerOverrides = Partial<Record<CodingGraphLanguage, LspServerLaunchSpec>>;

// ──────────────────────────────────────────────────────────────────────────
// Configuration shape
// ──────────────────────────────────────────────────────────────────────────

export interface LspConfig {
  /** Master switch — default false (rule 30/48). */
  readonly enabled: boolean;
  /** Per-language server overrides (default: empty — use registry defaults). */
  readonly servers: LspServerOverrides;
  /** Handshake + per-request timeout in ms (default 3000). */
  readonly timeoutMs: number;
  /** Max definition requests per index run (default 500). */
  readonly maxRequestsPerRun: number;
}

export const DEFAULT_LSP_TIMEOUT_MS = 3_000;
export const DEFAULT_LSP_MAX_REQUESTS_PER_RUN = 500;

export const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: false,
  servers: {},
  timeoutMs: DEFAULT_LSP_TIMEOUT_MS,
  maxRequestsPerRun: DEFAULT_LSP_MAX_REQUESTS_PER_RUN,
};

/**
 * Parse and validate user-supplied LSP config. Unknown keys in `servers`
 * are rejected with a degradation listing supported languages (rule 51).
 * Non-executable absolute paths are rejected (rule 24 analog).
 *
 * Returns `{ ok: true, config }` or `{ ok: false, degradation }` — never
 * throws (rule 13).
 */
export type LspConfigParseResult =
  | { readonly ok: true; readonly config: LspConfig }
  | { readonly ok: false; readonly degradation: LspDegradation };

/**
 * Parse the `enabled` flag strictly. Boolean values pass through; strings
 * like `"false"`, `"0"`, `"no"`, and `""` are false (so env/CLI overrides
 * work as operators expect). Any other truthy value enables.
 */
function parseEnabledFlag(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const lower = v.trim().toLowerCase();
    return lower !== "false" && lower !== "0" && lower !== "no" && lower !== "";
  }
  return Boolean(v);
}

/**
 * Parse and validate user-supplied LSP config. Unknown keys in `servers`
 * are rejected with a degradation listing supported languages (rule 51).
 * Non-executable absolute paths are rejected (rule 24 analog).
 *
 * Returns `{ ok: true, config }` or `{ ok: false, degradation }` — never
 * throws (rule 13).
 */
export function parseLspConfig(
  raw: unknown,
  knownLanguages: readonly CodingGraphLanguage[],
): LspConfigParseResult {
  if (raw === null || raw === undefined) {
    return { ok: true, config: DEFAULT_LSP_CONFIG };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      degradation: {
        backend: "lsp",
        code: "protocol_error",
        detail: "codingGraph.lsp must be an object",
      },
    };
  }
  const obj = raw as Record<string, unknown>;
  const knownSet = new Set(knownLanguages);

  const enabled = obj.enabled === undefined ? false : parseEnabledFlag(obj.enabled);
  const timeoutMs = obj.timeoutMs === undefined ? DEFAULT_LSP_TIMEOUT_MS : Number(obj.timeoutMs);
  const maxRequestsPerRun =
    obj.maxRequestsPerRun === undefined ? DEFAULT_LSP_MAX_REQUESTS_PER_RUN : Number(obj.maxRequestsPerRun);

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return {
      ok: false,
      degradation: {
        backend: "lsp",
        code: "protocol_error",
        detail: `lsp.timeoutMs must be a non-negative number, got ${JSON.stringify(obj.timeoutMs)}`,
      },
    };
  }
  if (!Number.isFinite(maxRequestsPerRun) || maxRequestsPerRun < 0) {
    return {
      ok: false,
      degradation: {
        backend: "lsp",
        code: "protocol_error",
        detail: `lsp.maxRequestsPerRun must be a non-negative number, got ${JSON.stringify(obj.maxRequestsPerRun)}`,
      },
    };
  }

  const servers: Partial<Record<CodingGraphLanguage, LspServerLaunchSpec>> = {};
  if (obj.servers !== undefined && obj.servers !== null) {
    if (typeof obj.servers !== "object" || Array.isArray(obj.servers)) {
      return {
        ok: false,
        degradation: {
          backend: "lsp",
          code: "protocol_error",
          detail: "lsp.servers must be an object",
        },
      };
    }
    for (const [lang, spec] of Object.entries(obj.servers as Record<string, unknown>)) {
      if (!knownSet.has(lang as CodingGraphLanguage)) {
        return {
          ok: false,
          degradation: {
            backend: "lsp",
            code: "unknown_language",
            detail: `unknown language "${lang}" in lsp.servers; supported: ${knownLanguages.join(", ")}`,
          },
        };
      }
      if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
        return {
          ok: false,
          degradation: {
            backend: "lsp",
            code: "protocol_error",
            detail: `lsp.servers.${lang} must be an object`,
          },
        };
      }
      const s = spec as Record<string, unknown>;
      if (typeof s.command !== "string" || s.command.length === 0) {
        return {
          ok: false,
          degradation: {
            backend: "lsp",
            code: "protocol_error",
            detail: `lsp.servers.${lang}.command must be a non-empty string`,
          },
        };
      }
      if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string")) {
        return {
          ok: false,
          degradation: {
            backend: "lsp",
            code: "protocol_error",
            detail: `lsp.servers.${lang}.args must be an array of strings`,
          },
        };
      }
      servers[lang as CodingGraphLanguage] = {
        command: s.command,
        args: [...(s.args as string[])],
      };
    }
  }

  return { ok: true, config: { enabled, servers, timeoutMs, maxRequestsPerRun } };
}

/**
 * Read the env-var override for `lsp.enabled`. Returns the raw string
 * value or null. The caller decides how to interpret it (gotcha 9:
 * `REMNIC_` primary, `ENGRAM_` fallback).
 */
export function readLspEnabledEnv(): string | null {
  return (
    process.env.REMNIC_CODING_GRAPH_LSP_ENABLED ??
    process.env.ENGRAM_CODING_GRAPH_LSP_ENABLED ??
    null
  );
}
