import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import type { Orchestrator } from "./orchestrator.js";
import type { SearchBackend } from "./search/port.js";

function makeQmd(): SearchBackend {
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

function fakeStorage() {
  return {
    loadBuffer: async () => ({ turns: [], lastExtractionAt: null, extractionCount: 0 }),
    saveBuffer: async () => {},
  };
}

test("health exposes bufferIngress at the TOP LEVEL, outside extraction", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-ingress-"));
  try {
    const config = parseConfig({ memoryDir, bufferSaveDebounceMs: 0 });
    const buffer = new SmartBuffer(config, fakeStorage() as never);
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
    const service = new EngramAccessService({
      config,
      qmd: makeQmd(),
      async getStorage() {
        return { dir: memoryDir };
      },
      buffer,
    } as unknown as Orchestrator);

    const health = await service.health();
    assert.ok(health.bufferIngress, "bufferIngress must be present");
    assert.deepEqual(health.bufferIngress.totals.accepted, { turns: 2, chars: 2 * "observed turn".length });
    // Observational sub-count of accepted: the re-offer is appended AND counted.
    assert.deepEqual(health.bufferIngress.totals.acceptedExactDuplicate, { turns: 1, chars: "observed turn".length });
    assert.equal(health.bufferIngress.hours.length, 1);
    assert.ok(!("bufferIngress" in (health.extraction as object)), "must NOT live inside extraction");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health reports a zeroed bufferIngress when the host has no buffer", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-ingress-none-"));
  try {
    const config = parseConfig({ memoryDir });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd(),
      async getStorage() {
        return { dir: memoryDir };
      },
    } as unknown as Orchestrator);

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
