import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("successful qmd fetches refresh the cache even when no hits are returned", async () => {
  // #1526 seam 18: the qmd fetch/cache block lives in
  // orchestration/recall-internal.ts (moved out of orchestrator.ts).
  const source = await readFile(
    new URL("../packages/remnic-core/src/orchestration/recall-internal.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    source.includes("setCachedQmdRecall(qmdCacheKey, result, {"),
    true,
  );
  assert.equal(
    source.includes(
      "if (augmentedResults.length > 0 || result.globalResults.length > 0) {\n            setCachedQmdRecall(qmdCacheKey, result, {",
    ),
    false,
  );
});
