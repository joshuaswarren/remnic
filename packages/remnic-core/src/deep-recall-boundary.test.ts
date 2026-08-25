/**
 * Deep-recall MCP operation boundary regressions (issue #2915).
 *
 * `deep_recall` runs through the shared operation registry (the dispatch the
 * MCP server uses). At this boundary a malformed `maxSteps` must be REJECTED
 * — `"abc"` previously fell back to the configured default and `""` coerced
 * to 0 (§39) — and the request's cancellation signal must reach the service.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getOperation, type OperationContext } from "./access-boundary.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import "./access-operations.js";

interface CapturedRequest {
  query?: string;
  maxSteps?: number;
  namespace?: string;
  sessionKey?: string;
  authenticatedPrincipal?: string;
  abortSignal?: AbortSignal;
}

function serviceCapturing(captured: CapturedRequest): EngramAccessService {
  return {
    async deepRecall(request: CapturedRequest) {
      Object.assign(captured, request);
      return { ok: true, entries: [], trace: [], rendered: "synthetic" };
    },
  } as unknown as EngramAccessService;
}

function ctx(service: EngramAccessService, abortSignal?: AbortSignal): OperationContext {
  return { service, authenticatedPrincipal: "operator", ...(abortSignal ? { abortSignal } : {}) };
}

test("deep_recall operation rejects malformed maxSteps instead of silently defaulting (issue #2915)", async () => {
  const operation = getOperation("deep_recall");
  assert.ok(operation, "the deep_recall operation is registered");
  for (const maxSteps of ["abc", "", "1.5", -1]) {
    const captured: CapturedRequest = {};
    await assert.rejects(
      operation.run({ query: "payments routing", maxSteps }, ctx(serviceCapturing(captured))),
      (err: unknown) => err instanceof EngramAccessInputError && /maxSteps/.test(err.message),
      `must reject maxSteps ${JSON.stringify(maxSteps)}`,
    );
    assert.equal(captured.maxSteps, undefined, "the service is never reached with invalid input");
  }
});

test("deep_recall operation forwards parsed maxSteps and the cancellation signal (issue #2915)", async () => {
  const operation = getOperation("deep_recall");
  assert.ok(operation);
  const captured: CapturedRequest = {};
  const controller = new AbortController();
  await operation.run(
    { query: "payments routing", maxSteps: "2", namespace: "ns_x" },
    ctx(serviceCapturing(captured), controller.signal),
  );
  assert.equal(captured.maxSteps, 2, "a digit-string maxSteps parses to the integer it names");
  assert.equal(captured.namespace, "ns_x");
  assert.equal(captured.authenticatedPrincipal, "operator");
  assert.equal(captured.abortSignal, controller.signal, "the transport signal reaches the service call");
});
