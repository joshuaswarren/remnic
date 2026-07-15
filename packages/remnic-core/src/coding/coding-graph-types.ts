// Engine contract types for the optional @remnic/coding-graph package.
//
// These types are owned by @remnic/core so the base install compiles even
// when @remnic/coding-graph is not present (it is an optional peer dep —
// installed only on host machines that opt in to codebase-graph features).
//
// @remnic/coding-graph imports these types and implements them; it does
// not redefine them. This breaks the type-source-direction cycle that
// would otherwise require core to import coding-graph at compile time
// (core's tsup DTS phase emits declarations against the package's
// compiled output, which would fail when the optional package is not
// installed in CI's base install).
//
// Dependency direction:
//
//     @remnic/core  ──── owns ───►  CodingGraphEngine (this file)
//         ▲
//         │ peer + devDep (workspace)
//         │
//     @remnic/coding-graph (implements against these types)
//
// Per #1551 PR1 — these are the full contract surface. PR2 fills the
// extractors; PR3+ lands the walker, determinism, and grammarDir
// behaviour behind the same `parseFile()` entry point.

// ---------------------------------------------------------------------------
// Version constant — surfaced through the engine instance so consumers can
// advertise what they expect. Bumped in lockstep with the package version
// during active development.
// ---------------------------------------------------------------------------
export const CODING_GRAPH_ENGINE_VERSION = "0.1.0-pr1" as const;

// ---------------------------------------------------------------------------
// Tier-1 language list — declared here so consumers can drive their own
// tools against the engine without touching the optional package. Order is
// stable; per-language configuration is the engine's concern.
// ---------------------------------------------------------------------------
export const TIER_1_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "kotlin",
  "swift",
  "bash",
] as const;

export type CodingGraphLanguage = (typeof TIER_1_LANGUAGES)[number];

// ---------------------------------------------------------------------------
// Tagged error code — the load-bearing signal for programmatic detection of
// placeholder / install / load failure states. New codes must be added here
// so consumers see them via TypeScript.
// ---------------------------------------------------------------------------
export type CodingGraphErrorCode =
  | "not_implemented"
  | "module_load_failed";

// ---------------------------------------------------------------------------
// Engine interface — the contract coding-graph implements against.
// ---------------------------------------------------------------------------
export interface CodingGraphEngine {
  /** Engine version reported at construction time. */
  readonly engineVersion: string;
  /** Tier-1 languages this build supports (PR2 narrows by grammar availability). */
  readonly supportedLanguages: readonly CodingGraphLanguage[];
  /**
   * Parse a single source file and emit its FileIR.
   *
   * PR1 throws `CodingGraphError("not_implemented", …)`. PR2 will return
   * `ParseResult`; failure paths come back as
   * `{ ok: false, code: "parse_failed", path, message }` (rule 44) rather
   * than partial / silent IR.
   */
  parseFile(input: ParseFileInput): Promise<ParseResult>;
  /** Engine lifecycle — release any cached parsers/grammars. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Parse input/output
// ---------------------------------------------------------------------------
export interface ParseFileInput {
  /** Repository-relative path (forward slashes; no leading `./`). */
  readonly path: string;
  /** Raw file bytes; hashing happens inside the engine (rule 23). */
  readonly content: Uint8Array;
  /**
   * Optional override. When omitted the engine sniffs the language from
   * `path` extensions against its built-in tier-1 list (PR2).
   */
  readonly language?: CodingGraphLanguage;
}

export type ParseResult =
  | { readonly ok: true; readonly ir: FileIR }
  | {
      readonly ok: false;
      readonly code: "parse_failed";
      readonly path: string;
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// FileIR — the seam between the parser (optional package) and the graph
// store (sibling issue #1552). Field types are the minimal viable set per
// the issue's design section.
// ---------------------------------------------------------------------------
export interface FileIR {
  readonly path: string;
  readonly language: CodingGraphLanguage;
  /** SHA-256 of the raw bytes; rule 23 — every consumer hashes the same form. */
  readonly contentHash: string;
  readonly symbols: readonly SymbolIR[];
  readonly imports: readonly ImportIR[];
  readonly exports: readonly ExportIR[];
  readonly callSites: readonly CallSiteIR[];
  readonly routes: readonly RouteIR[];
}

export interface SymbolIR {
  readonly kind:
    | "function"
    | "class"
    | "method"
    | "interface"
    | "enum"
    | "type"
    | "module";
  readonly name: string;
  readonly qualifiedName: string;
  /** Half-open byte span `[startByte, endByte)`. Rule 35. */
  readonly span: { readonly startByte: number; readonly endByte: number };
  readonly parentQualifiedName?: string;
}

export interface ImportIR {
  /** Raw module specifier as written in source. */
  readonly module: string;
  /** Exported names as declared by the source module (pre-alias). */
  readonly importedNames: readonly string[];
  /**
   * Alias-aware bindings (issue #1894 review): `local` is the identifier
   * usable at call sites in THIS file; `exported` is the name in the
   * source module. For non-aliased imports the two are equal. Optional so
   * pre-existing IR consumers and JSON fixtures stay valid; when absent,
   * consumers treat every `importedNames` entry as `local === exported`.
   */
  readonly bindings?: readonly ImportBindingIR[];
  readonly span: { readonly startByte: number; readonly endByte: number };
}

export interface ImportBindingIR {
  /** Name exported by the source module. */
  readonly exported: string;
  /** Local identifier bound in the importing file. */
  readonly local: string;
}

export interface ExportIR {
  readonly name: string;
  readonly span: { readonly startByte: number; readonly endByte: number };
}

export interface CallSiteIR {
  readonly calleeNameCandidates: readonly string[];
  /**
   * True when the callee is a member/property access (`obj.save()`,
   * `recv.field()`), issue #1894 review: bare-name heuristics must never
   * bind these — method dispatch is Phase B (LSP) territory. Optional so
   * pre-existing IR stays valid; absent = false.
   */
  readonly memberAccess?: boolean;
  readonly span: { readonly startByte: number; readonly endByte: number };
}

export interface RouteIR {
  /** HTTP verb in upper-case, or framework-native verb (e.g. "ANY"). */
  readonly verb: string;
  readonly pathTemplate: string;
  readonly handlerQualifiedName: string;
  readonly span: { readonly startByte: number; readonly endByte: number };
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------
/**
 * Reserved for PR2. Declared now so the public surface is stable; the
 * options object is intentionally empty in PR1.
 */
export interface CreateCodingGraphEngineOptions {
  /** Reserved for PR2: extra grammar directory supplied by the operator. */
  readonly grammarDir?: never;
}
