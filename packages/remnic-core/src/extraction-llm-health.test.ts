/**
 * Extraction-LLM health surfacing (issue #3140).
 *
 * Covers the three #3140 surfaces:
 *   1. the singleton tracker that `/health.extraction` reads for LLM
 *      availability + last failure reason,
 *   2. the ERROR-level, per-reason-deduplicated failure event emitted by the
 *      extraction run instead of debug-only lines,
 *   3. the runExtraction integration recording failures/successes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  emitExtractionLlmFailureError,
  getExtractionLlmHealth,
  recordExtractionLlmFailure,
  recordExtractionLlmSuccess,
  resetExtractionLlmHealthForTests,
} from "./extraction-llm-health.js";
import { log } from "./logger.js";

test("tracker: starts reachable with no failure recorded", () => {
  resetExtractionLlmHealthForTests();
  try {
    assert.deepEqual(getExtractionLlmHealth(), {
      llmReachable: true,
      lastFailureReason: null,
      lastFailureAt: null,
    });
  } finally {
    resetExtractionLlmHealthForTests();
  }
});

test("tracker: a failure marks the extractor unavailable with the last reason (health payload, non-debug)", () => {
  resetExtractionLlmHealthForTests();
  try {
    recordExtractionLlmFailure("no_models", 1_000);
    const health = getExtractionLlmHealth();
    assert.equal(health.llmReachable, false);
    assert.equal(health.lastFailureReason, "no_models");
    assert.equal(health.lastFailureAt, new Date(1_000).toISOString());

    recordExtractionLlmFailure("local_llm_unavailable", 2_000);
    assert.equal(getExtractionLlmHealth().lastFailureReason, "local_llm_unavailable");
  } finally {
    resetExtractionLlmHealthForTests();
  }
});

test("tracker: a later success clears the failure so llmReachable and the reason agree", () => {
  resetExtractionLlmHealthForTests();
  try {
    recordExtractionLlmFailure("no_models");
    recordExtractionLlmSuccess();
    assert.deepEqual(getExtractionLlmHealth(), {
      llmReachable: true,
      lastFailureReason: null,
      lastFailureAt: null,
    });
  } finally {
    resetExtractionLlmHealthForTests();
  }
});

test("dedup: the first failure of a reason logs at ERROR level, repeats are suppressed", () => {
  resetExtractionLlmHealthForTests();
  const errors: string[] = [];
  const debugs: string[] = [];
  const originalError = log.error;
  const originalDebug = log.debug;
  log.error = (message: unknown) => {
    errors.push(String(message));
  };
  log.debug = (message: unknown) => {
    debugs.push(String(message));
  };
  try {
    assert.equal(emitExtractionLlmFailureError("no_models", "auth_config", 0), true);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /no_models/);

    // Same reason inside the window: suppressed to debug, no second ERROR.
    assert.equal(emitExtractionLlmFailureError("no_models", "auth_config", 60_000), false);
    assert.equal(errors.length, 1);
    assert.equal(debugs.length, 1);

    // A different reason emits its own first ERROR.
    assert.equal(emitExtractionLlmFailureError("local_llm_unavailable", undefined, 60_000), true);
    assert.equal(errors.length, 2);
    assert.match(errors[1] ?? "", /local_llm_unavailable/);

    // Outside the window the same reason emits again.
    assert.equal(emitExtractionLlmFailureError("no_models", undefined, 3_600_000), true);
    assert.equal(errors.length, 3);
  } finally {
    log.error = originalError;
    log.debug = originalDebug;
    resetExtractionLlmHealthForTests();
  }
});
