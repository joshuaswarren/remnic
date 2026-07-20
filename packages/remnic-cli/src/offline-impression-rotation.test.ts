import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pickOfflineConfigRecord, resolveOfflineImpressionRotation } from "./offline-impression-rotation.js";

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

test("a config validation failure is redacted - and the coercion warning is suppressed - so the raw value never leaks (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-rotation-validation-"));
  const configPath = path.join(dir, "config.json");
  // A string where an integer is expected makes parseConfig throw a message that
  // embeds the offending value verbatim (`got "<value>"`), and - with no logger
  // installed - console.warn the same raw value from its numeric coercion path.
  await writeFile(configPath, JSON.stringify({ recallImpressionsRotateBytes: SECRET }), "utf-8");

  const originalWarn = console.warn;
  const warnMessages: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnMessages.push(args.map((a) => String(a)).join(" "));
  };
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
  // The redacted parse suppresses parseConfig's own coercion diagnostic, so the
  // raw value never reaches stderr even though a warning would otherwise fire.
  assert.ok(
    !warnMessages.some((m) => m.includes(SECRET)),
    "the raw config value must not leak through a console.warn coercion diagnostic",
  );
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

test("an UNRELATED invalid config field does not abort rotation resolution and never leaks (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-rotation-unrelated-"));
  const configPath = path.join(dir, "config.json");
  // A field offline never consumes (`correction.maxAffected`) with an invalid,
  // secret-bearing value. Full parseConfig would THROW on it; the offline path
  // must drop it and still resolve rotation from valid offline keys.
  await writeFile(
    configPath,
    JSON.stringify({
      correction: { maxAffected: SECRET },
      recallImpressionsRotateBytes: 4096,
      recallImpressionsRotateKeep: 3,
    }),
    "utf-8",
  );

  assert.deepEqual(resolveOfflineImpressionRotation(configPath), {
    impressionsRotateBytes: 4096,
    impressionsRotateKeep: 3,
  });
});

test("pickOfflineConfigRecord keeps only offline keys and drops unrelated fields (#2033)", () => {
  const picked = pickOfflineConfigRecord({
    offlineSyncExcludes: ["scratch/**"],
    secureStoreEncryptOnWrite: false,
    recallImpressionsRotateBytes: 100,
    recallImpressionsRotateKeep: 2,
    correction: { maxAffected: SECRET },
    openaiApiKey: SECRET,
  });
  assert.deepEqual(picked, {
    offlineSyncExcludes: ["scratch/**"],
    secureStoreEncryptOnWrite: false,
    recallImpressionsRotateBytes: 100,
    recallImpressionsRotateKeep: 2,
  });
  assert.ok(!("correction" in picked) && !("openaiApiKey" in picked));
});

test("pickOfflineConfigRecord unwraps a nested remnic/engram block (#2033)", () => {
  assert.deepEqual(
    pickOfflineConfigRecord({ remnic: { secureStoreEncryptOnWrite: false }, openaiApiKey: SECRET }),
    { secureStoreEncryptOnWrite: false },
  );
});

test("pickOfflineConfigRecord returns an empty record for a non-object config (#2033)", () => {
  assert.deepEqual(pickOfflineConfigRecord(null), {});
  assert.deepEqual(pickOfflineConfigRecord("nope"), {});
  assert.deepEqual(pickOfflineConfigRecord([1, 2, 3]), {});
});
