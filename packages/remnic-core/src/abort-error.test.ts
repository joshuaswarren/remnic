import assert from "node:assert/strict";
import test from "node:test";

import { abortError, isAbortError, throwIfAborted } from "./abort-error.js";

test("abortError builds an Error whose name is AbortError", () => {
  const err = abortError("stop");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "AbortError");
  assert.equal(err.message, "stop");
});

test("isAbortError returns true for our abort errors and false otherwise", () => {
  assert.equal(isAbortError(abortError("stop")), true);
  assert.equal(isAbortError(new Error("regular error")), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError("abort"), false);
  assert.equal(isAbortError({ name: "AbortError" }), false);
});

test("throwIfAborted does nothing when signal is absent", () => {
  throwIfAborted(); // should not throw
  assert.ok(true);
});

test("throwIfAborted does nothing when signal is not yet aborted", () => {
  const controller = new AbortController();
  throwIfAborted(controller.signal);
  assert.ok(true);
});

test("throwIfAborted throws AbortError when signal is aborted", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => throwIfAborted(controller.signal),
    (err: Error) => err.name === "AbortError" && err.message === "operation aborted",
  );
});

test("throwIfAborted uses the caller-provided message", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => throwIfAborted(controller.signal, "custom abort message"),
    (err: Error) => err.message === "custom abort message",
  );
});
