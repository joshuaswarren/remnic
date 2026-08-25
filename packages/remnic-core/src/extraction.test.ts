/**
 * Extraction failure-classification tests (extraction hot-loop hardening).
 *
 * The retry/backoff + circuit-breaker layer keys off `ExtractionFailureClass`.
 * These tests lock the mapping from synthetic provider errors (429/500/401/
 * no-models/parse-empty) to the coarse class, reusing the shared
 * `isTransientHttpError` classifier rather than a bespoke copy.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyExtractionThrownError, classifyFallbackParseFailure, formatExtractionParseFailureLog } from "./extraction.js";

test("classifyExtractionThrownError: 401/403 → auth_config", () => {
  assert.equal(classifyExtractionThrownError({ status: 401 }), "auth_config");
  assert.equal(classifyExtractionThrownError({ status: 403 }), "auth_config");
  assert.equal(classifyExtractionThrownError({ statusCode: 401 }), "auth_config");
});

test("classifyExtractionThrownError: 429/5xx → provider_retryable", () => {
  assert.equal(classifyExtractionThrownError({ status: 429 }), "provider_retryable");
  assert.equal(classifyExtractionThrownError({ status: 500 }), "provider_retryable");
  assert.equal(classifyExtractionThrownError({ status: 503 }), "provider_retryable");
});

test("classifyExtractionThrownError: bare network error / unknown → provider_retryable (fail-open toward retry)", () => {
  assert.equal(classifyExtractionThrownError(new Error("socket hang up")), "provider_retryable");
  // A terminal non-auth 4xx still defaults to retryable (capped by the attempt budget).
  assert.equal(classifyExtractionThrownError({ status: 400 }), "provider_retryable");
  assert.equal(classifyExtractionThrownError(null), "provider_retryable");
  assert.equal(classifyExtractionThrownError("not an object"), "provider_retryable");
});

test("classifyFallbackParseFailure: maps the gateway parse-failure reasons", () => {
  assert.equal(classifyFallbackParseFailure("no_models"), "auth_config");
  assert.equal(classifyFallbackParseFailure("http_error"), "provider_retryable");
  assert.equal(classifyFallbackParseFailure("empty"), "parse_empty");
  assert.equal(classifyFallbackParseFailure("schema_rejection"), "parse_empty");
  assert.equal(classifyFallbackParseFailure("timeout"), "provider_retryable");
});

test("formatExtractionParseFailureLog keeps the greppable prefix and distinct fields", () => {
  const line = formatExtractionParseFailureLog({
    failureReason: "http_error",
    attemptedModel: "openai/test-model",
    httpStatus: 502,
    errorClass: "http_5xx",
    traceId: "trace-1",
  });
  assert.match(line, /^extraction fallback returned no parsed output /);
  assert.match(line, /failureReason=http_error/);
  assert.match(line, /modelUsed=openai\/test-model/);
  assert.match(line, /errorClass=http_5xx/);
  assert.match(line, /httpStatus=502/);
  assert.match(line, /traceId=trace-1/);
});
