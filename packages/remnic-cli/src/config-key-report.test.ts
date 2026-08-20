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

test("the documented gap: an exotic key is skipped, not mis-parsed", () => {
  // The escape-aware pattern is exactly the nesting the repo's regex-safety
  // gate rejects, so keys are matched with a bounded [A-Za-z0-9_.-] class. A
  // key with an escaped quote or a space is simply not reported; neighbours
  // still are, which is what matters for a diagnostic.
  const report = reportConfigKeys('{"we\\"ird": 1, "has space": 2, "memoryDir": "/tmp/m"}');
  // No phantom key: the old scanner emitted 'ird' from the dangling fragment.
  assert.ok(!report.keys.includes('ird'), 'a key fragment was reported as a key');
  assert.ok(report.keys.includes('memoryDir'), 'neighbouring keys must still be reported');
  assert.ok(!report.keys.includes('has space'), 'an out-of-charset key is skipped, not guessed');
});
