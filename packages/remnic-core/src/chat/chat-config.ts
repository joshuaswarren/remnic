/**
 * Config parsing for the chat feature (issue #1583).
 *
 * Kept in a dedicated module so config.ts gains only an import + one call
 * site — the god-file ratchet (#1520) tracks config.ts LOC.
 */

import type { ChatConfig } from "../types.js";

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  enabled: false,
  model: "",
  maxToolCallsPerTurn: 8,
  sessionTtlHours: 72,
};

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
    enabled: obj.enabled === true,
    model: typeof obj.model === "string" ? obj.model : "",
    maxToolCallsPerTurn:
      typeof obj.maxToolCallsPerTurn === "number" &&
      Number.isFinite(obj.maxToolCallsPerTurn) &&
      obj.maxToolCallsPerTurn > 0 &&
      Number.isInteger(obj.maxToolCallsPerTurn)
        ? obj.maxToolCallsPerTurn
        : DEFAULT_CHAT_CONFIG.maxToolCallsPerTurn,
    sessionTtlHours:
      typeof obj.sessionTtlHours === "number" &&
      Number.isFinite(obj.sessionTtlHours) &&
      obj.sessionTtlHours > 0 &&
      Number.isInteger(obj.sessionTtlHours)
        ? obj.sessionTtlHours
        : DEFAULT_CHAT_CONFIG.sessionTtlHours,
  };
}
