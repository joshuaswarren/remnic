import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("ingestReplayBatch enqueues replay slices without clearing shared buffer", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestrator.ts"),
    "utf-8",
  );

  assert.match(
    source,
    /if \(shouldSkipImplicitExtraction\(this\.config\)\) \{[\s\S]*ingestReplayBatch: skipping implicit extraction because captureMode=explicit[\s\S]*return;\s*\}/m,
    "replay ingestion should honor explicit capture mode and skip implicit extraction paths",
  );
  assert.match(
    source,
    /skipDedupeCheck:\s*true,\s*clearBufferAfterExtraction:\s*false,\s*skipCharThreshold:\s*true,/m,
    "replay ingestion should bypass dedupe/minimum thresholds and preserve the live smart buffer",
  );
  assert.match(
    source,
    /for \(const sessionSlice of splitTurnsBySourceValidAt\(sessionTurns\)\) \{[\s\S]*bufferKey:\s*key,[\s\S]*targetValidAtMs:\s*targetSourceValidAtSortMs\(sessionSlice\),[\s\S]*\.sort\(\(a, b\) => \{[\s\S]*\.map\(\s*\(\{ bufferKey, turns: sessionSlice \}\) =>[\s\S]*skipDedupeCheck:\s*true,[\s\S]*clearBufferAfterExtraction:\s*false,[\s\S]*skipCharThreshold:\s*true,[\s\S]*skipUserTurnThreshold:\s*true,[\s\S]*bufferKey,/m,
    "replay ingestion should globally order source slices while preserving the session-specific buffer key and threshold bypasses",
  );
  assert.match(
    source,
    /function sourceValidAtContextTurns\([\s\S]*targetStart: number,[\s\S]*targetEnd: number,[\s\S]*contextValidAtMs > targetValidAtMs[\s\S]*\.sort\(\(a, b\) => \{[\s\S]*if \(a\.validAtMs < b\.validAtMs\) return -1;[\s\S]*if \(a\.validAtMs > b\.validAtMs\) return 1;[\s\S]*return a\.index < b\.index \? -1 : 1;[\s\S]*\.slice\(-SOURCE_VALID_AT_CONTEXT_TURNS\)[\s\S]*asExtractionContextTurn/m,
    "source-dated replay context should be selected by source time, not input adjacency, while excluding future-dated turns",
  );
  assert.match(
    source,
    /const settled = await Promise\.allSettled\(replayTasks\);[\s\S]*firstRejected[\s\S]*throw firstRejected\.reason;/m,
    "replay ingestion should drain all per-session tasks before surfacing a batch failure",
  );
});

test("queueBufferedExtraction preserves explicit false clearBufferAfterExtraction", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestrator.ts"),
    "utf-8",
  );

  assert.match(
    source,
    /clearBufferAfterExtraction:\s*options\.clearBufferAfterExtraction\s*\?\?\s*true,/m,
    "queue options should preserve explicit false clearBufferAfterExtraction values",
  );
});

test("runExtraction threshold bypasses are explicit and independent", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestrator.ts"),
    "utf-8",
  );

  assert.match(
    source,
    /const skipCharThreshold = options\.skipCharThreshold \?\? false;/m,
    "runExtraction should support explicit char-threshold bypass",
  );
  assert.match(
    source,
    /const skipUserTurnThreshold = options\.skipUserTurnThreshold \?\? false;/m,
    "runExtraction should support explicit user-turn threshold bypass",
  );
  assert.match(
    source,
    /const userTurns = targetTurns\.filter\(\(t\) => t\.role === "user"\);\s*const totalChars = targetTurns\.reduce\(/m,
    "runExtraction should compute threshold inputs from non-context target turns",
  );
  assert.match(
    source,
    /const belowCharThreshold = totalChars < this\.config\.extractionMinChars;\s*const belowUserTurnThreshold =\s*!skipUserTurnThreshold &&\s*userTurns\.length < this\.config\.extractionMinUserTurns;/m,
    "runExtraction should keep char and user-turn threshold bypasses separate",
  );
  assert.match(
    source,
    /if \(\(!skipCharThreshold && belowCharThreshold\) \|\| belowUserTurnThreshold\)/m,
    "threshold checks should honor only their explicit bypass flag",
  );
});

test("queueBufferedExtraction settles task callbacks on dedupe skip", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestrator.ts"),
    "utf-8",
  );

  assert.match(
    source,
    /if \(\s*!options\.skipDedupeCheck\s*&&\s*!this\.shouldQueueExtraction\(turnsToExtract,\s*\{\s*bufferKey\s*\}\)\s*\) \{[\s\S]*options\.onTaskSettled\?\.\(\);[\s\S]*return;/m,
    "dedupe skip path should settle any task callback to avoid hanging replay promises",
  );
});
