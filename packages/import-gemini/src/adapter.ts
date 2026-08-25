// Gemini importer adapter (issue #568 slice 4). The parse/transform/writeTo
// shell comes from `defineFileImporterAdapter` in @remnic/core (issue #2794).
import type { ImporterAdapter } from "@remnic/core";
import { defineFileImporterAdapter } from "@remnic/core";

import { parseGeminiExport, type ParsedGeminiExport } from "./parser.js";
import { GEMINI_SOURCE_LABEL, transformGeminiExport } from "./transform.js";

export const adapter: ImporterAdapter<ParsedGeminiExport> =
  defineFileImporterAdapter({
    name: "gemini",
    sourceLabel: GEMINI_SOURCE_LABEL,
    parse: parseGeminiExport,
    transform(parsed, options) {
      return transformGeminiExport(parsed, {
        ...(options?.maxMemories !== undefined
          ? { maxMemories: options.maxMemories }
          : {}),
        ...(options?.minPromptLength !== undefined
          ? { minPromptLength: options.minPromptLength }
          : {}),
      });
    },
  });

/** Alias kept for symmetry with other @remnic/import-* packages. */
export const geminiAdapter = adapter;
