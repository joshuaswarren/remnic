import assert from "node:assert/strict";
import test from "node:test";

import { isErrnoCode, isNotFoundError } from "./errno.js";

/** Shapes accepted by every local helper this module replaced (issue #2795). */
test("isErrnoCode matches code-carrying errors and rejects everything else", () => {
  const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
  assert.equal(isErrnoCode(enoent, "ENOENT"), true);
  assert.equal(isErrnoCode({ code: "ENOENT" }, "ENOENT"), true, "plain objects with a code match");
  assert.equal(isErrnoCode(enoent, "EEXIST"), false, "different code does not match");
  assert.equal(isErrnoCode(new Error("no code"), "ENOENT"), false);
  assert.equal(isErrnoCode(null, "ENOENT"), false);
  assert.equal(isErrnoCode(undefined, "ENOENT"), false);
  assert.equal(isErrnoCode("ENOENT", "ENOENT"), false);
  assert.equal(isErrnoCode({}, "ENOENT"), false);
});

test("isNotFoundError is equivalent to isErrnoCode(error, \"ENOENT\")", () => {
  const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
  const eexist = Object.assign(new Error("file exists"), { code: "EEXIST" });
  for (const candidate of [enoent, eexist, { code: "ENOENT" }, {}, null, undefined, "ENOENT", 42]) {
    assert.equal(
      isNotFoundError(candidate),
      isErrnoCode(candidate, "ENOENT"),
      `isNotFoundError must agree with isErrnoCode(_, "ENOENT") for ${JSON.stringify(candidate) ?? String(candidate)}`,
    );
  }
  assert.equal(isNotFoundError(enoent), true);
  assert.equal(isNotFoundError(eexist), false);
});
