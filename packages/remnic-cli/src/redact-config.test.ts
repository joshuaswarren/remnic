import assert from "node:assert/strict";
import test from "node:test";

import { redactConfigForLog } from "./redact-config.js";

test("redactConfigForLog replaces secret-named keys recursively — including keys it was never told about", () => {
  const redacted = redactConfigForLog({
    model: "gpt-test",
    memoryDir: "/mem",
    openaiApiKey: "redaction-probe-openai",
    localLlmApiKey: "redaction-probe-local",
    // Never enumerated anywhere in the redactor — must be covered by the
    // key-name pattern, not by a literal list.
    anthropicApiKey: "redaction-probe-anthropic",
    remote: { bearerToken: "redaction-probe-token", port: 4318 },
    list: [{ apiKey: "redaction-probe-nested" }],
  });
  assert.equal(redacted.model, "gpt-test");
  assert.equal(redacted.memoryDir, "/mem");
  assert.equal(redacted.remote.port, 4318);
  const serialized = JSON.stringify(redacted);
  for (const probe of [
    "redaction-probe-openai",
    "redaction-probe-local",
    "redaction-probe-anthropic",
    "redaction-probe-token",
    "redaction-probe-nested",
  ]) {
    assert.ok(!serialized.includes(probe), `${probe} must not survive redaction`);
  }
  assert.ok(serialized.includes("[redacted]"));
});

test("redactConfigForLog leaves primitives and secret-free structures untouched", () => {
  assert.equal(redactConfigForLog("plain"), "plain");
  assert.equal(redactConfigForLog(42), 42);
  // Compare via JSON: the redacted copy is null-prototype by construction.
  assert.equal(JSON.stringify(redactConfigForLog({ a: [1, "two"] })), '{"a":[1,"two"]}');
});

test("redactConfigForLog keeps a JSON-parsed __proto__ key as an own redactable property", () => {
  const raw = JSON.parse('{"__proto__": {"password": "redaction-probe-proto"}}');
  const redacted = redactConfigForLog(raw);
  assert.equal(Object.getPrototypeOf(redacted), null);
  assert.equal(JSON.stringify(redacted).includes("redaction-probe-proto"), false);
});
