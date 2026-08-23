// ---------------------------------------------------------------------------
// Shared importer test harness (issue #2794)
// ---------------------------------------------------------------------------
// `makeTarget()` / `loadFixture()` were duplicated across the
// `@remnic/import-*` adapter tests. Test-only — never import from
// production code paths.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ImportTurn } from "../bulk-import/types.js";
import type { ImporterWriteTarget } from "./base.js";

/** In-memory `ImporterWriteTarget` that captures every batch it receives. */
export function makeImporterTestTarget(): {
  target: ImporterWriteTarget;
  received: ImportTurn[][];
} {
  const received: ImportTurn[][] = [];
  return {
    target: {
      async ingestBulkImportBatch(turns) {
        received.push(turns.map((t) => ({ ...t })));
      },
      bulkImportWriteNamespace() {
        return "default";
      },
    },
    received,
  };
}

/** Read `<pkg>/fixtures/<name>` relative to the importing test file. */
export function loadImporterFixture(
  testFileUrl: string,
  name: string,
): string {
  return readFileSync(
    path.join(path.dirname(fileURLToPath(testFileUrl)), "../fixtures", name),
    "utf-8",
  );
}
