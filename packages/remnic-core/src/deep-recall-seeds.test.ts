/**
 * Deep-recall seed-search wiring regressions (issue #2915).
 *
 * The seed search must forward the transport cancellation signal into the
 * namespace search router, and keep asking the router for exactly the capped
 * candidate set (`maxResults`), resolving each returned hit per hit — never
 * pre-scanning the namespace corpus.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createDeepRecallSeedSearch } from "./deep-recall-seeds.js";
import type { DeepRecallSeedRouter } from "./deep-recall-seeds.js";

test("seed search forwards the cancellation signal and the capped limit to the router (issue #2915)", async () => {
  const controller = new AbortController();
  type RouterCall = Parameters<DeepRecallSeedRouter["searchAcrossNamespaces"]>[0];
  let captured: RouterCall | undefined;
  let resolverCalls = 0;
  const router: DeepRecallSeedRouter = {
    async searchAcrossNamespaces(options) {
      captured = options;
      return [
        { path: "facts/2026-08-23/fact-one.md", docid: "doc-1", score: 0.9 },
        { path: "facts/2026-08-23/fact-two.md", docid: "doc-2", score: 0.8 },
      ];
    },
  };
  const searchSeed = createDeepRecallSeedSearch({
    namespace: "ns_signals",
    storage: { dir: "/synthetic/ns_signals", readMemoryByPath: async () => null },
    router,
    resolver: {
      async readQmdResultMemory() {
        resolverCalls += 1;
        return { frontmatter: { id: `fact-${resolverCalls}` } };
      },
    },
    signal: controller.signal,
  });

  const seeds = await searchSeed("payments routing", 2);

  assert.deepEqual(seeds, [
    { memoryId: "fact-1", score: 0.9 },
    { memoryId: "fact-2", score: 0.8 },
  ]);
  assert.equal(captured?.namespaces?.[0], "ns_signals");
  assert.equal(captured?.maxResults, 2, "the router is asked for the capped candidate set, not the corpus");
  assert.equal(captured?.execution?.signal, controller.signal, "the transport signal reaches the search router");
  assert.equal(resolverCalls, 2, "each returned hit is resolved per hit");
});
