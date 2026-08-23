// ChatGPT importer adapter (issue #568 slice 2). The parse/transform/writeTo
// shell comes from `defineFileImporterAdapter` in @remnic/core (issue #2794).
import type { ImporterAdapter } from "@remnic/core";
import { defineFileImporterAdapter } from "@remnic/core";

import { parseChatGPTExport, type ParsedChatGPTExport } from "./parser.js";
import { CHATGPT_SOURCE_LABEL, transformChatGPTExport } from "./transform.js";

export const adapter: ImporterAdapter<ParsedChatGPTExport> =
  defineFileImporterAdapter({
    name: "chatgpt",
    sourceLabel: CHATGPT_SOURCE_LABEL,
    parse: parseChatGPTExport,
    transform(parsed, options) {
      return transformChatGPTExport(parsed, {
        includeConversations: options?.includeConversations === true,
        ...(options?.maxMemories !== undefined
          ? { maxMemories: options.maxMemories }
          : {}),
      });
    },
  });

/** Alias kept for symmetry with other @remnic/import-* packages. */
export const chatgptAdapter = adapter;
