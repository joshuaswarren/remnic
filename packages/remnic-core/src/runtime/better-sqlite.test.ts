import assert from "node:assert/strict";
import test from "node:test";
import {
  displayErrorDetail,
  isLikelyBetterSqlite3NativeBindingError,
  openBetterSqlite3,
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

test("displayErrorDetail strips require stacks and redacts paths without leaking server internals (CodeQL js/stack-trace-exposure)", () => {
  // MODULE_NOT_FOUND: Node appends a "Require stack:" block of absolute paths.
  const moduleNotFound = new Error(
    "Cannot find module 'better-sqlite3'\nRequire stack:\n- /home/app/node_modules/x/index.js\n- /home/app/server.js",
  );
  const d1 = displayErrorDetail(moduleNotFound);
  assert.equal(d1, "Cannot find module 'better-sqlite3'");
  assert.ok(!d1.includes("Require stack"));
  assert.ok(!d1.includes("/home/app"));

  // Native version mismatch: the path is on the first line (possibly with
  // spaces), the useful NODE_MODULE_VERSION markers are on later lines. The
  // path must be redacted but the markers preserved.
  const nativeMismatch = new Error(
    "The module '/Users/Jane Doe/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
      "was compiled against a different Node.js version using\nNODE_MODULE_VERSION 108. This version of Node.js requires\nNODE_MODULE_VERSION 115.",
  );
  const d2 = displayErrorDetail(nativeMismatch);
  assert.ok(!d2.includes("/Users/Jane Doe"), "absolute path (with spaces) must be redacted");
  assert.ok(d2.includes("<path>"));
  assert.ok(d2.includes("NODE_MODULE_VERSION 108"), "diagnostic markers must be preserved");
  assert.ok(d2.includes("was compiled against a different Node.js version"));

  // error.stack is never surfaced.
  const withStack = new Error("boom");
  withStack.stack = "boom\n    at /home/app/secret.js:1:1";
  assert.equal(displayErrorDetail(withStack), "boom");

  // Innocuous slashes are not over-redacted.
  assert.equal(displayErrorDetail(new Error("input was invalid and/or empty")), "input was invalid and/or empty");
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
