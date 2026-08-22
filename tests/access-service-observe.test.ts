import test from "node:test";
import assert from "node:assert/strict";
import {
  EngramAccessInputError,
  type EngramAccessObserveRequest,
  type EngramAccessObserveResponse,
  type EngramAccessLcmSearchResponse,
  type EngramAccessLcmStatusResponse,
} from "../src/access-service.ts";

/**
 * These tests validate the interface contracts and input validation for
 * the observe(), lcmSearch(), and lcmStatus() methods.
 *
 * Since the methods require a fully wired Orchestrator (with LCM engine,
 * extraction pipeline, etc.), we validate the type shapes and input
 * validation logic here. Integration tests with a real orchestrator
 * belong in a separate test suite.
 */

test("EngramAccessObserveResponse shape matches contract", () => {
  // #1495: `effectiveNamespace` is an additive required field carrying the
  // namespace every side effect actually wrote to. `scopeDebug` is the
  // optional diagnostic view of the resolved scope plan. `namespace` stays as
  // the backward-compatible base value.
  const response: EngramAccessObserveResponse = {
    accepted: 2,
    sessionKey: "test-session",
    namespace: "default",
    effectiveNamespace: "default-project-tag-foo",
    scopeDebug: {
      principal: "alice",
      baseNamespace: "default",
      writeNamespace: "default-project-tag-foo",
      codingOverlayApplied: true,
      readNamespaces: ["default-project-tag-foo"],
    },
    lcmArchived: true,
    extractionQueued: true,
    transcriptPersisted: true,
  };
  assert.equal(response.accepted, 2);
  assert.equal(response.sessionKey, "test-session");
  assert.equal(response.namespace, "default");
  assert.equal(response.effectiveNamespace, "default-project-tag-foo");
  assert.equal(response.scopeDebug?.codingOverlayApplied, true);
  assert.equal(response.lcmArchived, true);
  assert.equal(response.extractionQueued, true);
  // #2783: observe reports whether transcript persistence appended turns.
  assert.equal(response.transcriptPersisted, true);
});

test("EngramAccessObserveRequest with skipExtraction matches contract", () => {
  const request: EngramAccessObserveRequest = {
    sessionKey: "test-session",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ],
    skipExtraction: true,
  };
  assert.equal(request.skipExtraction, true);
  assert.equal(request.messages.length, 2);
});

test("EngramAccessLcmSearchResponse shape matches contract", () => {
  const response: EngramAccessLcmSearchResponse = {
    query: "test query",
    namespace: "default",
    results: [
      { sessionId: "session-1", content: "Some content", turnIndex: 5 },
    ],
    count: 1,
    lcmEnabled: true,
  };
  assert.equal(response.query, "test query");
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].sessionId, "session-1");
  assert.equal(response.results[0].turnIndex, 5);
  assert.equal(response.lcmEnabled, true);
});

test("EngramAccessLcmSearchResponse with lcmEnabled=false", () => {
  const response: EngramAccessLcmSearchResponse = {
    query: "test query",
    namespace: "default",
    results: [],
    count: 0,
    lcmEnabled: false,
  };
  assert.equal(response.lcmEnabled, false);
  assert.equal(response.count, 0);
  assert.deepEqual(response.results, []);
});

test("EngramAccessLcmStatusResponse shape matches contract", () => {
  const response: EngramAccessLcmStatusResponse = {
    enabled: true,
    archiveAvailable: true,
    stats: { totalTurns: 100 },
  };
  assert.equal(response.enabled, true);
  assert.equal(response.archiveAvailable, true);
  assert.equal(response.stats?.totalTurns, 100);
});

test("EngramAccessLcmStatusResponse when disabled", () => {
  const response: EngramAccessLcmStatusResponse = {
    enabled: false,
    archiveAvailable: false,
  };
  assert.equal(response.enabled, false);
  assert.equal(response.archiveAvailable, false);
  assert.equal(response.stats, undefined);
});

test("EngramAccessInputError is throwable for empty sessionKey", () => {
  assert.throws(
    () => {
      throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
    },
    {
      name: "Error",
      message: "sessionKey is required and must be a non-empty string",
    },
  );
});

test("EngramAccessInputError is throwable for empty messages", () => {
  assert.throws(
    () => {
      throw new EngramAccessInputError("messages is required and must be a non-empty array");
    },
    {
      name: "Error",
      message: "messages is required and must be a non-empty array",
    },
  );
});

test("EngramAccessInputError is throwable for empty query", () => {
  assert.throws(
    () => {
      throw new EngramAccessInputError("query is required and must be a non-empty string");
    },
    {
      name: "Error",
      message: "query is required and must be a non-empty string",
    },
  );
});
