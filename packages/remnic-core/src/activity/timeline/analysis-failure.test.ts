import test from "node:test";
import assert from "node:assert/strict";

import {
  ANALYSIS_FAILURE_KINDS,
  classifyAnalysisFailure,
  isAnalysisFailureKind,
  type AnalysisFailureKind,
} from "./analysis-failure.js";

test("every known kind classifies with the explicit retryable split", () => {
  const retryableKinds: readonly AnalysisFailureKind[] = [
    "provider_unavailable",
    "timeout",
    "rate_limited",
  ];
  const nonRetryableKinds: readonly AnalysisFailureKind[] = [
    "aborted",
    "malformed_json",
    "invalid_schema",
    "partial_output",
    "invalid_config",
  ];
  for (const kind of ANALYSIS_FAILURE_KINDS) {
    const failure = classifyAnalysisFailure(kind);
    assert.equal(failure.kind, kind);
    assert.equal(failure.preservesDeterministic, true);
    const expectedRetryable = retryableKinds.includes(kind);
    assert.ok(
      expectedRetryable || nonRetryableKinds.includes(kind),
      `${kind} missing from the explicit retryable split`,
    );
    assert.equal(
      failure.retryable,
      expectedRetryable,
      `${kind} retryable must be ${expectedRetryable}`,
    );
  }
});

test("the explicit retryable split covers all kinds exactly once", () => {
  const split: readonly string[] = [
    "provider_unavailable",
    "timeout",
    "rate_limited",
    "aborted",
    "malformed_json",
    "invalid_schema",
    "partial_output",
    "invalid_config",
  ];
  assert.equal(new Set(split).size, split.length);
  assert.deepEqual(
    [...ANALYSIS_FAILURE_KINDS].sort(),
    [...split].sort(),
  );
});

test("unknown string kind throws TypeError naming the allowed kinds", () => {
  assert.throws(
    () => classifyAnalysisFailure("provider_on_fire"),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match((err as Error).message, /unknown analysis failure/);
      for (const kind of ANALYSIS_FAILURE_KINDS) {
        assert.ok((err as Error).message.includes(kind));
      }
      return true;
    },
  );
});

test("empty, null, undefined, and non-string kinds throw", () => {
  for (const bad of ["", undefined, null, 42]) {
    assert.throws(
      () => classifyAnalysisFailure(bad as string),
      TypeError,
      `expected throw for ${String(bad)}`,
    );
  }
});

test("isAnalysisFailureKind is false for non-strings, empty, and unknown", () => {
  assert.equal(isAnalysisFailureKind(undefined), false);
  assert.equal(isAnalysisFailureKind(null), false);
  assert.equal(isAnalysisFailureKind(42), false);
  assert.equal(isAnalysisFailureKind({ kind: "timeout" }), false);
  assert.equal(isAnalysisFailureKind(""), false);
  assert.equal(isAnalysisFailureKind("timeout "), false);
  assert.equal(isAnalysisFailureKind("TIMEOUT"), false);
  assert.equal(isAnalysisFailureKind("provider_on_fire"), false);
  for (const kind of ANALYSIS_FAILURE_KINDS) {
    assert.equal(isAnalysisFailureKind(kind), true);
  }
});

test("preservesDeterministic is true for every kind", () => {
  for (const kind of ANALYSIS_FAILURE_KINDS) {
    assert.deepEqual(
      classifyAnalysisFailure(kind).preservesDeterministic,
      true,
    );
  }
});
