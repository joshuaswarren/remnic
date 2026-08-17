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

import type { CodingContext, CodingGraphLspConfig, CodingKnowledgeConfig } from "../types.js";
import { TIER_1_LANGUAGES } from "./coding-graph-types.js";
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
    // `lsp` is spread conditionally so an absent key stays ABSENT — an own
    // `lsp: undefined` property would change the pinned defaults shape
    // (config.test.ts) and leak a new key into serialized configs.
    ...readLspField(record.lsp),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Shared surface gates (rule 39: ONE predicate pair, identical on every
// surface — issue #2478 dedupe). Each Track A surface used to carry its own
// copy of this logic; they all resolve here now. The booleans are already
// strict-coerced by parseCodingKnowledgeConfig, so `=== true` is safe here.
// ──────────────────────────────────────────────────────────────────────────

/** Boolean feature switches governed by the master `codingKnowledge.enabled` gate. */
export type CodingKnowledgeFeatureFlag = "decisionRecords" | "architectureCard" | "sessionDelta";

/**
 * Config-only visibility gate — used by the MCP constructor to decide
 * whether a coding tool is advertised in `tools/list`. True only when the
 * master gate AND the feature switch are both on.
 */
export function isCodingKnowledgeFeatureVisible(
  config: CodingKnowledgeConfig,
  feature: CodingKnowledgeFeatureFlag,
): boolean {
  return config.enabled === true && config[feature] === true;
}

/**
 * Full call-time gate: visibility PLUS an attached coding context
 * (project/branch-scoped session). Handlers check this before dispatch.
 */
export function isCodingKnowledgeFeatureEnabled(
  config: CodingKnowledgeConfig,
  feature: CodingKnowledgeFeatureFlag,
  codingContext: CodingContext | null | undefined,
): boolean {
  return isCodingKnowledgeFeatureVisible(config, feature) && codingContext != null;
}

/**
 * Read the optional `codingKnowledge.lsp` sub-object. Absent → empty
 * spread (no own key). Present-but-malformed (string/number/array) is
 * REJECTED, consistent with `readStrictBool`'s posture — a typo like
 * `"lsp": true` must alert the operator, not silently disable Phase B.
 */
function readLspField(raw: unknown): { lsp?: CodingGraphLspConfig } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `codingKnowledge.lsp must be an object ({ enabled, servers?, timeoutMs?, maxRequestsPerRun? }); got ${JSON.stringify(raw)}`,
    );
  }
  return { lsp: parseLspConfig(raw as Record<string, unknown>) };
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

  // Server overrides are validated STRICTLY (rule 51): a malformed entry
  // or a misspelled language key must not silently fall through to the
  // built-in default server — the operator configured an override for a
  // reason. Keys validate against TIER_1_LANGUAGES (core owns the tier-1
  // list in coding-graph-types.ts, so there is no drift risk).
  const servers: CodingGraphLspConfig["servers"] = {};
  if (raw.servers !== undefined && raw.servers !== null) {
    if (typeof raw.servers !== "object" || Array.isArray(raw.servers)) {
      throw new Error(
        `codingKnowledge.lsp.servers must be an object mapping language ids to { command, args? }; got ${JSON.stringify(raw.servers)}.`,
      );
    }
    for (const [lang, def] of Object.entries(raw.servers as Record<string, unknown>)) {
      if (!(TIER_1_LANGUAGES as readonly string[]).includes(lang)) {
        throw new Error(
          `codingKnowledge.lsp.servers has unknown language key ${JSON.stringify(lang)}; valid keys: ${TIER_1_LANGUAGES.join(", ")}.`,
        );
      }
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        throw new Error(
          `codingKnowledge.lsp.servers.${lang} must be an object ({ command, args? }); got ${JSON.stringify(def)}.`,
        );
      }
      const d = def as Record<string, unknown>;
      if (typeof d.command !== "string" || d.command.trim().length === 0) {
        throw new Error(
          `codingKnowledge.lsp.servers.${lang}.command must be a non-empty string; got ${JSON.stringify(d.command)}.`,
        );
      }
      if (d.args !== undefined && (!Array.isArray(d.args) || !d.args.every((a) => typeof a === "string"))) {
        throw new Error(
          `codingKnowledge.lsp.servers.${lang}.args must be an array of strings; got ${JSON.stringify(d.args)}.`,
        );
      }
      servers[lang] = {
        command: d.command.trim(),
        ...(Array.isArray(d.args) ? { args: d.args as string[] } : {}),
      };
    }
  }

  const timeoutMs = readPositiveInt(raw.timeoutMs, "lsp.timeoutMs", 3_000, 30_000);
  const maxRequestsPerRun = readPositiveInt(raw.maxRequestsPerRun, "lsp.maxRequestsPerRun", 500, 5_000);

  return { enabled: true, ...(Object.keys(servers).length > 0 ? { servers } : {}), timeoutMs, maxRequestsPerRun };
}

/**
 * Strict positive-integer parse for LSP numeric knobs (rule 51 + CLI
 * string parity, pattern 17). `undefined` falls back to the default;
 * strings coerce via Number() (CLI values arrive as strings); anything
 * non-integer, < 1 (0 is NOT a disable value here — set lsp.enabled:false
 * to disable), or > max is REJECTED instead of silently replaced.
 */
function readPositiveInt(value: unknown, keyName: string, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  const coerced = typeof value === "string" && value.trim().length > 0 ? Number(value) : value;
  if (typeof coerced !== "number" || !Number.isFinite(coerced) || !Number.isInteger(coerced) || coerced < 1 || coerced > max) {
    throw new Error(
      `codingKnowledge.${keyName} must be an integer in [1, ${max}]; got ${JSON.stringify(value)}. ` +
        `To disable LSP resolution set codingKnowledge.lsp.enabled to false.`,
    );
  }
  return coerced;
}
