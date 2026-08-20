import assert from "node:assert/strict";
import test from "node:test";

import { formatConfigKeyReport, reportConfigKeys } from "./config-key-report.js";

const SECRET = "value-that-must-never-print";

const SAMPLE = JSON.stringify({
  plugins: {
    entries: {
      remnic: {
        openaiApiKey: "${OPENAI_API_KEY}",
        localLlmApiKey: SECRET,
        // A key this module was never told about.
        anthropicApiKey: SECRET,
        memoryDir: "/tmp/m",
        port: 4318,
      },
    },
  },
});

test("no value reaches the output, including from unknown secret-named keys", () => {
  const rendered = formatConfigKeyReport(reportConfigKeys(SAMPLE));
  for (const value of [SECRET, "/tmp/m", "4318", "OPENAI_API_KEY"]) {
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

// The whole point of this module: it runs when the file did NOT parse. A
// value followed by a colon must never be mistaken for a key.
test("a value followed by a colon is never reported as a key", () => {
  const malformed = `{"openaiApiKey":"${SECRET}":}`;
  const report = reportConfigKeys(malformed);
  assert.ok(!report.keys.includes(SECRET), "the secret value was reported as a key");
  assert.deepEqual(report.keys, ["openaiApiKey"]);
  assert.ok(!formatConfigKeyReport(report).includes(SECRET));
});

test("key-like text in a comment or trailing garbage is not reported", () => {
  for (const malformed of [
    `{"a":1} // "${SECRET}":`,
    `{"a":1, /* "${SECRET}": */ }`,
    `["${SECRET}":]`,
    `{"a": ["${SECRET}":, "${SECRET}":]}`,
  ]) {
    const report = reportConfigKeys(malformed);
    assert.ok(!report.keys.includes(SECRET), `leaked from: ${malformed}`);
    assert.ok(!formatConfigKeyReport(report).includes(SECRET), `rendered leak from: ${malformed}`);
  }
});

test("array elements are values, never keys", () => {
  const report = reportConfigKeys(`{"list": ["${SECRET}", {"inner": 1}]}`);
  assert.deepEqual(report.keys, ["inner", "list"]);
});

test("an unterminated string stops the scan instead of guessing", () => {
  const report = reportConfigKeys(`{"openaiApiKey": "${SECRET}`);
  assert.equal(report.truncated, true);
  assert.deepEqual(report.keys, ["openaiApiKey"]);
  assert.ok(!formatConfigKeyReport(report).includes(SECRET));
});

test("keys are sorted, de-duplicated, and capped; unresolved stays within them", () => {
  assert.deepEqual(reportConfigKeys('{"a":{"b":1},"c":{"b":2},"a2":3}').keys, ["a", "a2", "b", "c"]);
  const many = `{${Array.from({ length: 50 }, (_, i) => `"k${i}":"\${V${i}}"`).join(",")}}`;
  const capped = reportConfigKeys(many, 10);
  assert.equal(capped.keys.length, 10);
  assert.equal(capped.truncated, true);
  // Review: unresolved must not accumulate beyond the reported keys, or
  // formatting degrades to maxKeys x unresolved comparisons.
  assert.ok(capped.unresolved.length <= capped.keys.length, "unresolved outgrew the reported keys");
  for (const key of capped.unresolved) assert.ok(capped.keys.includes(key));
});

test("malformed or empty text does not throw", () => {
  assert.deepEqual(reportConfigKeys(""), { keys: [], unresolved: [], truncated: false });
  assert.deepEqual(reportConfigKeys("   "), { keys: [], unresolved: [], truncated: false });
  assert.deepEqual(reportConfigKeys('{"openaiApiKey": "${X}", "half":').keys, ["half", "openaiApiKey"]);
  assert.equal(formatConfigKeyReport({ keys: [], unresolved: [], truncated: false }), "  (no config keys found)");
  assert.equal(formatConfigKeyReport({ keys: [], unresolved: [], truncated: true }), "  (config could not be scanned)");
});

test("an out-of-charset key is skipped, not guessed at", () => {
  const report = reportConfigKeys('{"we\\"ird": 1, "has space": 2, "memoryDir": "/tmp/m"}');
  assert.ok(!report.keys.includes("ird"), "a fragment was reported as a key");
  assert.ok(!report.keys.some((key) => key.includes(" ")), "an out-of-charset key was reported");
  assert.ok(report.keys.includes("memoryDir"), "neighbouring keys must still be reported");
});

test("scanning a large malformed file stays fast", () => {
  const hostile = `{"a":${'"x":'.repeat(20_000)}`;
  const startedAt = Date.now();
  const report = reportConfigKeys(hostile);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 1000, `scan took ${elapsedMs}ms`);
  assert.ok(!formatConfigKeyReport(report).includes(SECRET));
});

// A value must never print, however malformed the file is. Every input here
// places the secret in a VALUE position (or inside garbage); a secret-shaped
// KEY name is a different thing and is reported by design.
test("adversarial sweep: no value-position secret ever prints", () => {
  const S = "SECRETVALUE";
  const corpus = [
    `{"k":"${S}"}`,
    `{"k":"${S}":}`,
    `{"a":1, /* "${S}": */ }`,
    `{"a":1} // "${S}":`,
    `["${S}":]`,
    `[{"a":["${S}":]}]`,
    `{"a":{"b":"${S}"}}`,
    `{"a":"${S}"`,
    `{"a":\n"${S}"\n:}`,
    `{"a":[1,2,"${S}"],"b":{"c":"${S}"}}`,
    `{"\\u006b":"${S}"}`,
    `{"a" : "${S}" , "b":1}`,
    `{"a":tru"${S}":}`,
    `{"a":1,"b":}"${S}":`,
    `{"a":"${S}","a":"${S}"}`,
    `{"a":["${S}"],"b":["${S}":]}`,
    `{"a":{"b":{"c":"${S}":}}}`,
    `{"a":"\\"${S}\\""}`,
  ];
  const leaks = corpus.filter((input) => formatConfigKeyReport(reportConfigKeys(input)).includes(S));
  assert.deepEqual(leaks, [], `inputs that leaked: ${JSON.stringify(leaks)}`);
});

// Review round 3: an invalid scalar let a later '{' open what looked like a
// nested object, so a value-position string after it was read as a key.
test("an invalid scalar stops the scan instead of resyncing on later braces", () => {
  const S = "value-that-must-never-print";
  const hostile = `{"openaiApiKey":oops${" ".repeat(200)}{"${S}":0}}`;
  const report = reportConfigKeys(hostile);
  assert.ok(!report.keys.includes(S), "the secret was reported as a key");
  assert.deepEqual(report.keys, ["openaiApiKey"]);
  assert.equal(report.truncated, true);
  assert.ok(!formatConfigKeyReport(report).includes(S));
});

test("valid scalars still scan through", () => {
  const report = reportConfigKeys('{"a":1,"b":-2.5,"c":1e3,"d":true,"e":false,"f":null,"g":{"h":0}}');
  assert.deepEqual(report.keys, ["a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.equal(report.truncated, false);
});

test("a unicode-escaped key is reported, not silently dropped", () => {
  // readString previously advanced a fixed 2 characters past any backslash,
  // leaving the four hex digits of \uXXXX in the value so the key failed the
  // charset test and vanished from the report.
  const report = reportConfigKeys('{"port\\u0031": 1, "memoryDir": "/tmp/m"}');
  assert.ok(report.keys.includes("memoryDir"));
  assert.ok(!report.keys.some((key) => key.includes("0031")), "escape digits leaked into the key name");
});
