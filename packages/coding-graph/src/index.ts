/**
 * @remnic/coding-graph — symbol-extraction engine for codebase memory.
 *
 * À-la-carte optional companion of @remnic/core (CLAUDE.md rule 57).
 *
 * PR1 (#1551, step 1): the package and its build wiring exist. The engine
 * public surface is declared and the placeholder factory throws a tagged
 * `CodingGraphError("not_implemented", …)`. The real backend (web-tree-
 * sitter, per-language extractors, grammar manager) lands in PR2.
 *
 * Type-source direction:
 *   The contract types (CodingGraphEngine, FileIR, etc.) and the
 *   TIER_1_LANGUAGES / CODING_GRAPH_ENGINE_VERSION constants live in
 *   @remnic/core (packages/remnic-core/src/coding/coding-graph-types.ts,
 *   re-exported from the main index). This package imports them and
 *   implements against them; it does NOT redefine them. That keeps a
 *   single source of truth so updating the engine version in one place
 *   keeps every consumer in lockstep (Cursor Bugbot low-severity on
 *   PR #1588 round 2: "ENGINE_VERSION duplicated not imported").
 *
 *   @remnic/coding-graph declares @remnic/core as both `peerDependencies`
 *   and `devDependencies: "workspace:*"` in its package.json, so the
 *   pnpm workspace link exists and the `import from "@remnic/core"`
 *   below resolves in development.
 */

import {
  CODING_GRAPH_ENGINE_VERSION,
  TIER_1_LANGUAGES,
  type CodingGraphEngine,
  type CodingGraphErrorCode,
  type CodingGraphLanguage,
  type CreateCodingGraphEngineOptions,
  type FileIR,
  type ParseFileInput,
  type ParseResult,
  type SymbolIR,
} from "@remnic/core";

// ---------------------------------------------------------------------------
// Engine version — single source of truth lives in @remnic/core as
// `CODING_GRAPH_ENGINE_VERSION`. We re-export it under the conventional
// `ENGINE_VERSION` name (the dynamic-import loader in @remnic/core
// validates the shape using this field name) AND keep the core alias
// available so any consumer that wants the local name or the core
// name gets the same value. Updating the constant in core propagates
// here automatically.
// ---------------------------------------------------------------------------

/** Public engine version. Imported from @remnic/core (single source of truth). */
export const ENGINE_VERSION = CODING_GRAPH_ENGINE_VERSION;

/** Core-alias re-export so callers can use either name. */
export { CODING_GRAPH_ENGINE_VERSION };

// ---------------------------------------------------------------------------
// Tier-1 language list re-export. The list itself lives in @remnic/core
// (single source of truth) so consumers that reach the optional package
// via the loader get the same shape they would get from core directly.
// ---------------------------------------------------------------------------
export { TIER_1_LANGUAGES };
export type { CodingGraphLanguage };

// ---------------------------------------------------------------------------
// Tagged error — `code` is the load-bearing signal for programmatic
// detection (see PR2 contract).
// ---------------------------------------------------------------------------

export type { CodingGraphErrorCode } from "@remnic/core";

/**
 * Thrown by `createCodingGraphEngine` while the real implementation is
 * being landed. It is *not* a generic Error — the `code` field is the
 * load-bearing signal for programmatic detection (see PR2 contract).
 */
export class CodingGraphError extends Error {
  readonly code: CodingGraphErrorCode;
  readonly engineVersion: string;

  constructor(
    code: CodingGraphErrorCode,
    message: string,
    engineVersion: string = ENGINE_VERSION,
  ) {
    super(message);
    this.name = "CodingGraphError";
    this.code = code;
    this.engineVersion = engineVersion;
  }
}

// ---------------------------------------------------------------------------
// Engine implementation for PR1 (placeholder — PR2 fills extractors).
// ---------------------------------------------------------------------------

/**
 * Construct an engine. PR1 implementation: always throws
 * `CodingGraphError("not_implemented", …)` after stamping the engine
 * version onto the error so callers can advertise their expected engine
 * in failure logs. PR2 will return a fully wired `CodingGraphEngine`.
 *
 * The error type is public so consumers can pattern-match on `.code`
 * without parsing the message.
 */
export function createCodingGraphEngine(
  _options: CreateCodingGraphEngineOptions = {},
): CodingGraphEngine {
  throw new CodingGraphError(
    "not_implemented",
    "createCodingGraphEngine() is a PR1 scaffold placeholder. " +
      "The web-tree-sitter backend, grammar manager, and per-language " +
      "extractors land in PR2 (#1551). Engine version requested: " +
      `${ENGINE_VERSION}.`,
  );
}

// ---------------------------------------------------------------------------
// Re-export the contract types so the public surface is stable whether a
// consumer reaches into @remnic/coding-graph or @remnic/core. `export type`
// guarantees these are erased at runtime — no double-emit.
// ---------------------------------------------------------------------------

export type {
  CodingGraphEngine,
  CreateCodingGraphEngineOptions,
  FileIR,
  ParseFileInput,
  ParseResult,
  SymbolIR,
};
