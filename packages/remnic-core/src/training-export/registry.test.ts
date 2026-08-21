import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import {
  registerTrainingExportAdapter,
  getTrainingExportAdapter,
  listTrainingExportAdapters,
  clearTrainingExportAdapters,
} from "./registry.js";
import type { TrainingExportAdapter } from "./types.js";

function makeAdapter(name: string): TrainingExportAdapter {
  return {
    name,
    fileExtension: ".jsonl",
    formatRecords: (records) => records.map((r) => JSON.stringify(r)).join("\n"),
  };
}

describe("TrainingExportAdapter registry", () => {
  afterEach(() => {
    clearTrainingExportAdapters();
  });

  it("registers and retrieves an adapter by name", () => {
    const adapter = makeAdapter("weclone");
    registerTrainingExportAdapter(adapter);
    assert.equal(getTrainingExportAdapter("weclone"), adapter);
  });

  it("lists registered adapter names", () => {
    registerTrainingExportAdapter(makeAdapter("axolotl"));
    registerTrainingExportAdapter(makeAdapter("mlx"));
    const names = listTrainingExportAdapters();
    assert.deepEqual(names.sort(), ["axolotl", "mlx"]);
  });

  it("returns undefined for an unknown adapter", () => {
    assert.equal(getTrainingExportAdapter("nonexistent"), undefined);
  });

  it("rejects duplicate registration with an error listing registered adapters", () => {
    registerTrainingExportAdapter(makeAdapter("weclone"));
    assert.throws(
      () => registerTrainingExportAdapter(makeAdapter("weclone")),
      (err: Error) => {
        assert.match(err.message, /already registered/);
        assert.match(err.message, /weclone/);
        return true;
      },
    );
  });

  it("rejects empty adapter name", () => {
    assert.throws(
      () => registerTrainingExportAdapter(makeAdapter("")),
      (err: Error) => {
        assert.match(err.message, /non-empty string/);
        return true;
      },
    );
  });

  it("rejects whitespace-only adapter name", () => {
    assert.throws(
      () => registerTrainingExportAdapter(makeAdapter("   ")),
      (err: Error) => {
        assert.match(err.message, /non-empty string/);
        return true;
      },
    );
  });

  it("rejects malformed adapters without mutating the registry", () => {
    assert.throws(
      () => registerTrainingExportAdapter({ name: "no-format" } as unknown as TrainingExportAdapter),
      /formatRecords must be a function/,
    );
    assert.throws(
      () => registerTrainingExportAdapter({
        name: "bad-ext",
        formatRecords: () => "",
        fileExtension: "",
      } as unknown as TrainingExportAdapter),
      /fileExtension must be a non-empty extension/,
    );

    assert.deepEqual(listTrainingExportAdapters(), []);
  });

  it("trims adapter name on lookup", () => {
    registerTrainingExportAdapter(makeAdapter("axolotl"));
    assert.ok(getTrainingExportAdapter("  axolotl  "));
  });

  it("clearTrainingExportAdapters removes all entries", () => {
    registerTrainingExportAdapter(makeAdapter("a"));
    registerTrainingExportAdapter(makeAdapter("b"));
    clearTrainingExportAdapters();
    assert.deepEqual(listTrainingExportAdapters(), []);
  });
});
