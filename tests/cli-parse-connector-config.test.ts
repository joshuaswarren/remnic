import test from "node:test";
import assert from "node:assert/strict";
// Import directly from the helper, not from the CLI entry.
// The CLI entry imports `@remnic/core`, whose `dist/index.js` is not built
// when `tsx --test` runs at the repo root in CI (ERR_MODULE_NOT_FOUND).
import { parseConnectorConfig } from "../packages/remnic-cli/src/parse-connector-config.ts";

test("parseConnectorConfig: --config=key=value joined form", () => {
  const result = parseConnectorConfig(["--config=installExtension=false"]);
  assert.deepEqual(result, { installExtension: "false" });
});

test("parseConnectorConfig: --config key=value split form", () => {
  const result = parseConnectorConfig(["--config", "installExtension=false"]);
  assert.deepEqual(result, { installExtension: "false" });
});

test("parseConnectorConfig: mixed joined and split forms", () => {
  const result = parseConnectorConfig([
    "--config=codexHome=/tmp/custom",
    "--config",
    "installExtension=true",
  ]);
  assert.deepEqual(result, {
    codexHome: "/tmp/custom",
    installExtension: "true",
  });
});

test("parseConnectorConfig: value containing = in joined form", () => {
  // --config=token=a=b should yield { token: "a=b" }
  const result = parseConnectorConfig(["--config=token=a=b"]);
  assert.deepEqual(result, { token: "a=b" });
});

test("parseConnectorConfig: value containing = in split form", () => {
  const result = parseConnectorConfig(["--config", "token=a=b"]);
  assert.deepEqual(result, { token: "a=b" });
});

test("parseConnectorConfig: multiple --config flags both forms", () => {
  const result = parseConnectorConfig([
    "--config=alpha=1",
    "--config",
    "beta=2",
    "--config=gamma=3",
    "--force",
  ]);
  assert.deepEqual(result, { alpha: "1", beta: "2", gamma: "3" });
});

test("parseConnectorConfig: no --config flags yields empty object", () => {
  const result = parseConnectorConfig(["install", "codex-cli", "--force"]);
  assert.deepEqual(result, {});
});

test("parseConnectorConfig: split form rejects missing key=value", () => {
  assert.throws(
    () => parseConnectorConfig(["--config", "--force"]),
    /--config requires key=value/,
  );
  assert.throws(
    () => parseConnectorConfig(["--config", "codex-cli"]),
    /--config requires key=value/,
  );
});

test("parseConnectorConfig: joined form rejects missing key=value", () => {
  assert.throws(
    () => parseConnectorConfig(["--config=installExtension"]),
    /--config requires key=value/,
  );
});

test("parseConnectorConfig: rejects empty keys", () => {
  assert.throws(
    () => parseConnectorConfig(["--config==false"]),
    /--config requires a non-empty key/,
  );
});
