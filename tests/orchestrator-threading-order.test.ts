import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("runExtraction establishes thread context before persistExtraction", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-run.ts"),
    "utf-8",
  );

  const processTurnIdx = source.indexOf("await this.deps.getThreading().processTurn(lastTurn");
  const persistIdx = source.indexOf("const { persistedIds } = await this.deps.persistExtraction(");

  assert.notEqual(
    processTurnIdx,
    -1,
    "expected runExtraction to call threading.processTurn",
  );
  assert.notEqual(
    persistIdx,
    -1,
    "expected runExtraction to call persistExtraction",
  );
  assert.ok(
    processTurnIdx < persistIdx,
    "threading.processTurn should run before persistExtraction so graph edge construction uses current thread context",
  );
});

test("runExtraction batch-appends persisted IDs after persistExtraction", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-run.ts"),
    "utf-8",
  );

  assert.match(
    source,
    /if\s*\(\s*resolvePresentationCapabilities\(this\.config\)\.threading\s*&&\s*threadIdForExtraction\s*&&\s*persistedIds\.length > 0\s*\)\s*\{[\s\S]*?await this\.deps\.appendPersistedThreadEpisodes\(\s*threadIdForExtraction,\s*persistedIds,?\s*\);/m,
    "runExtraction should batch-append persisted IDs after persistence for thread completeness",
  );
});
