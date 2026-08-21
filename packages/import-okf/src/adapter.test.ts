import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ImportTurn, ImporterWriteTarget } from "@remnic/core";
import { runImporter } from "@remnic/core";

import { adapter, okfAdapter } from "./adapter.js";

function makeTarget(): { target: ImporterWriteTarget; received: ImportTurn[][] } {
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

describe("okf adapter", () => {
  it("exports a canonical adapter", () => {
    assert.equal(adapter.name, "okf");
    assert.equal(okfAdapter, adapter);
  });

  it("imports a directory bundle", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "okf-adapter-"));
    writeFileSync(path.join(root, "a.md"), "---\ntype: Preference\n---\nDark mode.\n");
    const { target, received } = makeTarget();
    const result = await runImporter(adapter, root, target);
    assert.equal(result.memoriesPlanned, 1);
    assert.equal(result.memoriesWritten, 1);
    assert.equal(received.flat()[0]?.participantName, "okf");
  });

  it("dry-run writes nothing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "okf-dry-"));
    writeFileSync(path.join(root, "a.md"), "---\ntype: Moment\n---\nShipped.\n");
    const { target, received } = makeTarget();
    const result = await runImporter(adapter, root, target, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.memoriesWritten, 0);
    assert.equal(received.length, 0);
  });
});
