import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { SmartBuffer } from "./buffer.js";
import { NamespaceStorageRouter } from "./namespaces/storage.js";
import { parseConfig } from "./config.js";
import type { Orchestrator } from "./orchestrator.js";
import type { SearchBackend } from "./search/port.js";

function makeQmd(): SearchBackend {
  // SAFETY: stub implements the full SearchBackend surface the health path touches; every method is a no-op returning the empty shape.
  return {
    probe: async () => false,
    isAvailable: () => false,
    debugStatus: () => "backend=noop",
    search: async () => [],
    searchGlobal: async () => [],
    bm25Search: async () => [],
    vectorSearch: async () => [],
    hybridSearch: async () => [],
    update: async () => {},
    updateCollection: async () => {},
    embed: async () => {},
    embedCollection: async () => {},
    ensureCollection: async () => "skipped",
  } as SearchBackend;
}

// SAFETY: implements BufferStorage for the health tests; saveBuffer is a no-op because these tests never persist.
function fakeStorage(): import("./buffer-persistence.js").BufferStorage {
  return {
    loadBuffer: async () => ({ turns: [], lastExtractionAt: null, extractionCount: 0 }),
    saveBuffer: async () => {},
  };
}

test("health exposes bufferIngress at the TOP LEVEL, outside extraction", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-ingress-"));
  try {
    const config = parseConfig({ memoryDir, bufferSaveDebounceMs: 0 });
    const buffer = new SmartBuffer(config, fakeStorage());
    await buffer.addTurn("s1", {
      role: "user",
      content: "observed turn",
      timestamp: "2026-11-15T12:00:00.000Z",
      sessionKey: "s1",
    });
    await buffer.addTurn("s1", {
      role: "user",
      content: "observed turn",
      timestamp: "2026-11-15T12:00:00.000Z",
      sessionKey: "s1",
    }); // duplicate
    // SAFETY: the health tests drive only config/buffer/getStorage; qmd and the rest of Orchestrator are unreachable here.
    const storageRouter = new NamespaceStorageRouter(config);
    const dependencies: Pick<Orchestrator, "config" | "qmd" | "getStorage" | "buffer"> = {
      config,
      qmd: makeQmd(),
      getStorage: (namespace) => storageRouter.storageFor(namespace ?? config.defaultNamespace),
      buffer,
    };
    // SAFETY: the health tests drive only config, qmd, getStorage and buffer (the Pick
    // above); the rest of the Orchestrator is unused here.
    const service = new EngramAccessService(dependencies as Orchestrator);

    const health = await service.health();
    assert.ok(health.bufferIngress, "bufferIngress must be present");
    assert.deepEqual(health.bufferIngress.totals.accepted, { turns: 2, chars: 2 * "observed turn".length });
    // Observational sub-count of accepted: the re-offer is appended AND counted.
    assert.deepEqual(health.bufferIngress.totals.acceptedExactDuplicate, { turns: 1, chars: "observed turn".length });
    assert.equal(health.bufferIngress.hours.length, 1);
    // `extraction` is the typed ExtractionLivenessStatus field of the health contract; the TOP-LEVEL
    // placement of bufferIngress is structural, so assert the key sets are disjoint by shape, not by `in`.
    const extractionKeys = Object.keys(health.extraction);
    assert.ok(!extractionKeys.includes("bufferIngress"), "must NOT live inside extraction");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health reports a zeroed bufferIngress when the host has no buffer", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-ingress-none-"));
  try {
    const config = parseConfig({ memoryDir });
    // SAFETY: the health tests drive only config/buffer/getStorage; qmd and the rest of Orchestrator are unreachable here.
    const storageRouter = new NamespaceStorageRouter(config);
    const dependencies: Pick<Orchestrator, "config" | "qmd" | "getStorage"> = {
      config,
      qmd: makeQmd(),
      getStorage: (namespace) => storageRouter.storageFor(namespace ?? config.defaultNamespace),
    };
    // SAFETY: the bufferless-health test drives only config, qmd and getStorage (the Pick
    // above); the rest of the Orchestrator is unused here.
    const service = new EngramAccessService(dependencies as Orchestrator);

    const health = await service.health();
    assert.deepEqual(health.bufferIngress, {
      totals: {
        accepted: { turns: 0, chars: 0 },
        acceptedExactDuplicate: { turns: 0, chars: 0 },
        filtered: { turns: 0, chars: 0 },
        refused: { turns: 0, chars: 0 },
      },
      hours: [],
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
