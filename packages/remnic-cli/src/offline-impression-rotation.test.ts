import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveOfflineImpressionRotation } from "./offline-impression-rotation.js";

// A value a hostile/typo'd config might put where a rotation number belongs. It
// stands in for an operator secret (API key) that parseConfig would otherwise
// stringify verbatim into its thrown error message.
const SECRET = "sk-super-secret-api-key-0000";

test("resolves the writer's configured rotation bounds from a valid config (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-rotation-config-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ recallImpressionsRotateBytes: 12345, recallImpressionsRotateKeep: 7 }),
    "utf-8",
  );

  assert.deepEqual(resolveOfflineImpressionRotation(configPath), {
    impressionsRotateBytes: 12345,
    impressionsRotateKeep: 7,
  });
});

test("falls back to the writer defaults (not rotation-off) when the config is absent (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-rotation-missing-"));
  const rotation = resolveOfflineImpressionRotation(path.join(dir, "does-not-exist.json"));
  // The writer default is 32 MiB; 0 would silently disable rotation during a
  // pre-sync drain, the exact regression #2033 guards against.
  assert.equal(rotation.impressionsRotateBytes, 32 * 1024 * 1024);
  assert.ok(rotation.impressionsRotateKeep >= 1, "keep must floor at 1");
});

test("a config validation failure is redacted to a generic error, never the raw value (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-rotation-validation-"));
  const configPath = path.join(dir, "config.json");
  // A string where an integer is expected makes parseConfig throw a message that
  // embeds the offending value verbatim (`got "<value>"`).
  await writeFile(configPath, JSON.stringify({ recallImpressionsRotateBytes: SECRET }), "utf-8");

  const originalWarn = console.warn;
  console.warn = () => {}; // silence parseConfig's own coercion warning (also secret-bearing)
  try {
    assert.throws(
      () => resolveOfflineImpressionRotation(configPath),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(SECRET), "validation error must not leak the raw config value");
        assert.match(error.message, /config failed validation/);
        assert.ok(error.message.includes(configPath), "error should still name the (non-secret) config path");
        return true;
      },
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("an unparseable-JSON config is redacted to a generic error, never the raw bytes (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-rotation-badjson-"));
  const configPath = path.join(dir, "config.json");
  // Invalid JSON (trailing comma) whose bytes embed a secret. Node's JSON.parse
  // error quotes surrounding input, so the raw message can leak the secret.
  await writeFile(configPath, `{ "apiKey": "${SECRET}", }`, "utf-8");

  assert.throws(
    () => resolveOfflineImpressionRotation(configPath),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(SECRET), "JSON error must not leak the raw config bytes");
      assert.match(error.message, /config file could not be read as JSON/);
      return true;
    },
  );
});
