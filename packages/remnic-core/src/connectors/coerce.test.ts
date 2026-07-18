import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { coerceBool, coerceNumber } from "./coerce.js";
import { initLogger } from "../logger.js";

let warnings: string[];

beforeEach(() => {
  warnings = [];
  initLogger(
    {
      info() {},
      warn(msg: string) {
        warnings.push(msg);
      },
      error() {},
      debug() {},
    },
    false,
    { timestamps: false },
  );
});

afterEach(() => {
  // Restore the no-op backend so later suites do not inherit this capture sink.
  initLogger({ info() {}, warn() {}, error() {}, debug() {} });
});

test("coerceBool recognizes canonical true/false spellings without warning", () => {
  for (const t of ["true", "1", "yes", "on", "TRUE", " On "]) {
    assert.equal(coerceBool(t), true, `${t} → true`);
  }
  for (const f of ["false", "0", "no", "off", "FALSE", " Off "]) {
    assert.equal(coerceBool(f), false, `${f} → false`);
  }
  assert.equal(coerceBool(true), true);
  assert.equal(coerceBool(false), false);
  assert.deepEqual(warnings, [], "recognized values must not warn");
});

test("coerceBool returns undefined silently for absent values", () => {
  assert.equal(coerceBool(undefined), undefined);
  assert.equal(coerceBool(null), undefined);
  assert.equal(coerceBool(""), undefined);
  assert.equal(coerceBool("   "), undefined);
  assert.deepEqual(warnings, [], "absent/empty must be treated as 'use default', no warning");
});

test("coerceBool warns on a present-but-unrecognized string and returns undefined", () => {
  assert.equal(coerceBool("disabled"), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unrecognized boolean value "disabled"/);
  assert.match(warnings[0], /using default/);
});

test("coerceBool includes the label in the warning when provided", () => {
  assert.equal(coerceBool("fales", "qmdForceCpu"), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /for qmdForceCpu/);
});

test("coerceBool does not warn on inherited Object keys (prototype safety)", () => {
  assert.equal(coerceBool("constructor"), undefined);
  assert.equal(coerceBool("toString"), undefined);
  assert.equal(coerceBool("hasOwnProperty"), undefined);
  // These are unrecognized strings, so each warns exactly once — never matched
  // as a truthy/falsy token via the prototype chain.
  assert.equal(warnings.length, 3);
});

test("coerceBool returns undefined without warning for non-string, non-boolean inputs", () => {
  assert.equal(coerceBool(2), undefined);
  assert.equal(coerceBool({}), undefined);
  assert.equal(coerceBool([]), undefined);
  assert.deepEqual(warnings, []);
});

test("coerceNumber accepts finite numbers and numeric strings without warning", () => {
  assert.equal(coerceNumber(5), 5);
  assert.equal(coerceNumber(0), 0);
  assert.equal(coerceNumber(-3.5), -3.5);
  assert.equal(coerceNumber("42"), 42);
  assert.equal(coerceNumber(" 7 "), 7);
  assert.deepEqual(warnings, []);
});

test("coerceNumber returns undefined silently for absent or non-finite number inputs", () => {
  assert.equal(coerceNumber(undefined), undefined);
  assert.equal(coerceNumber(null), undefined);
  assert.equal(coerceNumber(""), undefined);
  assert.equal(coerceNumber(Number.NaN), undefined);
  assert.equal(coerceNumber(Number.POSITIVE_INFINITY), undefined);
  assert.deepEqual(warnings, [], "absent / non-finite numeric inputs do not warn");
});

test("coerceNumber warns on a present-but-unparseable string and returns undefined", () => {
  assert.equal(coerceNumber("abc"), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unrecognized numeric value "abc"/);
  assert.equal(coerceNumber("12px", "maxResults"), undefined);
  assert.match(warnings[1], /for maxResults/);
});
