
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
  return backend as SearchBackend;
}

async function withOrchestrator(
  prefix: string,
  run: (orchestrator: Orchestrator, observed: { calls: number }) => Promise<void>,
): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const orchestrator = new Orchestrator(
    parseConfig({ memoryDir, workspaceDir: memoryDir, qmdEnabled: true, embeddingFallbackEnabled: false }),
  );
  const observed = { calls: 0 };
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
    assert.equal(typeof context, "string");
  });
});

test("recall works unchanged when no sink is supplied", async () => {
  await withOrchestrator("remnic-degradation-nosink-", async (orchestrator, observed) => {
    const context = await orchestrator.recall("what did we decide about retention?", "no-sink");
    assert.equal(typeof context, "string");
    assert.ok(observed.calls > 0, "the recall must still consult the backend");
  });
});
