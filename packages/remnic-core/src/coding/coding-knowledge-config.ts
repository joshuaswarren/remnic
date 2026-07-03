/**
 * Track A (issue #1548 PR 1) — parse the `codingKnowledge` config block.
 *
 * Lives in `coding/` (not in `config.ts`) so adding a feature config block
 * does not grow the watchlisted `config.ts` past its ratchet baseline. The
 * function is a pure helper: it reads from the raw `cfg.codingKnowledge`
 * sub-object, applies defaults from `CODING_KNOWLEDGE_DEFAULTS`, validates
 * the structural-provider enum, and returns the populated
 * `CodingKnowledgeConfig`.
 *
 * Parse rules (CLAUDE.md gotcha 36, rule 30, rule 48):
 *  - booleans are coerced at the parse boundary so CLI strings like
 *    `--config codingKnowledge.enabled=false` arrive as `false`, not truthy.
 *  - unknown structural-provider values are rejected listing the valid
 *    options (rule 51 — silent defaulting is a contract lie).
 *  - `structuralProvider` defaults to `"none"` (rule 48 — least-privileged:
 *    spawning subprocesses is an explicit operator choice).
 *
 * Env overrides follow the REMNIC_* + ENGRAM_* fallback already used elsewhere
 * in `config.ts` (#1427 family). Each individual switch is `codingKnowledge.*` —
 * the existing `ENGRAM_*` env vars from earlier releases do not pair them up.
 */

import type { CodingKnowledgeConfig } from "../types.js";
import { coerceBool } from "../connectors/coerce.js";

export const CODING_KNOWLEDGE_DEFAULTS = Object.freeze({
  enabled: false,
  decisionRecords: true,
  architectureCard: true,
  sessionDelta: true,
  architectureCardLlmSummary: false,
  structuralProvider: "none",
  structuralProviderCommand: "",
} satisfies Record<keyof CodingKnowledgeConfig, boolean | string>);

const VALID_STRUCTURAL_PROVIDERS = ["none", "subprocess", "native"] as const;
type StructuralProvider = CodingKnowledgeConfig["structuralProvider"];

/**
 * Parse the `codingKnowledge` sub-object into a fully-populated
 * `CodingKnowledgeConfig`. Returns the documented defaults when the
 * sub-object is missing, null, not an object, or has unknown shape.
 *
 * Throws when an explicit `structuralProvider` value is not one of the
 * declared enum values (rule 51 — listing valid options in the error).
 */
export function parseCodingKnowledgeConfig(raw: unknown): CodingKnowledgeConfig {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const structuralProvider = readStructuralProvider(record.structuralProvider);
  return {
    enabled: coerceBool(record.enabled) === true,
    decisionRecords: coerceBool(record.decisionRecords) !== false,
    architectureCard: coerceBool(record.architectureCard) !== false,
    sessionDelta: coerceBool(record.sessionDelta) !== false,
    architectureCardLlmSummary:
      coerceBool(record.architectureCardLlmSummary) === true,
    structuralProvider,
    structuralProviderCommand:
      typeof record.structuralProviderCommand === "string"
        ? record.structuralProviderCommand.trim()
        : "",
  };
}

function readStructuralProvider(raw: unknown): StructuralProvider {
  if (raw === undefined) return "none";
  if (typeof raw !== "string") {
    throw new Error(
      `codingKnowledge.structuralProvider must be a string (` +
        `${VALID_STRUCTURAL_PROVIDERS.join(", ")}); got ${JSON.stringify(raw)}.`,
    );
  }
  if (raw === "none" || raw === "subprocess" || raw === "native") return raw;
  throw new Error(
    `codingKnowledge.structuralProvider must be one of ` +
      `${VALID_STRUCTURAL_PROVIDERS.join(", ")}; got ${JSON.stringify(raw)}.`,
  );
}
