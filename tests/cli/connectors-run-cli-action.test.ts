import test from "node:test";
import assert from "node:assert/strict";

import { emitConnectorsRunCliResult } from "../../src/cli.js";

test("connectors run CLI treats cursor persistence failure as a failed run", () => {
  let stdout = "";
  let stderr = "";
  const exitCode = emitConnectorsRunCliResult({
    connectorId: "google-drive",
    result: {
      docsImported: 2,
      stateWriteError: "EACCES: permission denied, open state.json",
    },
    format: "json",
    stdout: (output) => {
      stdout += output;
    },
    stderr: (output) => {
      stderr += output;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  assert.equal(parsed.connector, "google-drive");
  assert.equal(parsed.docsImported, 2);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, null);
  assert.equal(parsed.stateWriteError, "EACCES: permission denied, open state.json");
});
