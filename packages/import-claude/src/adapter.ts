// ---------------------------------------------------------------------------
// Claude importer adapter (issue #568 slice 3)
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
  parseClaudeExport,
  type ParsedClaudeExport,
} from "./parser.js";
import { CLAUDE_SOURCE_LABEL, transformClaudeExport } from "./transform.js";

/**
 * Canonical `ImporterAdapter` exposed by `@remnic/import-claude`.
 *
 * Loaded by `remnic-cli/optional-importer.ts` via a computed-specifier dynamic
 * import. The CLI drives `adapter.parse` → `adapter.transform` →
 * `adapter.writeTo` through the shared `runImporter` helper in `@remnic/core`.
 */
export const adapter: ImporterAdapter<ParsedClaudeExport> = {
  name: "claude",
  sourceLabel: CLAUDE_SOURCE_LABEL,

  parse(input: unknown, options?: ImporterParseOptions): ParsedClaudeExport {
    return parseClaudeExport(input, {
      ...(options?.strict !== undefined ? { strict: options.strict } : {}),
      ...(options?.filePath !== undefined ? { filePath: options.filePath } : {}),
    });
  },

  transform(
    parsed: ParsedClaudeExport,
    options?: ImporterTransformOptions,
  ): ImportedMemory[] {
    return transformClaudeExport(parsed, {
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
export const claudeAdapter = adapter;
