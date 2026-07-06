/**
 * Config parsing for the chat feature (issue #1583).
 *
 * Kept in a dedicated module so config.ts gains only an import + one call
 * site — the god-file ratchet (#1520) tracks config.ts LOC.
 */

import type { ChatConfig } from "../types.js";
import { coerceNumber } from "../connectors/coerce.js";

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  enabled: false,
  model: "",
  maxToolCallsPerTurn: 8,
  sessionTtlHours: 72,
};

/**
 * Coerce a positive-integer config value, accepting numeric strings written
 * via CLI `key=value` paths (rule 28 — coerce at the boundary). Falls back to
 * the default for missing/unparseable values, matching the existing
 * silent-default semantics of this parser.
 */
function positiveInt(value: unknown, fallback: number): number {
  const n = coerceNumber(value);
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Parse the `chat` config section from the raw config object.
 *
 * ```
 * "chat": {
 *   "enabled": true,
 *   "model": "ollama/llama3",
 *   "maxToolCallsPerTurn": 8,
 *   "sessionTtlHours": 72
 * }
 * ```
 *
 * Missing fields default to {@link DEFAULT_CHAT_CONFIG} (rule 48 — explicit
 * opt-in; `enabled` defaults to `false`).
 */
export function parseChatConfig(
  raw: unknown,
): ChatConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_CHAT_CONFIG };
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: obj.enabled === true || obj.enabled === "true" || obj.enabled === "1",
    model: typeof obj.model === "string" ? obj.model : "",
    maxToolCallsPerTurn: positiveInt(obj.maxToolCallsPerTurn, DEFAULT_CHAT_CONFIG.maxToolCallsPerTurn),
    sessionTtlHours: positiveInt(obj.sessionTtlHours, DEFAULT_CHAT_CONFIG.sessionTtlHours),
  };
}
