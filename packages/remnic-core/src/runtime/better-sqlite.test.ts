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
