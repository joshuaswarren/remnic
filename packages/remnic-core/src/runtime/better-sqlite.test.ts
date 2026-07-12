import assert from "node:assert/strict";
import test from "node:test";
import {
  displayErrorDetail,
  isLikelyBetterSqlite3NativeBindingError,
  openBetterSqlite3,
  probeBetterSqlite3Driver,
} from "./better-sqlite.js";

test("isLikelyBetterSqlite3NativeBindingError recognizes missing and mismatched native bindings", () => {
  assert.equal(
    isLikelyBetterSqlite3NativeBindingError(
      new Error("Could not locate the bindings file. Tried: better_sqlite3.node"),
    ),
    true,
  );
  assert.equal(
    isLikelyBetterSqlite3NativeBindingError(
      new Error("The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127"),
    ),
    true,
  );
  assert.equal(isLikelyBetterSqlite3NativeBindingError(new Error("SQLITE_BUSY: database is locked")), false);
});

test("isLikelyBetterSqlite3NativeBindingError walks the cause chain of a sanitized wrapper (issue #1848)", () => {
  // Production path: loadBetterSqlite3() catches the ABI error and re-throws a
  // sanitized unavailableError WRAPPER whose message drops the ABI markers. The
  // original error survives only on .cause — the classifier must walk it, or
  // the startup probe / projection doctor / browse warn all MISS the hint.
  const abiCause = new Error(
    "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127",
  );
  const wrapper = new Error(
    "better-sqlite3 is unavailable. Remnic attempted to load the native SQLite binding and could not.",
    { cause: abiCause },
  );
  assert.equal(isLikelyBetterSqlite3NativeBindingError(wrapper), true);

  // Deeply nested wrapper (wrapper.cause.cause = ABI error) is still found.
  const deepWrapper = new Error("outer sanitized layer", { cause: wrapper });
  assert.equal(isLikelyBetterSqlite3NativeBindingError(deepWrapper), true);

  // A wrapper whose cause is NOT a native-binding failure stays negative.
  const benignWrapper = new Error("better-sqlite3 is unavailable.", {
    cause: new Error("SQLITE_BUSY: database is locked"),
  });
  assert.equal(isLikelyBetterSqlite3NativeBindingError(benignWrapper), false);
});

test("isLikelyBetterSqlite3NativeBindingError inspects AggregateError.errors siblings", () => {
  // Module loaders can surface failures as an AggregateError; the ABI mismatch
  // may live in a sibling rather than the aggregate's own message.
  const agg = new AggregateError([
    new Error("some unrelated loader step"),
    new Error("Could not locate the bindings file. Tried: better_sqlite3.node"),
  ]);
  assert.equal(isLikelyBetterSqlite3NativeBindingError(agg), true);

  const benignAgg = new AggregateError([new Error("unrelated"), new Error("SQLITE_BUSY")]);
  assert.equal(isLikelyBetterSqlite3NativeBindingError(benignAgg), false);
});

test("isLikelyBetterSqlite3NativeBindingError is cycle-safe on a self-referential cause", () => {
  const cyclic = new Error("SQLITE_BUSY: database is locked");
  cyclic.cause = cyclic; // would loop forever without a visited set
  assert.equal(isLikelyBetterSqlite3NativeBindingError(cyclic), false);
});

test("displayErrorDetail surfaces only error class + code, never the raw message (CodeQL js/stack-trace-exposure)", () => {
  // MODULE_NOT_FOUND messages embed an absolute "Require stack:" path block.
  const moduleNotFound = Object.assign(
    new Error("Cannot find module 'better-sqlite3'\nRequire stack:\n- /home/app/node_modules/x/index.js"),
    { code: "MODULE_NOT_FOUND" },
  );
  const d1 = displayErrorDetail(moduleNotFound);
  assert.equal(d1, "Error (MODULE_NOT_FOUND)");
  assert.ok(!d1.includes("/home/app") && !d1.includes("Require stack"));

  // Native loader failures can embed an absolute path (even with spaces) in the
  // message; we never surface it.
  const dlopen = Object.assign(
    new Error("/Users/Jane Doe/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node: file too short"),
    { code: "ERR_DLOPEN_FAILED" },
  );
  const d2 = displayErrorDetail(dlopen);
  assert.equal(d2, "Error (ERR_DLOPEN_FAILED)");
  assert.ok(!d2.includes("/Users/Jane Doe") && !d2.includes(".node"));

  // No code → class name only. error.stack is never read.
  const noCode = new Error("boom");
  noCode.stack = "boom\n    at /home/app/secret.js:1:1";
  assert.equal(displayErrorDetail(noCode), "Error");

  assert.equal(displayErrorDetail("not an error"), "");
});

test("openBetterSqlite3 can open an in-memory database after install verification", () => {
  const db = openBetterSqlite3(":memory:");
  try {
    const row = db.prepare("SELECT 42 AS answer").get() as { answer: number };
    assert.equal(row.answer, 42);
  } finally {
    db.close();
  }
});

test("probeBetterSqlite3Driver succeeds (ok=true) under the verified process and warms the ctor cache", () => {
  const probe = probeBetterSqlite3Driver();
  assert.equal(probe.ok, true);
  assert.equal(probe.detail, "");
  assert.equal(probe.nativeBindingMismatch, false);
  // A second probe reuses the warmed cache (no re-load); still ok.
  assert.equal(probeBetterSqlite3Driver().ok, true);
});
