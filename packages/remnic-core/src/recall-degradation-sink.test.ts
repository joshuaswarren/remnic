/**
 * Pipeline instrumentation test for the recall-miss diagnosis (issue #3033).
 *
 * `RecallInvocationOptions.degradationSink` is the one change this feature
 * makes to the recall path: the pipeline already collected the degradations
 * its searches observed, and now a caller may hand it the array to collect
 * into. This exercises the REAL orchestrator recall — not a stub — so the
 * wiring cannot rot silently, because a diagnosis that cannot see a
 * mid-recall backend failure would report an outage as "no matches"
 * (Review Prevention Checklist #22).
 *
 * Fixture data is synthetic and the store is an empty temp directory.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import type { SearchBackend, SearchDegradation, SearchExecutionOptions } from "./search/port.js";

const DEGRADATION: SearchDegradation = {
  backend: "qmd",
  code: "daemon_timeout",
  detail: "no response within the deadline",
};
/**
 * A backend that answers the availability probe and then degrades on every
 * search — the failure shape a healthy-looking daemon produces under load.
 * Typed as `Partial<SearchBackend>` so every method signature is checked
 * against the real port (Review Prevention Checklist #21: a mock whose
 * signature drifts from production tests nothing).
 */
function degradingBackend(observed: { calls: number }): SearchBackend {
  const degrade = (execution?: SearchExecutionOptions) => {
    observed.calls += 1;
    execution?.onDegradation?.(DEGRADATION);
    return [];
  };
  const backend: Partial<SearchBackend> = {
    async probe() {
      return true;
    },
    isAvailable() {
      return true;
    },
    debugStatus() {
      return "backend=degrading-stub";
    },
    async search(_query, _collection, _maxResults, _options, execution) {
      return degrade(execution);
    },
    async searchGlobal(_query, _maxResults, execution) {
      return degrade(execution);
    },
    async bm25Search(_query, _collection, _maxResults, execution) {
      return degrade(execution);
    },
    async vectorSearch(_query, _collection, _maxResults, execution) {
      return degrade(execution);
    },
    async hybridSearch(_query, _collection, _maxResults, execution) {
      return degrade(execution);
    },
    async update() {},
    async updateCollection() {},
    async embed() {},
    async embedCollection() {},
    async ensureCollection() {
      return "skipped";
    },
  };
  // Unchecked cast with reason: the stub implements only the read surface a
  // recall touches; the rest of the port is never reached here.
  return backend as SearchBackend;
}

/**
 * Both cases boot a real orchestrator, so both must settle deferred init and
 * `destroy()` it before the temp store is removed: background QMD/warmup
 * writes otherwise race the teardown and `rm` fails with ENOTEMPTY under
 * load (the orchestrator's documented shutdown contract).
 */
async function withOrchestrator(
  prefix: string,
  run: (orchestrator: Orchestrator, observed: { calls: number }) => Promise<void>,
): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const orchestrator = new Orchestrator(
    parseConfig({ memoryDir, workspaceDir: memoryDir, qmdEnabled: true, embeddingFallbackEnabled: false }),
  );
  const observed = { calls: 0 };
  // Unchecked cast with reason: `qmd` is assigned post-construction because the
  // backend is built by the search factory, which would reach for a real
  // daemon. Same seam orchestrator-xray-capture.test.ts uses.
  const withBackend = orchestrator as unknown as { qmd: SearchBackend };
  withBackend.qmd = degradingBackend(observed);
  try {
    await orchestrator.initialize();
    await orchestrator.deferredReady;
    await run(orchestrator, observed);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("a caller-supplied degradationSink receives the real recall's backend degradations", async () => {
  await withOrchestrator("remnic-degradation-sink-", async (orchestrator, observed) => {
    const degradationSink: SearchDegradation[] = [];
    const context = await orchestrator.recall(
      "what did we decide about the retention window?",
      "sink-session",
      { degradationSink },
    );

    assert.ok(observed.calls > 0, "the recall must actually have consulted the backend");
    assert.ok(degradationSink.length > 0, "the sink must receive the pipeline's degradations");
    assert.deepEqual(
      degradationSink[0],
      DEGRADATION,
      "entries must be the degradation the backend reported, verbatim",
    );
    assert.ok(
      degradationSink.every((d) => d.code === DEGRADATION.code),
      "no entry may be invented or rewritten by the pipeline",
    );
    // The recall itself still returns an ordinary (here empty) context: the
    // sink observes, it never alters recall behavior.
    assert.equal(typeof context, "string");
  });
});

test("recall works unchanged when no sink is supplied", async () => {
  await withOrchestrator("remnic-degradation-nosink-", async (orchestrator, observed) => {
    // No `degradationSink`: the pipeline allocates its own array as before.
    const context = await orchestrator.recall("what did we decide about retention?", "no-sink");
    assert.equal(typeof context, "string");
    assert.ok(observed.calls > 0, "the recall must still consult the backend");
  });
});
