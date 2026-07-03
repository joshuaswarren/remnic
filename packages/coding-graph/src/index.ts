/**
 * @remnic/coding-graph — symbol-extraction engine for codebase memory.
 *
 * À-la-carte optional companion of @remnic/core (CLAUDE.md rule 57). This
 * file ships only the public surface for PR1 (#1551 step 1): the engine
 * placeholder, the version constant, and the not-implemented factory that
 * throws a tagged error so callers (and the core optional loader) always
 * see a *labeled* not-implemented signal rather than a silent stub.
 *
 * The real backend (web-tree-sitter parser, per-language extractors,
 * grammar manager) lands in PR2. Until then, `createCodingGraphEngine`
 * returns a tagged `{ ok: false, code: "not_implemented", engineVersion }`
 * result wrapped in a thrown CodingGraphError so call-sites can:
 *
 *   (a) detect the placeholder definitively via a structural code ("not_implemented"),
 *   (b) surface the engine VERSION the user requested (helpful once PR2 ships),
 *   (c) propagate it as a normal thrown error for try/catch flow.
 *
 * The grammar .wasm assets directory (`grammars/`) is listed in
 * package.json `files` so PR2's `.wasm` payloads ship in the tarball
 * without further packaging changes.
 */

// ---------------------------------------------------------------------------
// Version constant
// ---------------------------------------------------------------------------

/**
 * Public engine version. Bumped in lockstep with the package version while
 * the engine is under active development (PR2+). External callers should
 * treat this as informational; semantic compatibility is not promised
 * until v10 ships.
 */
export const ENGINE_VERSION = "0.1.0-pr1" as const;

// ---------------------------------------------------------------------------
// Tier 1 language list (declared now; tree-sitter grammar .wasm files
// themselves ship in PR2)
// ---------------------------------------------------------------------------

/**
 * Tier-1 languages the engine will support when implementation lands.
 * Order is stable; per-language configuration is not yet exposed because
 * no extractor exists yet — adding config in PR1 would force PR2 to
 * thread it through every IR site.
 */
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
// Tagged error — carriers of the not-implemented signal
// ---------------------------------------------------------------------------

/**
 * Stable error code so callers (and the optional loader in core) can
 * pattern-match without parsing human-readable strings. New codes must
 * be added here so consumers see them via TypeScript.
 */
export type CodingGraphErrorCode =
  | "not_implemented"
  | "module_load_failed";

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
// Engine interface — final shape PR2 implements against
// ---------------------------------------------------------------------------

/**
 * Public engine surface. The interface itself is complete enough for PR2
 * to satisfy without churn; the placeholder implementation throws on
 * construction, so the runtime contract is observable today.
 */
export interface CodingGraphEngine {
  /** Engine version reported at construction time. */
  readonly engineVersion: string;
  /** Tier-1 languages this build supports (PR2 will narrow by grammar availability). */
  readonly supportedLanguages: readonly CodingGraphLanguage[];
  /**
   * Parse a single source file and emit its FileIR.
   *
   * PR1 always throws `CodingGraphError("not_implemented", ...)`. PR2 will
   * return `ParseResult`; failure paths come back as
   * `{ ok: false, code: "parse_failed", path, message }` (rule 44) rather
   * than partial / silent IR.
   */
  parseFile(input: ParseFileInput): Promise<ParseResult>;
  /** Engine lifecycle — release any cached parsers/grammars. */
  dispose(): Promise<void>;
}

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
  | { readonly ok: false; readonly code: "parse_failed"; readonly path: string; readonly message: string };

/**
 * Intermediate representation contract — the seam between the parser
 * (this package) and the graph store (sibling issue #1552). PR1 declares
 * the shape; PR2 fills the extractor that produces one. Field types are
 * the minimal viable set per the issue's design section.
 */
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
  readonly kind: "function" | "class" | "method" | "interface" | "enum" | "type" | "module";
  readonly name: string;
  readonly qualifiedName: string;
  /** Half-open byte span `[startByte, endByte)`. Rule 35. */
  readonly span: { readonly startByte: number; readonly endByte: number };
  readonly parentQualifiedName?: string;
}

export interface ImportIR {
  /** Raw module specifier as written in source. */
  readonly module: string;
  readonly importedNames: readonly string[];
  readonly span: { readonly startByte: number; readonly endByte: number };
}

export interface ExportIR {
  readonly name: string;
  readonly span: { readonly startByte: number; readonly endByte: number };
}

export interface CallSiteIR {
  readonly calleeNameCandidates: readonly string[];
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
// Placeholder factory
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

/**
 * Reserved for PR2. Declared now so the public surface is stable; the
 * options object is intentionally empty in PR1.
 */
export interface CreateCodingGraphEngineOptions {
  /** Reserved for PR2: extra grammar directory supplied by the operator. */
  readonly grammarDir?: never;
}
