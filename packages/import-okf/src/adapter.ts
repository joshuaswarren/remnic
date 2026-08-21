import type {
  ImportedMemory,
  ImporterAdapter,
  ImporterParseOptions,
  ImporterWriteResult,
  ImporterWriteTarget,
} from "@remnic/core";
import { defaultWriteMemoriesToOrchestrator } from "@remnic/core";

import { parseOkfBundle, type ParsedOkfBundle } from "./parser.js";

export const OKF_SOURCE_LABEL = "okf";

export const adapter: ImporterAdapter<ParsedOkfBundle> = {
  name: "okf",
  sourceLabel: OKF_SOURCE_LABEL,

  parse(input: unknown, options?: ImporterParseOptions): ParsedOkfBundle {
    return parseOkfBundle(typeof input === "string" ? input : options?.filePath);
  },

  transform(parsed: ParsedOkfBundle): ImportedMemory[] {
    return parsed.documents
      .filter((doc) => doc.content.length > 0)
      .map((doc) => ({
        content: doc.content,
        sourceLabel: OKF_SOURCE_LABEL,
        importedFromPath: `${parsed.root}/${doc.relPath}`,
        metadata: { category: doc.category, relPath: doc.relPath },
        ...(doc.sourceId ? { sourceId: doc.sourceId } : {}),
        ...(doc.sourceTimestamp ? { sourceTimestamp: doc.sourceTimestamp } : {}),
      }));
  },

  async writeTo(
    target: ImporterWriteTarget,
    memories: ImportedMemory[],
  ): Promise<ImporterWriteResult> {
    return defaultWriteMemoriesToOrchestrator(target, memories);
  },
};

export const okfAdapter = adapter;
