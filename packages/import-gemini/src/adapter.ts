// ---------------------------------------------------------------------------
// Gemini importer adapter (issue #568 slice 4)
// ---------------------------------------------------------------------------

import type {
  ImportedMemory,
  ImporterAdapter,
  ImporterParseOptions,
  ImporterTransformOptions,
  ImporterWriteResult,
  ImporterWriteTarget,
} from "@remnic/core";
import { defaultWriteMemoriesToOrchestrator } from "@remnic/core";

import { parseGeminiExport, type ParsedGeminiExport } from "./parser.js";
import { GEMINI_SOURCE_LABEL, transformGeminiExport } from "./transform.js";

/**
 * Canonical `ImporterAdapter` exposed by `@remnic/import-gemini`.
 *
 * Loaded by `remnic-cli/optional-importer.ts` via a computed-specifier dynamic
 * import. The CLI drives `adapter.parse` → `adapter.transform` →
 * `adapter.writeTo` through the shared `runImporter` helper in `@remnic/core`.
 */
export const adapter: ImporterAdapter<ParsedGeminiExport> = {
  name: "gemini",
  sourceLabel: GEMINI_SOURCE_LABEL,

  parse(input: unknown, options?: ImporterParseOptions): ParsedGeminiExport {
    return parseGeminiExport(input, {
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.filePath !== undefined ? { filePath: options.filePath } : {}),
    });
  },

  transform(
    parsed: ParsedGeminiExport,
    options?: ImporterTransformOptions,
  ): ImportedMemory[] {
    return transformGeminiExport(parsed, {
      ...(options?.maxMemories !== undefined
        ? { maxMemories: options.maxMemories }
        : {}),
      ...(options?.minPromptLength !== undefined
        ? { minPromptLength: options.minPromptLength }
        : {}),
    });
  },

  async writeTo(
    target: ImporterWriteTarget,
    memories: ImportedMemory[],
  ): Promise<ImporterWriteResult> {
    return defaultWriteMemoriesToOrchestrator(target, memories);
  },
};

/** Alias kept for symmetry with other @remnic/import-* packages. */
export const geminiAdapter = adapter;
