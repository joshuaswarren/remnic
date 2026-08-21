import type { ImporterAdapter, ImporterTransformOptions } from "@remnic/core";
import { defaultWriteMemoriesToOrchestrator } from "@remnic/core";

import { parseSupermemoryExport, type ParsedSupermemoryExport } from "./parser.js";
import { SUPERMEMORY_SOURCE_LABEL, transformSupermemoryExport } from "./transform.js";

export const adapter: ImporterAdapter<ParsedSupermemoryExport> = {
  name: "supermemory",
  sourceLabel: SUPERMEMORY_SOURCE_LABEL,
  parse(input, options) {
    return parseSupermemoryExport(input, options?.filePath);
  },
  transform(
    parsed,
    options?: ImporterTransformOptions,
  ) {
    return transformSupermemoryExport(parsed, {
      ...(options?.maxMemories !== undefined
        ? { maxMemories: options.maxMemories }
        : {}),
    });
  },
  writeTo(target, memories) {
    return defaultWriteMemoriesToOrchestrator(target, memories);
  },
};

export const supermemoryAdapter = adapter;
