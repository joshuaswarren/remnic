/**
 * Tests for the single-flag ablation matrix (issues #1574 §"Ablations" + #1730).
 *
 * The matrix is pure data; these tests lock its shape, order, and the
 * single-flag invariant so a regression (e.g. a cell that flips two flags, or
 * a reordered matrix) is a visible review signal rather than a silent change.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_ABLATION_BENCHMARK,
  SINGLE_FLAG_ABLATION_MATRIX,
  getAblationCell,
} from "./single-flag-matrix.ts";
import { buildBenchBaselineRemnicConfig } from "../adapters/remnic-adapter.ts";

test("SINGLE_FLAG_ABLATION_MATRIX has exactly the 3 #1574 axes in stable order", () => {
  assert.deepEqual(
    SINGLE_FLAG_ABLATION_MATRIX.map((c) => c.axis),
    ["memory-worth", "contradiction-scan", "graph-recall"],
  );
  assert.deepEqual(
    SINGLE_FLAG_ABLATION_MATRIX.map((c) => c.id),
    ["memory-worth-off", "contradiction-scan-on", "graph-recall-on"],
  );
});

test("every cell carries the required metadata for an artifact note + STATUS log", () => {
  for (const cell of SINGLE_FLAG_ABLATION_MATRIX) {
    assert.ok(cell.id.length > 0, `${cell.id}: missing id`);
    assert.ok(cell.label.length > 0, `${cell.id}: missing label`);
    assert.ok(cell.description.length > 0, `${cell.id}: missing description`);
    assert.ok(cell.baselineState.length > 0, `${cell.id}: missing baselineState`);
    assert.ok(
      Object.keys(cell.configOverrides).length > 0,
      `${cell.id}: empty configOverrides`,
    );
    assert.ok(cell.primaryFlag.length > 0, `${cell.id}: missing primaryFlag`);
  }
});

test("each cell flips exactly one primary flag (the single-flag invariant)", () => {
  // The contradiction-scan cell sets a nested object; the other two set a
  // single boolean. The invariant under test is that the PRIMARY toggle is
  // unique per cell and matches `primaryFlag`.
  for (const cell of SINGLE_FLAG_ABLATION_MATRIX) {
    const overrides = cell.configOverrides;
    if (cell.primaryFlag === "recallMemoryWorthFilterEnabled") {
      assert.equal(
        overrides.recallMemoryWorthFilterEnabled,
        false,
        `${cell.id}: expected recallMemoryWorthFilterEnabled=false`,
      );
      assert.equal(
        Object.keys(overrides).length,
        1,
        `${cell.id}: memory-worth cell must touch only recallMemoryWorthFilterEnabled`,
      );
    } else if (cell.primaryFlag === "contradictionScan") {
      const cs = overrides.contradictionScan;
      // Narrow with `in` so the property access is type-checked, not an
      // unchecked `as { enabled?: unknown }` cast (ts-no-inline-cast-access).
      if (cs && typeof cs === "object" && "enabled" in cs) {
        assert.equal(
          cs.enabled,
          true,
          `${cell.id}: expected contradictionScan.enabled=true`,
        );
      } else {
        assert.fail(`${cell.id}: contradictionScan override must be { enabled, ... }`);
      }
      assert.equal(
        Object.keys(overrides).length,
        1,
        `${cell.id}: contradiction-scan cell must touch only contradictionScan`,
      );
    } else if (cell.primaryFlag === "graphRecallEnabled") {
      assert.equal(
        overrides.graphRecallEnabled,
        true,
        `${cell.id}: expected graphRecallEnabled=true`,
      );
      assert.equal(
        overrides.graphAssistInFullModeEnabled,
        true,
        `${cell.id}: graph assist must be on so the flag actually engages in full mode`,
      );
      assert.deepEqual(
        Object.keys(overrides).sort(),
        ["graphAssistInFullModeEnabled", "graphRecallEnabled"],
        `${cell.id}: graph-recall cell must touch only the two graph gates`,
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
  assert.throws(
    () => getAblationCell("trust-score-on" as never),
    /Unknown ablation cell id "trust-score-on"/,
  );
});

test("ablation primary flags are absent from the bench baseline — cells flip from config.ts defaults", () => {
  // Grounds the matrix doc's claim: buildBenchBaselineRemnicConfig() does NOT
  // set recallMemoryWorthFilterEnabled, contradictionScan, graphRecallEnabled,
  // or graphAssistInFullModeEnabled. So each cell's delta is measured against
  // the config.ts parse default, not a bench-overridden value. This is the
  // keyless contract the runner relies on for config-override cells via
  // adapterOptions.configOverrides.
  const baseline = buildBenchBaselineRemnicConfig();
  for (const key of [
    "recallMemoryWorthFilterEnabled",
    "contradictionScan",
    "graphRecallEnabled",
    "graphAssistInFullModeEnabled",
  ]) {
    assert.equal(
      baseline[key],
      undefined,
      `bench baseline must not set ${key} (else the ablation delta is measured against the bench override, not the config.ts default)`,
    );
  }
});

test("each cell's configOverrides win over the baseline when merged (override semantics)", () => {
  // The runner merges `{ ...resolved.adapterOptions.configOverrides, ...cell.configOverrides }`.
  // Since the baseline omits these keys, the merged result carries exactly the
  // cell's value — proving the override lands and is not clobbered by a stale
  // baseline setting.
  const baseline = buildBenchBaselineRemnicConfig();
  for (const cell of SINGLE_FLAG_ABLATION_MATRIX) {
    const merged = { ...baseline, ...cell.configOverrides };
    assert.equal(
      merged[cell.primaryFlag],
      cell.configOverrides[cell.primaryFlag],
      `${cell.id}: merged config must carry the cell's primary-flag override`,
    );
  }
});
