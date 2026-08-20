import assert from "node:assert/strict";
import test from "node:test";

import { formatConfigKeyReport, reportConfigKeys } from "./config-key-report.js";

const SAMPLE = JSON.stringify({
  plugins: {
    entries: {
      remnic: {
        openaiApiKey: "${OPENAI_API_KEY}",
        localLlmApiKey: "value-that-must-never-print",
        // A key this module was never told about.
        anthropicApiKey: "another-value-that-must-never-print",
        memoryDir: "/tmp/m",
        port: 4318,
      },
    },
  },
});

test("no value reaches the output, including from unknown secret-named keys", () => {
  const rendered = formatConfigKeyReport(reportConfigKeys(SAMPLE));
  for (const value of ["value-that-must-never-print", "another-value-that-must-never-print", "/tmp/m", "4318", "OPENAI_API_KEY"]) {
    assert.ok(!rendered.includes(value), `value leaked: ${value}`);
  }
  for (const key of ["openaiApiKey", "localLlmApiKey", "anthropicApiKey", "memoryDir", "port"]) {
    assert.ok(rendered.includes(key), `key missing: ${key}`);
  }
});

test("the failing key is named", () => {
  const report = reportConfigKeys(SAMPLE);
  assert.deepEqual(report.unresolved, ["openaiApiKey"]);
  assert.match(formatConfigKeyReport(report), /openaiApiKey \(unresolved \$\{\.\.\.\} placeholder\)/);
});

test("keys are sorted, de-duplicated, and capped", () => {
  const dupes = '{"a":{"b":1},"c":{"b":2},"a2":3}';
  assert.deepEqual(reportConfigKeys(dupes).keys, ["a", "a2", "b", "c"]);
  const wide = `{${Array.from({ length: 50 }, (_, i) => `"k${i}":${i}`).join(",")}}`;
  assert.equal(reportConfigKeys(wide, 10).keys.length, 10);
});

test("malformed or empty text does not throw", () => {
  assert.deepEqual(reportConfigKeys(""), { keys: [], unresolved: [] });
  assert.deepEqual(reportConfigKeys("   "), { keys: [], unresolved: [] });
  // Truncated JSON is the common case: the file failed to parse, after all.
  assert.deepEqual(reportConfigKeys('{"openaiApiKey": "${X}", "half":').keys, ["half", "openaiApiKey"]);
  assert.equal(formatConfigKeyReport({ keys: [], unresolved: [] }), "  (no config keys found)");
});

test("an escaped quote inside a key does not split it", () => {
  assert.deepEqual(reportConfigKeys('{"we\\"ird": 1}').keys, ['we\\"ird']);
});
