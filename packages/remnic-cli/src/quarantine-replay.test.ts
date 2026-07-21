/**
 * Issue #1888: CLI-level validation for `remnic quarantine replay`. These cases
 * exercise the pre-bootstrap argument checks, which return before any
 * orchestrator is constructed, so no daemon/config is required.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runQuarantineReplay } from "./quarantine-replay.js";

// The config resolver is never invoked on these paths (validation fails first),
// so it throws to prove that: a leaked call would surface here.
const resolver = (): string => {
  throw new Error("config resolver must not run when argument validation fails");
};

async function exitCodeFor(rest: string[]): Promise<number | undefined> {
  const prev = process.exitCode;
  process.exitCode = 0;
  try {
    await runQuarantineReplay(rest, "json", resolver);
    return process.exitCode;
  } finally {
    process.exitCode = prev;
  }
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

test("runQuarantineReplay: a repeated value flag is rejected (exit 2)", async () => {
  assert.equal(await exitCodeFor(["--namespace", "ns", "--namespace", "other"]), 2);
  assert.equal(await exitCodeFor(["--namespace", "ns", "--principal", "a", "--principal", "b"]), 2);
});

test("runQuarantineReplay: a blank principal override is rejected (exit 2)", async () => {
  assert.equal(await exitCodeFor(["--namespace", "ns", "--principal", "   "]), 2);
});
