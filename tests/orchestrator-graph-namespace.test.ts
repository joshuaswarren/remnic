import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("orchestrator scopes graph indexes to storage namespace roots", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestrator.ts"), "utf-8");

  assert.match(
    source,
    /private readonly graphIndexes = new Map<string, GraphIndex>\(\);/,
    "expected per-storage graph index map",
  );
  assert.match(
    source,
    /private graphIndexFor\(storage: StorageManager\): GraphIndex/,
    "expected graphIndexFor helper to resolve namespace-specific graph index",
  );
  assert.match(
    source,
    /const key = storage\.dir;/,
    "expected graph index key to be storage.dir (active namespace root)",
  );
  assert.match(
    source,
    /new GraphIndex\(key, this\.config\)/,
    "expected GraphIndex initialization to use namespace storage root",
  );
  assert.doesNotMatch(
    source,
    /this\.graphIndex = new GraphIndex\(config\.memoryDir, config\);/,
    "graph index should not be pinned to default memory root when namespaces are enabled",
  );
});
