import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("runExtraction handles pre-persist threading errors fail-open", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-run.ts"),
    "utf-8",
  );

  assert.match(
    source,
    /try\s*\{\s*threadIdForExtraction\s*=\s*await\s*runDeadlineAware\(\s*\(\)\s*=>\s*this\.deps\.getThreading\(\)\.processTurn\(lastTurn,\s*\[\]\),[\s\S]*?\);\s*\}\s*catch\s*\(err\)\s*\{[\s\S]*?non-fatal/m,
    "threading.processTurn before persistence should be wrapped in fail-open try/catch",
  );
});

test("persistExtraction updates in-memory thread episode IDs before graph edge construction", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-persist.ts"),
    "utf-8",
  );

  const appendIdx = source.indexOf("threadEpisodeIdsForGraph.push(memoryId);");
  const buildIdx = source.search(
    /await this\.deps\.buildGraphEdge\(\s*(?:targetStorage|storage),\s*memoryRelPath,\s*entityRef,\s*memoryId/m,
  );

  assert.notEqual(
    appendIdx,
    -1,
    "expected in-memory threadEpisodeIdsForGraph update for non-chunked memory writes",
  );
  assert.notEqual(
    buildIdx,
    -1,
    "expected buildGraphEdge call for non-chunked memory writes",
  );
  assert.ok(
    appendIdx < buildIdx,
    "threadEpisodeIdsForGraph should update before buildGraphEdge so same-batch memories can form time/causal edges",
  );
});

test("persistExtraction avoids per-memory thread file writes", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-persist.ts"),
    "utf-8",
  );

  assert.doesNotMatch(
    source,
    /await this\.deps\.getThreading\(\)\.appendEpisodeIds\(threadIdForExtraction,\s*\[memoryId\]\);/,
    "non-chunked writes should not perform per-fact thread file writes",
  );
  assert.doesNotMatch(
    source,
    /await this\.deps\.getThreading\(\)\.appendEpisodeIds\(threadIdForExtraction,\s*\[parentId\]\);/,
    "chunked parent writes should not perform per-fact thread file writes",
  );
});

test("in-memory thread episode context updates for chunked and non-chunked writes", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-persist.ts"),
    "utf-8",
  );
  assert.match(
    source,
    /if \(\s*!postWriteGuard\s*&&\s*threadEpisodeIdsForGraph\s*&&\s*!threadEpisodeIdsForGraph\.includes\(memoryId\)\s*\) \{\s*threadEpisodeIdsForGraph\.push\(memoryId\);\s*\}/m,
    "memoryId is appended to thread context only when not pending_review and not tombstone-blocked (faithfulness + #1645 tombstone guard)",
  );
  assert.match(
    source,
    /if \(\s*!postWriteGuard\s*&&\s*threadEpisodeIdsForGraph\s*&&\s*!threadEpisodeIdsForGraph\.includes\(parentId\)\s*\) \{\s*threadEpisodeIdsForGraph\.push\(parentId\);\s*\}/m,
    "parentId is appended to thread context only when not pending_review and not tombstone-blocked (faithfulness + #1645 tombstone guard)",
  );
});

test("buildGraphEdge does not read global current thread ID", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestrator.ts"),
    "utf-8",
  );

  assert.doesNotMatch(
    source,
    /this\.threading\.getCurrentThreadId\(\)/,
    "graph edge construction should use explicit extraction thread context, not global mutable thread state",
  );
});

test("buildGraphEdge does not reload thread file per memory write", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestrator.ts"),
    "utf-8",
  );

  assert.doesNotMatch(
    source,
    /await this\.threading\.loadThread\(threadIdForEdge\)/,
    "buildGraphEdge should use in-memory thread episode IDs and avoid per-fact thread reloads",
  );
  assert.match(
    source,
    /threadEpisodeIdsForGraph:\s*string\[\]\s*\|\s*undefined/,
    "buildGraphEdge should accept in-memory thread episode IDs",
  );
});

test("persisted path resolution does not call getMemoryById in per-fact write flow", () => {
  // #1526 seam 25: module-level helpers moved to
  // orchestration/orchestrator-helpers.ts.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "orchestrator-helpers.ts"),
    "utf-8",
  );
  const helperMatch = source.match(
    /export function resolvePersistedMemoryRelativePath\([\s\S]*?\n\}/m,
  );
  assert.ok(
    helperMatch,
    "expected resolvePersistedMemoryRelativePath helper in orchestrator-helpers.ts",
  );
  const helperSource = helperMatch[0];

  assert.match(helperSource, /pathById:\s*Map<string,\s*string>/);
  assert.doesNotMatch(helperSource, /getMemoryById\(/);
});

test("persisted path resolution is not short-circuited by set-before-resolve", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-persist.ts"),
    "utf-8",
  );
  assert.doesNotMatch(
    source,
    /memoryPathById\.set\([^)]*\);\s*const (?:parentRelPath|memoryRelPath) = resolvePersistedMemoryRelativePath\(/m,
    "pathById should not be seeded with fallback immediately before resolvePersistedMemoryRelativePath",
  );
});

test("buildGraphEdge forwards fallback causal predecessor when thread context is absent", () => {
  // #1526 seam 23: buildGraphEdge moved to orchestration/persistence-index.ts.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "persistence-index.ts"),
    "utf-8",
  );
  assert.match(
    source,
    /const causalPredecessor =\s*recentInThread\[recentInThread\.length - 1\] \?\? fallbackCausalPredecessor;/m,
    "expected causal predecessor to fall back to same-extraction ordering when no thread history is available",
  );
});

test("persistExtraction includes written question IDs in persistedIds", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-persist.ts"),
    "utf-8",
  );
  // The question loop tracks each written id via trackPersistedId so the thread
  // batch append can include them. The id-tracking call lives inside the
  // `if (id) { ... }` block alongside the durable-write catalog flag (NHZEZ
  // sweep), so the assertion matches the tracking call within that block rather
  // than a brittle single-line form.
  assert.match(
    source,
    /const id = await storage\.writeQuestion\(q\.question,\s*q\.context,\s*q\.priority\);\s*if \(id\) \{[\s\S]*?trackPersistedId\(storage,\s*id\);/m,
    "question IDs should be added to persistedIds so thread batch append can include them",
  );
});
