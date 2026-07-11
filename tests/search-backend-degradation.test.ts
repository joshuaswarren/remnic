import assert from "node:assert/strict";
import test from "node:test";

import { MeilisearchBackend } from "../packages/remnic-core/src/search/meilisearch-backend.js";
import type { SearchDegradation } from "../packages/remnic-core/src/search/port.js";

test("Meilisearch reports a final fail-open search error as degradation", async () => {
  const backend = new MeilisearchBackend({
    host: "http://127.0.0.1:7700",
    collection: "memory",
  });
  const internal = backend as unknown as {
    available: boolean;
    client: { index: () => { search: () => Promise<never> } };
  };
  internal.available = true;
  internal.client = {
    index: () => ({
      search: async () => {
        throw new Error("query failed");
      },
    }),
  };
  const degradations: SearchDegradation[] = [];

  const results = await backend.search("warmup", undefined, 1, undefined, {
    onDegradation: (degradation) => degradations.push(degradation),
  });

  assert.deepEqual(results, []);
  assert.deepEqual(degradations, [
    {
      backend: "meilisearch",
      code: "backend_error",
      detail: "Error",
    },
  ]);
});
