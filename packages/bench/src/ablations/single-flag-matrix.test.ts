/**
 * Tests for the single-flag ablation matrix (issues #1574 §"Ablations" + #1730).
 *
 * The matrix is pure data; these tests lock its shape, order, and the
 * single-flag invariant so a regression (e.g. a cell that flips two flags, or
 * a reordered matrix) is a visible review signal rather than a silent change.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBenchBaselineRemnicConfig } from "../adapters/remnic-adapter.ts";
import { parseConfig } from "@remnic/core";
import { DEFAULT_ABLATION_BENCHMARK, SINGLE_FLAG_ABLATION_MATRIX, getAblationCell } from "./single-flag-matrix.ts";

test("SINGLE_FLAG_ABLATION_MATRIX has exactly the 3 #1574 axes in stable order", () => {
  assert.deepEqual(
    SINGLE_FLAG_ABLATION_MATRIX.map((c) => c.axis),
    ["memory-worth", "contradiction-scan", "graph-recall"]
  );
  assert.deepEqual(
    SINGLE_FLAG_ABLATION_MATRIX.map((c) => c.id),
    ["memory-worth-off", "contradiction-scan-on", "graph-recall-on"]
  );
});

test("every cell carries the required metadata for an artifact note + STATUS log", () => {
  for (const cell of SINGLE_FLAG_ABLATION_MATRIX) {
    assert.ok(cell.id.length > 0, `${cell.id}: missing id`);
    assert.ok(cell.label.length > 0, `${cell.id}: missing label`);
    assert.ok(cell.description.length > 0, `${cell.id}: missing description`);
    assert.ok(cell.baselineState.length > 0, `${cell.id}: missing baselineState`);
    assert.ok(Object.keys(cell.configOverrides).length > 0, `${cell.id}: empty configOverrides`);
    assert.ok(cell.primaryFlag.length > 0, `${cell.id}: missing primaryFlag`);
  }
});

test("each cell flips exactly one primary flag (the single-flag invariant)", () => {
  for (const cell of SINGLE_FLAG_ABLATION_MATRIX) {
    const overrides = cell.configOverrides;
    if (cell.primaryFlag === "recallMemoryWorthFilterEnabled") {
      assert.equal(
        overrides.recallMemoryWorthFilterEnabled,
        false,
        `${cell.id}: expected recallMemoryWorthFilterEnabled=false`
      );
      assert.equal(
        Object.keys(overrides).length,
        1,
        `${cell.id}: memory-worth cell must touch only recallMemoryWorthFilterEnabled`
      );
    } else if (cell.primaryFlag === "contradictionDetectionEnabled") {
      assert.equal(
        overrides.contradictionDetectionEnabled,
        true,
        `${cell.id}: expected contradictionDetectionEnabled=true`
      );
      assert.equal(
        Object.keys(overrides).length,
        1,
        `${cell.id}: contradiction-scan cell must touch only contradictionDetectionEnabled`
      );
    } else if (cell.primaryFlag === "graphRecallEnabled") {
      assert.equal(overrides.graphRecallEnabled, true, `${cell.id}: expected graphRecallEnabled=true`);
      assert.equal(
        overrides.multiGraphMemoryEnabled,
        true,
        `${cell.id}: multiGraphMemoryEnabled required too — orchestrator.ts §1379 skips graph_mode without it`
      );
      assert.equal(
        overrides.graphAssistInFullModeEnabled,
        true,
        `${cell.id}: graph assist must be on so the flag actually engages in full mode`
      );
      assert.deepEqual(
        Object.keys(overrides).sort(),
        ["graphAssistInFullModeEnabled", "graphRecallEnabled", "multiGraphMemoryEnabled"],
        `${cell.id}: graph-recall cell must touch only the three graph gates`
      );
    } else {
      assert.fail(`unknown primaryFlag ${cell.primaryFlag} on cell ${cell.id}`);
    }
  }
});

test("the three cells are mutually exclusive — no two cells share a primary flag", () => {
  const flags = SINGLE_FLAG_ABLATION_MATRIX.map((c) => c.primaryFlag);
  assert.equal(new Set(flags).size, flags.length, "primary flags must be unique");
});

test("DEFAULT_ABLATION_BENCHMARK is a published benchmark covered by the #1574 baseline", () => {
  assert.equal(DEFAULT_ABLATION_BENCHMARK, "locomo");
});

test("getAblationCell returns the cell for a known id", () => {
  const cell = getAblationCell("graph-recall-on");
  assert.equal(cell.axis, "graph-recall");
});

test("getAblationCell throws on unknown id (fail fast at the runner boundary)", () => {
  assert.throws(() => getAblationCell("trust-score-on" as never), /Unknown ablation cell id "trust-score-on"/);
});

test("each cell's override actually changes the merged config vs the bench baseline (non-no-op)", () => {
  const baseline = buildBenchBaselineRemnicConfig();
  for (const cell of SINGLE_FLAG_ABLATION_MATRIX) {
    const cellValue = cell.configOverrides[cell.primaryFlag];
    assert.notEqual(
      baseline[cell.primaryFlag],
      cellValue,
      `${cell.id}: baseline already has ${cell.primaryFlag}=${String(cellValue)} — the cell would be a no-op ablation`
    );
  }
});

test("each cell's override differs from the config.ts parsed default (catches silent default drift)", () => {
  const defaults = parseConfig({});
  for (const cell of SINGLE_FLAG_ABLATION_MATRIX) {
    const cellValue = cell.configOverrides[cell.primaryFlag] as boolean;
    const defaultValue = defaults[cell.primaryFlag] as boolean;
    assert.notEqual(
      defaultValue,
      cellValue,
      `${cell.id}: config.ts default for ${cell.primaryFlag} is already ${String(cellValue)} — the cell would be a no-op against the parsed default`
    );
  }
});
test("each cell's configOverrides win over the baseline when merged (override semantics)", () => {
  const baseline = buildBenchBaselineRemnicConfig();
  for (const cell of SINGLE_FLAG_ABLATION_MATRIX) {
    const merged = { ...baseline, ...cell.configOverrides };
    assert.equal(
      merged[cell.primaryFlag],
      cell.configOverrides[cell.primaryFlag],
      `${cell.id}: merged config must carry the cell's primary-flag override`
    );
  }
});
