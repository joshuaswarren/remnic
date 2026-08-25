// Claude importer adapter (issue #568 slice 3). The parse/transform/writeTo
// shell comes from `defineFileImporterAdapter` in @remnic/core (issue #2794).
import type { ImporterAdapter } from "@remnic/core";
import { defineFileImporterAdapter } from "@remnic/core";

import { parseClaudeExport, type ParsedClaudeExport } from "./parser.js";
import { CLAUDE_SOURCE_LABEL, transformClaudeExport } from "./transform.js";

export const adapter: ImporterAdapter<ParsedClaudeExport> =
  defineFileImporterAdapter({
    name: "claude",
    sourceLabel: CLAUDE_SOURCE_LABEL,
    parse: parseClaudeExport,
    transform(parsed, options) {
      return transformClaudeExport(parsed, {
        includeConversations: options?.includeConversations === true,
        ...(options?.maxMemories !== undefined
          ? { maxMemories: options.maxMemories }
          : {}),
      });
    },
  });

/** Alias kept for symmetry with other @remnic/import-* packages. */
export const claudeAdapter = adapter;
