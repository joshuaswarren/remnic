import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_METADATA_MAX_FIELD_LENGTH,
  buildAnalysisRunMetadata,
} from "./analysis-metadata.js";

const VALID = {
  provider: "openai",
  model: "gpt-5.2",
  promptVersion: "timeline-analysis.v2",
  observationCount: 12,
};

const STRING_FIELDS = ["provider", "model", "promptVersion"] as const;

test("a valid record round-trips with exactly the documented keys", () => {
  const result = buildAnalysisRunMetadata(VALID);
  assert.deepEqual(result, VALID);
  assert.deepEqual(Object.keys(result).sort(), [
    "model",
    "observationCount",
    "promptVersion",
    "provider",
  ]);
});

test("real provider and model slugs are accepted", () => {
  for (const model of ["gpt-5.2", "claude-4_1", "anthropic/claude-4", "llama3:8b", "o1"]) {
    assert.equal(buildAnalysisRunMetadata({ ...VALID, model }).model, model);
  }
  for (const promptVersion of ["v3", "2026-08-01", "timeline.v2"]) {
    assert.equal(
      buildAnalysisRunMetadata({ ...VALID, promptVersion }).promptVersion,
      promptVersion,
    );
  }
});

// The guarantee this record makes is that it cannot carry content. A length
// cap does not deliver that: a short single-line string is happily prose.
test("prose is rejected even when short and single-line", () => {
  for (const field of STRING_FIELDS) {
    for (const prose of [
      "Summarize this user's activity",
      "The user said they were tired",
      "api key lives in the operator profile",
    ]) {
      assert.throws(
        () => buildAnalysisRunMetadata({ ...VALID, [field]: prose }),
        /must be an identifier/,
        `${field} must reject ${JSON.stringify(prose)}`,
      );
    }
  }
});

test("every line-break character is rejected, including U+2028 and U+2029", () => {
  for (const field of STRING_FIELDS) {
    for (const sep of ["\n", "\r", "\u2028", "\u2029"]) {
      assert.throws(
        () => buildAnalysisRunMetadata({ ...VALID, [field]: `openai${sep}gpt` }),
        /must not contain a line break/,
      );
    }
  }
});

test("blank, padded, and non-string values are rejected", () => {
  for (const field of STRING_FIELDS) {
    assert.throws(() => buildAnalysisRunMetadata({ ...VALID, [field]: "" }), /must not be empty/);
    assert.throws(
      () => buildAnalysisRunMetadata({ ...VALID, [field]: "   " }),
      /must be an identifier/,
    );
    // Validate the exact value: a padded identifier is not trimmed into validity.
    assert.throws(
      () => buildAnalysisRunMetadata({ ...VALID, [field]: " openai" }),
      /must be an identifier/,
    );
    assert.throws(
      () => buildAnalysisRunMetadata({ ...VALID, [field]: 42 as unknown as string }),
      /must be a string; received number/,
    );
  }
});

test("the field length cap is enforced at the boundary", () => {
  const max = "a".repeat(ANALYSIS_METADATA_MAX_FIELD_LENGTH);
  assert.equal(buildAnalysisRunMetadata({ ...VALID, model: max }).model, max);
  assert.throws(
    () => buildAnalysisRunMetadata({ ...VALID, model: `${max}a` }),
    /is too long/,
  );
});

test("observationCount accepts 0 and rejects every non-count", () => {
  assert.equal(buildAnalysisRunMetadata({ ...VALID, observationCount: 0 }).observationCount, 0);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildAnalysisRunMetadata({ ...VALID, observationCount: bad }),
      /observationCount must be a non-negative integer/,
    );
  }
});

// An error message is a log line. A caller that mis-passes prompt text or a
// secret must not have it echoed there through the failure path.
test("a rejected value is never echoed in the error message", () => {
  const secret = "my-api-key-value-goes-here-0123456789";
  assert.throws(
    () => buildAnalysisRunMetadata({ ...VALID, provider: `${secret} leaked` }),
    (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.equal(error.message.includes(secret), false, "message must not echo the value");
      return true;
    },
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(
    () =>
      buildAnalysisRunMetadata({
        ...VALID,
        observationCount: circular as unknown as number,
      }),
    (error: unknown) => {
      // JSON.stringify would throw a TypeError here instead of the intended
      // RangeError, and would echo content for a plain object.
      assert.ok(error instanceof RangeError);
      assert.equal(error.message.includes("self"), false);
      return true;
    },
  );
  assert.throws(
    () =>
      buildAnalysisRunMetadata({
        ...VALID,
        observationCount: 10n as unknown as number,
      }),
    (error: unknown) => {
      assert.ok(error instanceof RangeError, "a bigint must not escape as a TypeError");
      return true;
    },
  );
});
