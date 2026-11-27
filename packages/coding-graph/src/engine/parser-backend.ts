import { Parser, Language, type Node as TSNode, type Tree as TSTree, type Language as TSLanguage } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statSync } from "node:fs";
import type { CodingGraphLanguage } from "@remnic/core";

/** Re-export tree-sitter types so extractors don't depend on web-tree-sitter directly. */
export type { TSNode, TSTree, TSLanguage };

export interface ParserBackend {
  /** Initialize the backend runtime (e.g. load the WASM core). Idempotent per instance. */
  init(): Promise<void>;
  /** Ensure the grammar for `lang` is loaded and a parser is ready. Idempotent per instance. */
  ensureLanguage(lang: CodingGraphLanguage): Promise<void>;
  /**
   * Parse `content` (a UTF-8 string) using the grammar for `lang`. Returns the
   * tree-sitter Tree on success, or `null` if the grammar is not loaded / the
   * parser cannot produce a tree. Node offsets are UTF-16 code-unit offsets;
   * callers must convert to UTF-8 byte offsets for multibyte content (#1659).
   */
  parse(lang: CodingGraphLanguage, content: string): TSTree | null;
  /** Return the loaded Language for `lang`, or null if not loaded. */
  getLanguage(lang: CodingGraphLanguage): TSLanguage | null;
  /** Release all parsers, grammars, and the WASM runtime. Safe to call multiple times. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------

function resolveGrammarDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "grammars"), // dist/ → ../grammars
    path.join(here, "..", "..", "grammars"), // src/engine/ → ../../grammars
    path.join(here, "grammars"), // flat layout fallback
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `coding-graph: could not locate the grammars/ directory from ${here}. ` +
      `Expected one of: ${candidates.join(", ")}`,
  );
}

export class WasmTreeSitterBackend implements ParserBackend {
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private parser: Parser | null = null;
  private readonly languages = new Map<CodingGraphLanguage, Language>();
  private readonly loadingLanguages = new Map<CodingGraphLanguage, Promise<void>>();
  private grammarDir = "";
  private grammarDirResolved = false;
  private readonly grammarDirHint: string | null;

  constructor(grammarDir?: string) {
    this.grammarDirHint = grammarDir ?? null;
  }

  private getGrammarDir(): string {
    if (this.grammarDirResolved) return this.grammarDir;
    this.grammarDir = this.grammarDirHint ?? resolveGrammarDir();
    this.grammarDirResolved = true;
    return this.grammarDir;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      try {
        await Parser.init();
        this.parser = new Parser();
        this.initialized = true;
      } finally {
        this.initializing = null;
      }
    })();
    return this.initializing;
  }

  async ensureLanguage(lang: CodingGraphLanguage): Promise<void> {
    await this.init();
    if (this.languages.has(lang)) return;
    if (this.loadingLanguages.has(lang)) return this.loadingLanguages.get(lang)!;
    const p = (async () => {
      try {
        const wasmPath = path.join(this.getGrammarDir(), grammarFileName(lang));
        const language = await Language.load(wasmPath);
        this.languages.set(lang, language);
      } finally {
        this.loadingLanguages.delete(lang);
      }
    })();
    this.loadingLanguages.set(lang, p);
    return p;
  }

  parse(lang: CodingGraphLanguage, content: string): TSTree | null {
    if (!this.parser) return null;
    const language = this.languages.get(lang);
    if (!language) return null;
    this.parser.setLanguage(language);
    return this.parser.parse(content);
  }

  /** Return the loaded Language object for `lang`, or null if not loaded. */
  getLanguage(lang: CodingGraphLanguage): Language | null {
    return this.languages.get(lang) ?? null;
  }

  async dispose(): Promise<void> {
    if (this.parser) {
      try {
        this.parser.delete();
      } catch {
        // already deleted — ignore
      }
      this.parser = null;
    }
    this.languages.clear();
    this.loadingLanguages.clear();
    this.initialized = false;
    this.initializing = null;
    this.grammarDirResolved = false;
    this.grammarDir = "";
  }
}

/**
 * Map a tier-1 language to its .wasm grammar filename. The names match the
 * files shipped by `tree-sitter-wasms` (0.1.13) and the grammars/ directory.
 * C# uses `c_sharp` because the upstream grammar names C# with an underscore.
 */
export function grammarFileName(lang: CodingGraphLanguage): string {
  const map: Record<CodingGraphLanguage, string> = {
    typescript: "tree-sitter-typescript.wasm",
    tsx: "tree-sitter-tsx.wasm",
    javascript: "tree-sitter-javascript.wasm",
    python: "tree-sitter-python.wasm",
    go: "tree-sitter-go.wasm",
    rust: "tree-sitter-rust.wasm",
    java: "tree-sitter-java.wasm",
    c: "tree-sitter-c.wasm",
    cpp: "tree-sitter-cpp.wasm",
    csharp: "tree-sitter-c_sharp.wasm",
    ruby: "tree-sitter-ruby.wasm",
    php: "tree-sitter-php.wasm",
    kotlin: "tree-sitter-kotlin.wasm",
    swift: "tree-sitter-swift.wasm",
    bash: "tree-sitter-bash.wasm",
  };
  return map[lang];
}
