import assert from "node:assert/strict";
import test from "node:test";

import { isNativeBindingError, nativeBindingRecoveryHint } from "./native-binding-hint.js";

test("recognizes the bindings-resolution failure operators actually see", () => {
  const error = new Error(
    "Could not locate the bindings file. Tried:\n → .../better-sqlite3/build/Release/better_sqlite3.node",
  );
  assert.equal(isNativeBindingError(error), true);
  const hint = nativeBindingRecoveryHint(error);
  assert.match(hint, /npm rebuild better-sqlite3 --build-from-source/);
  assert.match(hint, new RegExp(`ABI ${process.versions.modules}\\b`));
  assert.match(hint, new RegExp(`Node ${process.versions.node.split(".")[0]}\\b`));
});

test("recognizes an ABI mismatch reported as NODE_MODULE_VERSION", () => {
  const error = new Error(
    "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. " +
      "This version of Node.js requires NODE_MODULE_VERSION 141.",
  );
  assert.equal(isNativeBindingError(error), true);
  assert.match(nativeBindingRecoveryHint(error), /--build-from-source/);
});

test("an unrelated error yields no hint so its message reads unchanged", () => {
  const error = new Error("SQLITE_BUSY: database is locked");
  assert.equal(isNativeBindingError(error), false);
  assert.equal(nativeBindingRecoveryHint(error), "");
});

test("non-Error inputs are handled without throwing", () => {
  assert.equal(isNativeBindingError(undefined), false);
  assert.equal(isNativeBindingError(null), false);
  assert.equal(nativeBindingRecoveryHint({}), "");
  assert.equal(isNativeBindingError("could not locate the bindings file"), true);
  assert.match(nativeBindingRecoveryHint("invalid ELF header"), /--build-from-source/);
});
