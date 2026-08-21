/**
 * Engine factory — constructs a `CodingGraphEngine` backed by the WASM
 * tree-sitter parser + tier-1 extractors.
 *
 * Rule 11 (no module-level state): the backend, query caches, and parser
 * instances all live on the returned engine object. Two `createCodingGraphEngine`
 * calls in the same process have fully isolated state.
 *
 * Rule 30/48: `codingGraph.enabled` defaults `false` in @remnic/core; the
 * loader is never invoked when disabled, so this factory is only reached when
 * the user has explicitly opted in.
 */
import {
  CODING_GRAPH_ENGINE_VERSION,
  TIER_1_LANGUAGES,
  type CodingGraphEngine,
  type CodingGraphLanguage,
  type CreateCodingGraphEngineOptions,
  type FileIR,
  type ParseFileInput,
  type ParseResult,
} from "@remnic/core";

import { WasmTreeSitterBackend, type ParserBackend } from "./parser-backend.js";
import { emitFileIR } from "./emit.js";
import { sniffLanguage, isTier1Language } from "./language-sniff.js";

/**
 * The internal engine object. Implements `CodingGraphEngine` from @remnic/core.
 */
class CodingGraphEngineImpl implements CodingGraphEngine {
  readonly engineVersion: string;
  readonly supportedLanguages: readonly CodingGraphLanguage[];
  private readonly backend: ParserBackend;
  private disposed = false;
  /**
   * Serialize parse calls. The backend's single Parser instance is shared
   * across all languages, so concurrent setLanguage/parse calls would race.
   * Each parseFile call awaits the previous before touching the parser.
   */
  private parseChain: Promise<void> = Promise.resolve();

  constructor(backend: ParserBackend) {
    this.engineVersion = CODING_GRAPH_ENGINE_VERSION;
    this.supportedLanguages = TIER_1_LANGUAGES;
    this.backend = backend;
  }
  async parseFile(input: ParseFileInput): Promise<ParseResult> {
    if (this.disposed) {
      return {
        ok: false,
        code: "parse_failed",
        path: input.path,
        message: "engine has been disposed",
      };
    }

    // Serialize: wait for any in-flight parse before touching the shared parser.
    const previous = this.parseChain;
    let release!: () => void;
    this.parseChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    // Re-check disposed: another caller may have disposed the engine
    // while we were waiting for the previous parse to finish.
    if (this.disposed) {
      release();
      return {
        ok: false,
        code: "parse_failed",
        path: input.path,
        message: "engine has been disposed",
      };
    }
    try {
      return await this.doParseFile(input);
    } finally {
      release();
    }
  }

  private async doParseFile(input: ParseFileInput): Promise<ParseResult> {

    // Resolve the language — explicit override wins, then sniff from path.
    const lang: CodingGraphLanguage | null =
      input.language ?? sniffLanguage(input.path);
    if (!lang || !isTier1Language(lang)) {
      return {
        ok: false,
        code: "parse_failed",
        path: input.path,
        message: `unsupported language for path "${input.path}"; ` +
          `supported extensions map to: ${TIER_1_LANGUAGES.join(", ")}`,
      };
    }

    // Ensure the grammar is loaded (rule 51 — error, not silent skip).
    try {
      await this.backend.ensureLanguage(lang);
    } catch (err) {
      return {
        ok: false,
        code: "parse_failed",
        path: input.path,
        message: `failed to load grammar for ${lang}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // web-tree-sitter parses UTF-16 internally, so node offsets are UTF-16
    // code-unit offsets. We convert to UTF-8 byte offsets after extraction
    // (issue #1659 item 3 — multibyte span accuracy).
    const contentStr = Buffer.from(input.content).toString("utf-8");
    const tree = this.backend.parse(lang, contentStr);
    if (!tree) {
      return {
        ok: false,
        code: "parse_failed",
        path: input.path,
        message: `tree-sitter returned null for ${lang} (grammar may be corrupt)`,
      };
    }

    try {
      const root = tree.rootNode;
      const language = this.backend.getLanguage(lang);
      if (!language) {
        return {
          ok: false,
          code: "parse_failed",
          path: input.path,
          message: `language object unavailable for ${lang}`,
        };
      }

      const ir: FileIR = emitFileIR(
        input.path,
        lang,
        input.content,
        root,
        language,
        contentStr,
      );
      return { ok: true, ir };
    } catch (err) {
      // Rule 44: extraction/query errors surface as tagged parse_failed,
      // not thrown exceptions that abort batch reindex.
      return {
        ok: false,
        code: "parse_failed",
        path: input.path,
        message: `extraction failed for ${lang}: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      tree.delete();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Wait for any in-flight parse to finish before tearing down the
    // backend. Without this, a parseFile call that already passed the
    // disposed guard can touch freed parser/grammar state.
    await this.parseChain;
    await this.backend.dispose();
  }
}

/**
 * Construct a coding-graph engine. PR2 implementation: real WASM tree-sitter
 * parser with tier-1 extractors. No longer throws `not_implemented`.
 *
 * @throws never — load failures surface as `{ ok: false, code: "parse_failed" }`
 *   per-file, not as constructor exceptions.
 */
export function createCodingGraphEngine(
  _options: CreateCodingGraphEngineOptions = {},
): CodingGraphEngine {
  const backend = new WasmTreeSitterBackend();
  return new CodingGraphEngineImpl(backend);
}
