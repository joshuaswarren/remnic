import assert from "node:assert/strict";
import test from "node:test";

import { QmdClient } from "./qmd.js";
import type { QmdSearchResult } from "./types.js";

test("QmdClient rechecks daemon availability before returning unavailable", async () => {
  const client = new QmdClient("memories", 3, {
    daemonUrl: "stdio://qmd",
    daemonRecheckIntervalMs: 0,
  });
  const internals = client as unknown as {
    available: boolean;
    daemonAvailable: boolean;
    probeDaemon: () => Promise<boolean>;
    searchViaDaemon: (
      query: string,
      collection: string | undefined,
      maxResults: number,
    ) => Promise<QmdSearchResult[]>;
  };
  let probeCount = 0;
  internals.available = false;
  internals.daemonAvailable = false;
  internals.probeDaemon = async () => {
    probeCount += 1;
    internals.daemonAvailable = true;
    return true;
  };
  internals.searchViaDaemon = async (query, collection, maxResults) => [
    {
      docid: `${collection}:${maxResults}`,
      path: "memory.md",
      snippet: query,
      score: 1,
      transport: "daemon",
    },
  ];

  const results = await client.search("slow startup", "memories", 3);

  assert.equal(probeCount, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.transport, "daemon");
});
