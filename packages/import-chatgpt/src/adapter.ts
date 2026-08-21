// ---------------------------------------------------------------------------
// ChatGPT importer adapter (issue #568 slice 2)
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

import {
  parseChatGPTExport,
  type ParsedChatGPTExport,
} from "./parser.js";
import {
  CHATGPT_SOURCE_LABEL,
  transformChatGPTExport,
} from "./transform.js";

/**
 * Canonical `ImporterAdapter` exposed by `@remnic/import-chatgpt`.
 *
 * Loaded by `remnic-cli/optional-importer.ts` via a computed-specifier
 * dynamic import. The CLI calls `adapter.parse` → `adapter.transform` →
 * `adapter.writeTo` through the shared `runImporter` helper in
 * `@remnic/core`.
 */
export const adapter: ImporterAdapter<ParsedChatGPTExport> = {
  name: "chatgpt",
  sourceLabel: CHATGPT_SOURCE_LABEL,

  parse(input: unknown, options?: ImporterParseOptions): ParsedChatGPTExport {
    return parseChatGPTExport(input, {
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.filePath !== undefined ? { filePath: options.filePath } : {}),
    });
  },

  transform(
    parsed: ParsedChatGPTExport,
    options?: ImporterTransformOptions,
  ): ImportedMemory[] {
    return transformChatGPTExport(parsed, {
      includeConversations: options?.includeConversations === true,
      ...(options?.maxMemories !== undefined
        ? { maxMemories: options.maxMemories }
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
export const chatgptAdapter = adapter;
