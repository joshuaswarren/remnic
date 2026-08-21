// ---------------------------------------------------------------------------
// WeClone bulk-import source adapter
// ---------------------------------------------------------------------------

import type { BulkImportSourceAdapter, BulkImportSource } from "@remnic/core";
import { parseWeCloneExport, type ParseOptions } from "./parser.js";

/**
 * Adapter that conforms to `BulkImportSourceAdapter` from `@remnic/core`.
 * Delegates parsing to `parseWeCloneExport`.
 */
export const wecloneImportAdapter: BulkImportSourceAdapter = {
  name: "weclone",
  parse(
    input: unknown,
    options?: { strict?: boolean; platform?: string },
  ): BulkImportSource {
    const parseOpts: ParseOptions | undefined = options
      ? {
          strict: options.strict,
          ...(options.platform !== undefined
            ? { platform: options.platform as ParseOptions["platform"] }
            : {}),
        }
      : undefined;
    return parseWeCloneExport(input, parseOpts);
  },
};
