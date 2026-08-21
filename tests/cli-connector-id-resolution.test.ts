/**
 * Regression tests for connector ID resolution in cmdConnectors.
 *
 * Finding 1 (PR #394): split-form `--config key=value` caused the value token
 * (e.g. `installExtension=false`) to be mistaken for the connector ID when the
 * user runs:
 *
 *   remnic connectors install --config installExtension=false codex-cli
 *
 * Tests import `stripConfigArgv` directly from the helper module to avoid
 * pulling in `@remnic/core/dist/index.js`, which may not be built in CI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { stripConfigArgv } from "../packages/remnic-cli/src/parse-connector-config.ts";

// ── stripConfigArgv unit tests ────────────────────────────────────────────────

test("stripConfigArgv: split-form --config before connector ID", () => {
  // The problematic argv: value token `installExtension=false` must be removed.
  const argv = ["--config", "installExtension=false", "codex-cli"];
  const stripped = stripConfigArgv(argv);
  assert.deepEqual(stripped, ["codex-cli"]);
  // Connector ID is the first non-flag remaining arg.
  const connectorId = stripped.filter((a) => !a.startsWith("--"))[0];
  assert.equal(connectorId, "codex-cli");
});

test("stripConfigArgv: split-form --config after connector ID", () => {
  const argv = ["codex-cli", "--config", "installExtension=false"];
  const stripped = stripConfigArgv(argv);
  assert.deepEqual(stripped, ["codex-cli"]);
  const connectorId = stripped.filter((a) => !a.startsWith("--"))[0];
  assert.equal(connectorId, "codex-cli");
});

test("stripConfigArgv: joined-form --config=key=value before connector ID", () => {
  const argv = ["--config=installExtension=false", "codex-cli"];
  const stripped = stripConfigArgv(argv);
  assert.deepEqual(stripped, ["codex-cli"]);
  const connectorId = stripped.filter((a) => !a.startsWith("--"))[0];
  assert.equal(connectorId, "codex-cli");
});

test("stripConfigArgv: multiple split-form --config flags", () => {
  const argv = ["--config", "installExtension=false", "--config", "codexHome=/tmp/x", "codex-cli"];
  const stripped = stripConfigArgv(argv);
  assert.deepEqual(stripped, ["codex-cli"]);
  const connectorId = stripped.filter((a) => !a.startsWith("--"))[0];
  assert.equal(connectorId, "codex-cli");
});

test("stripConfigArgv: mixed split and joined --config forms", () => {
  const argv = ["--config=codexHome=/tmp/x", "--config", "installExtension=false", "--force", "codex-cli"];
  const stripped = stripConfigArgv(argv);
  assert.deepEqual(stripped, ["--force", "codex-cli"]);
  const connectorId = stripped.filter((a) => !a.startsWith("--"))[0];
  assert.equal(connectorId, "codex-cli");
});

test("stripConfigArgv: no --config flags — argv unchanged", () => {
  const argv = ["codex-cli", "--force"];
  const stripped = stripConfigArgv(argv);
  assert.deepEqual(stripped, ["codex-cli", "--force"]);
});

test("stripConfigArgv: split-form --config with value containing = signs", () => {
  // e.g. --config token=a=b — value is `token=a=b` (contains multiple =)
  const argv = ["--config", "token=a=b", "codex-cli"];
  const stripped = stripConfigArgv(argv);
  assert.deepEqual(stripped, ["codex-cli"]);
});

test("stripConfigArgv: split-form --config followed by another flag rejects malformed input", () => {
  const argv = ["--config", "--force", "codex-cli"];
  assert.throws(() => stripConfigArgv(argv), /--config requires key=value/);
});
