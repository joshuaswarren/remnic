import assert from "node:assert/strict";
import test from "node:test";

import { describeConfigShape, formatConfigShape } from "./describe-config-shape.js";

test("no value ever appears in the output", () => {
  const secretish = "sk-not-a-real-key-0123456789";
  const config = {
    openaiApiKey: secretish,
    localLlmApiKey: secretish,
    // A key the helper was never told about: values are never read, so this
    // needs no pattern entry.
    anthropicApiKey: secretish,
    nested: { deeper: { bearerToken: secretish } },
    memoryDir: "/tmp/x",
    port: 4318,
    enabled: true,
    missing: null,
    list: [secretish, { innerSecret: secretish }],
  };
  const rendered = formatConfigShape(describeConfigShape(config));
  assert.doesNotMatch(rendered, /sk-not-a-real-key/, "a config value reached the output");
  assert.doesNotMatch(rendered, /\/tmp\/x/, "even a non-secret value must not be printed");
  assert.doesNotMatch(rendered, /4318/);
  // The diagnosis survives: every key path is still named.
  for (const path of ["openaiApiKey", "anthropicApiKey", "nested.deeper.bearerToken", "list[1].innerSecret"]) {
    assert.match(rendered, new RegExp(path.replace(/[.[\]]/g, "\\$&")), `missing path ${path}`);
  }
});

test("unresolved placeholders are named, and only by shape", () => {
  const entries = describeConfigShape({
    openaiApiKey: "${OPENAI_API_KEY}",
    localLlmApiKey: "${LOCAL_KEY:-fallback}",
    resolved: "an-actual-value",
  });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("openaiApiKey")?.unresolvedPlaceholder, true);
  assert.equal(byPath.get("localLlmApiKey")?.unresolvedPlaceholder, true);
  assert.equal(byPath.get("resolved")?.unresolvedPlaceholder, undefined);
  const rendered = formatConfigShape(entries);
  assert.doesNotMatch(rendered, /an-actual-value/);
  assert.doesNotMatch(rendered, /OPENAI_API_KEY/, "the placeholder body is a value too");
});

test("kinds, ordering, and the entry cap", () => {
  const entries = describeConfigShape({ b: 1, a: { c: [true, null] } });
  assert.deepEqual(
    entries.map((entry) => `${entry.path}:${entry.kind}`),
    ["a:object", "a.c:array", "a.c[0]:boolean", "a.c[1]:null", "b:number"],
  );
  const wide: Record<string, number> = {};
  for (let i = 0; i < 50; i += 1) wide[`k${i}`] = i;
  assert.equal(describeConfigShape(wide, 10).length, 10, "the cap bounds a huge config dump");
  assert.equal(formatConfigShape([]), "  (config is empty)");
});

test("a primitive or empty config does not crash", () => {
  assert.deepEqual(describeConfigShape({}), []);
  assert.deepEqual(describeConfigShape("just a string"), []);
  assert.deepEqual(describeConfigShape(null), []);
});
