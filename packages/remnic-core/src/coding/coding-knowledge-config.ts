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

import type { CodingKnowledgeConfig, CodingGraphLspConfig } from "../types.js";
import { coerceBool } from "../connectors/coerce.js";

export const CODING_KNOWLEDGE_DEFAULTS = Object.freeze({
  enabled: false,
  decisionRecords: true,
  architectureCard: true,
  sessionDelta: true,
  architectureCardLlmSummary: false,
  structuralProvider: "none",
  structuralProviderCommand: "",
  codegraphTools: false,
  codegraphDbDir: "",
  // `lsp` is excluded: it is an optional structured sub-config (issue #1917)
  // with no flat boolean/string default; the parser returns `undefined` when
  // absent (LSP off — rule 48 explicit opt-in).
} satisfies Record<Exclude<keyof CodingKnowledgeConfig, "lsp">, boolean | string>);

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
    enabled: readStrictBool(record.enabled, "enabled", /* default */ false),
    decisionRecords: readStrictBool(record.decisionRecords, "decisionRecords", /* default */ true),
    architectureCard: readStrictBool(record.architectureCard, "architectureCard", /* default */ true),
    sessionDelta: readStrictBool(record.sessionDelta, "sessionDelta", /* default */ true),
    architectureCardLlmSummary: readStrictBool(record.architectureCardLlmSummary, "architectureCardLlmSummary", /* default */ false),
    structuralProvider,
    structuralProviderCommand:
      typeof record.structuralProviderCommand === "string"
        ? record.structuralProviderCommand.trim()
        : "",
    codegraphTools: readStrictBool(record.codegraphTools, "codegraphTools", /* default */ false),
    codegraphDbDir:
      typeof record.codegraphDbDir === "string"
        ? record.codegraphDbDir.trim()
        : "",
    lsp: record.lsp && typeof record.lsp === "object" && !Array.isArray(record.lsp)
      ? parseLspConfig(record.lsp as Record<string, unknown>)
      : undefined,
  };
}

const STRICT_BOOL_ACCEPTED = "true/false/1/0/yes/no/on/off";

/**
 * Strict boolean parse for feature-gate config values.
 *  - `undefined` falls back to `defaultValue` (the key was simply not
 *    supplied).
 *  - `true`/`false` (native) and the boolean-like strings listed in
 *    `STRICT_BOOL_ACCEPTED` are honored (rule 36 — CLI string parity).
 *  - Any other shape, including misspelled strings like `"flase"`,
 *    numbers outside `{0, 1}`, objects, arrays — is REJECTED with an
 *    error listing the valid inputs (rule 51). Silent defaulting on
 *    malformed operator input is a contract lie.
 */
export function readStrictBool(
  value: unknown,
  keyName: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(
      `codingKnowledge.${keyName} must be a boolean or one of ${STRICT_BOOL_ACCEPTED}; ` +
        `got ${JSON.stringify(value)}.`,
    );
  }
  return coerced;
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

/**
 * Parse the `codingKnowledge.lsp` sub-object (issue #1917). Returns
 * `{ enabled: false }` when absent or malformed — LSP is opt-in.
 */
function parseLspConfig(raw: Record<string, unknown>): CodingGraphLspConfig {
  const enabled = readStrictBool(raw.enabled, "lsp.enabled", false);
  if (!enabled) return { enabled: false };

  const servers: CodingGraphLspConfig["servers"] = {};
  if (raw.servers && typeof raw.servers === "object" && !Array.isArray(raw.servers)) {
    for (const [lang, def] of Object.entries(raw.servers as Record<string, unknown>)) {
      if (def && typeof def === "object" && !Array.isArray(def)) {
        const d = def as Record<string, unknown>;
        if (typeof d.command === "string" && d.command.length > 0) {
          servers[lang] = {
            command: d.command,
            ...(Array.isArray(d.args) ? { args: d.args.filter((a) => typeof a === "string") as string[] } : {}),
          };
        }
      }
    }
  }

  const timeoutMs =
    typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
      ? Math.min(Math.floor(raw.timeoutMs), 30_000)
      : 3_000;
  const maxRequestsPerRun =
    typeof raw.maxRequestsPerRun === "number" && Number.isFinite(raw.maxRequestsPerRun) && raw.maxRequestsPerRun > 0
      ? Math.min(Math.floor(raw.maxRequestsPerRun), 5_000)
      : 500;

  return { enabled: true, ...(Object.keys(servers).length > 0 ? { servers } : {}), timeoutMs, maxRequestsPerRun };
}
