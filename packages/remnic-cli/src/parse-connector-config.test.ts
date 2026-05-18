import test from "node:test";
import assert from "node:assert/strict";

import {
  parseConnectorConfig,
  stripConfigArgv,
} from "./parse-connector-config.js";

test("parseConnectorConfig accepts joined and split key=value config", () => {
  assert.deepEqual(
    parseConnectorConfig([
      "--config=codexHome=/tmp/remnic",
      "--config",
      "installExtension=false",
    ]),
    {
      codexHome: "/tmp/remnic",
      installExtension: "false",
    },
  );
});

test("parseConnectorConfig preserves values containing equals signs", () => {
  assert.deepEqual(parseConnectorConfig(["--config", "token=a=b"]), {
    token: "a=b",
  });
});

test("parseConnectorConfig rejects missing split values", () => {
  assert.throws(
    () => parseConnectorConfig(["--config"]),
    /--config requires key=value/,
  );
  assert.throws(
    () => parseConnectorConfig(["--config", "--force"]),
    /--config requires key=value/,
  );
});

test("parseConnectorConfig rejects config values without an assignment", () => {
  assert.throws(
    () => parseConnectorConfig(["--config=installExtension"]),
    /--config requires key=value/,
  );
  assert.throws(
    () => parseConnectorConfig(["--config", "installExtension"]),
    /--config requires key=value/,
  );
});

test("parseConnectorConfig rejects empty config keys", () => {
  assert.throws(
    () => parseConnectorConfig(["--config==false"]),
    /--config requires a non-empty key/,
  );
  assert.throws(
    () => parseConnectorConfig(["--config", "=false"]),
    /--config requires a non-empty key/,
  );
});

test("stripConfigArgv removes valid config args before connector id resolution", () => {
  assert.deepEqual(
    stripConfigArgv([
      "--config=codexHome=/tmp/remnic",
      "--config",
      "installExtension=false",
      "--force",
      "codex-cli",
    ]),
    ["--force", "codex-cli"],
  );
});

test("stripConfigArgv rejects malformed config args instead of hiding them", () => {
  assert.throws(
    () => stripConfigArgv(["--config=installExtension", "codex-cli"]),
    /--config requires key=value/,
  );
  assert.throws(
    () => stripConfigArgv(["--config", "--force", "codex-cli"]),
    /--config requires key=value/,
  );
});

test("marketplace --config file paths are not connector key=value assignments", () => {
  const marketplaceRest = [
    "validate",
    "--config",
    "./remnic.json",
    "./marketplace.json",
  ];

  assert.equal(
    marketplaceRest.filter((arg) => !arg.startsWith("--"))[0],
    "validate",
  );
  assert.throws(
    () => stripConfigArgv(marketplaceRest),
    /--config requires key=value/,
  );
});
