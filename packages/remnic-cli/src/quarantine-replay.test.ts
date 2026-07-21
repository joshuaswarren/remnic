/**
 * Issue #1888: CLI-level validation for `remnic quarantine replay`. These cases
 * exercise the pre-bootstrap argument checks, which return before any
 * orchestrator is constructed, so no daemon/config is required.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runQuarantineReplay } from "./quarantine-replay.js";

async function exitCodeFor(rest: string[]): Promise<number | undefined> {
  const prev = process.exitCode;
  process.exitCode = 0;
  await runQuarantineReplay(rest, "json", "/nonexistent-remnic-config.json");
  const code = process.exitCode;
  process.exitCode = prev;
  return code;
}

test("runQuarantineReplay: missing --namespace is a usage error (exit 2)", async () => {
  assert.equal(await exitCodeFor([]), 2);
});

test("runQuarantineReplay: an unknown flag is rejected (exit 2)", async () => {
  assert.equal(await exitCodeFor(["--namespace", "ns", "--bogus"]), 2);
});

test("runQuarantineReplay: --namespace without a value is rejected (exit 2)", async () => {
  assert.equal(await exitCodeFor(["--namespace", "--json"]), 2);
});
