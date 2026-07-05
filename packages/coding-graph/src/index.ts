/**
 * @remnic/coding-graph — symbol-extraction engine + SQLite knowledge-graph
 * store for codebase memory.
 *
 * À-la-carte optional companion of @remnic/core (CLAUDE.md rule 57).
 *
 * This package unifies two PR1 surfaces:
 *   - The web-tree-sitter engine scaffold (#1551 step 1): the package and
 *     its build wiring exist; the engine public surface is declared and
 *     the placeholder factory throws a tagged
 *     `CodingGraphError("not_implemented", …)`. The real backend lands in
 *     #1551 PR2.
 *   - The SQLite knowledge-graph store (#1552 PR1): versioned schema + the
 *     write pipeline (upsert/drop file batches, node-id derivation,
 *     dangling-edge accounting). Traversal, search, dead-code, and the
 *     openCypher subset land in #1552 PR2/PR3.
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
 *
 *   The store modules (graph-schema, graph-store, row-types) are local to
 *   this package; they import `openBetterSqlite3` from
 *   `@remnic/core/runtime/better-sqlite` so the native-binding lifecycle
 *   is paid for once there (rule 23/38: do not invent a new pattern).
 *
 * IR-type re-export policy:
 *   graph-store.ts imports the core IR contract types (`FileIR`,
 *   `SymbolIR`, etc.) from `@remnic/core/coding/coding-graph-types`
 *   and re-exports them so existing `import { type FileIR } from
 *   "./graph-store.js"` call-sites continue to resolve. The store
 *   does NOT redefine these types — it derives from the core contract
 *   so PR2 callers can pass `ParseResult.ir` directly
 *   (chatgpt-codex-connector P2: 'Derive store FileIR from the core
 *   parser contract'). At the package root, `FileIR`/`SymbolIR`
 *   resolve to the @remnic/core contract types re-exported below;
 *   the store-specific `StoreFileIR` (FileIR + edges extension) and
 *   `EdgeIR` are re-exported from the root via graph-store.
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

// ---------------------------------------------------------------------------
// SQLite knowledge-graph store (#1552 PR1 + PR2): versioned schema, write
// pipeline, and PR2 read primitives (traverse / searchGraph / schemaStats /
// deadCode / snippetFor). Re-exported from the package root so consumers
// can import `import { GraphStore } from "@remnic/coding-graph"` (the
// subpath exports `./graph-schema` and `./graph-store` remain available
// for callers that want only one half). Only non-colliding store types
// are re-exported here — see the file header's IR-type policy note.
// ---------------------------------------------------------------------------

export {
  CODING_GRAPH_SCHEMA_VERSION,
  EDGE_PROVENANCE_VALUES,
  applyCodingGraphSchema,
  readSchemaVersion,
  isEdgeProvenance,
  type EdgeProvenance,
} from "./graph-schema.js";

export {
  GraphStore,
  nodeIdFor,
  DEAD_CODE_EXCLUSION,
  type ByteSpan,
  type DeadCodeHit,
  type DeadCodeResult,
  type EdgeIR,
  type ExportIR,
  type GraphStoreFailure,
  type GraphStoreFailureCode,
  type GraphStoreOptions,
  type ImportIR,
  type NodeIdInput,
  type SchemaStats,
  type SchemaStatsResult,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type SnippetFailureCode,
  type SnippetQuery,
  type SnippetResult,
  type SnippetSuccess,
  type StoreFileIR,
  type SymbolKind,
  type TraverseDirection,
  type TraverseHit,
  type TraverseQuery,
  type TraverseResult,
  type ReadCoChangeEdge,
  type ReadCoChangesResult,
  type ReadFileHashesResult,
  type ReadMetaResult,
  type UpsertBatchResult,
  type UpsertResult,
  type UpsertSuccess,
} from "./graph-store.js";
// ---------------------------------------------------------------------------
// PR3 (issue #1553): incremental git-based reindex, detect_changes + blast
// radius, co-change mining, and index-status reporting. Re-exported from
// the package root so consumers can import them alongside the store.
// ---------------------------------------------------------------------------

export {
  planReindex,
  executeReindex,
  readLastIndexedHead,
  readFileHashes,
  hashContent,
  META_KEY_LAST_HEAD,
  META_KEY_PENDING_PARSE_FAILURES,
  type ParseFileFn,
  type ReadFileFn,
  type ReindexGitFacts,
  type ReindexPlan,
  type ReindexResult,
  type ReindexState,
} from "./reindex.js";

export {
  classifyRisk,
  computeBlastRadius,
  findDirectlyAffectedSymbols,
  byteSpanToLines,
  rangesOverlap,
  BLAST_RADIUS_EDGE_TYPES,
  FAN_IN_ESCALATION_THRESHOLD,
  DEFAULT_BLAST_RADIUS_DEPTH,
  type AffectedSymbol,
  type BlastRadiusResult,
  type DetectChangesResult,
  type RiskLevel,
} from "./detect-changes.js";

export {
  mineCoChangeEdges,
  mineAndStoreCoChanges,
  DEFAULT_CO_CHANGE_CONFIG,
  type CoChangeConfig,
  type CoChangeEdge,
  type MineCoChangesResult,
} from "./co-change.js";

export {
  getIndexStatus,
  type IndexStatus,
  type IndexStatusMode,
} from "./index-status.js";

export {
  defaultCodingGitInvoker,
  parseNameStatus,
  parseHunks,
  parseLogFiles,
  type CodingGitInvoker,
  type DiffHunk,
  type GitFailure,
  type LogFilesEntry,
  type NameStatusEntry,
} from "./git-invoker.js";
