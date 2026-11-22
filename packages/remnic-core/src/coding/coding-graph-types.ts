//
//
//
//         ▲
//         │
//

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
export const CODING_GRAPH_ENGINE_VERSION = "0.1.0-pr1" as const;

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------
export type CodingGraphErrorCode =
  | "not_implemented"
  | "module_load_failed";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
export interface CodingGraphEngine {
  readonly engineVersion: string;
  readonly supportedLanguages: readonly CodingGraphLanguage[];
  parseFile(input: ParseFileInput): Promise<ParseResult>;
  /** Engine lifecycle — release any cached parsers/grammars. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------
export interface CreateCodingGraphEngineOptions {
  readonly grammarDir?: never;
}
