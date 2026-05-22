import assert from "node:assert/strict";
import test from "node:test";

import {
  clearMemoryCache,
  getCachedQmdSearch,
  setCachedQmdSearch,
} from "./memory-cache.js";

test("scoped memory cache invalidation clears QMD search results", () => {
  clearMemoryCache();
  setCachedQmdSearch("qmd-cache-key", [{ path: "deleted.md" }]);

  assert.deepEqual(getCachedQmdSearch("qmd-cache-key"), [{ path: "deleted.md" }]);

  clearMemoryCache("/tmp/remnic-memory");

  assert.equal(getCachedQmdSearch("qmd-cache-key"), null);
});
