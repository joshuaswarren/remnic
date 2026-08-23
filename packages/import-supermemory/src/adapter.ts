// Supermemory importer adapter. The parse/transform/writeTo shell comes from
// `defineFileImporterAdapter` in @remnic/core (issue #2794).
import type { ImporterAdapter } from "@remnic/core";
import { defineFileImporterAdapter } from "@remnic/core";

import { parseSupermemoryExport, type ParsedSupermemoryExport } from "./parser.js";
import { SUPERMEMORY_SOURCE_LABEL, transformSupermemoryExport } from "./transform.js";

export const adapter: ImporterAdapter<ParsedSupermemoryExport> =
  defineFileImporterAdapter({
    name: "supermemory",
    sourceLabel: SUPERMEMORY_SOURCE_LABEL,
    parse: (input, options) => parseSupermemoryExport(input, options.filePath),
    transform(parsed, options) {
      return transformSupermemoryExport(parsed, {
        ...(options?.maxMemories !== undefined
          ? { maxMemories: options.maxMemories }
          : {}),
      });
    },
  });

export const supermemoryAdapter = adapter;
