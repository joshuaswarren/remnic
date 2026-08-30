import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableUtilityFailure } from "./utility-runner.js";

test("only transport execution failures are retried", () => {
  assert.equal(
    isRetryableUtilityFailure({
      details: { benchmarkFailure: { kind: "trial_execution_failure" } },
    }),
    true,
  );
  assert.equal(
    isRetryableUtilityFailure({
      details: { benchmarkFailure: { kind: "scoring_failure" } },
    }),
    false,
  );
  assert.equal(isRetryableUtilityFailure({}), false);
});
