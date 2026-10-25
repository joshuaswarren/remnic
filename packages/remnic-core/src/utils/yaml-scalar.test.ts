import assert from "node:assert/strict";
import test from "node:test";

import { decodeYamlScalar } from "./yaml-scalar.js";

test("decodeYamlScalar trims unquoted text without coercing scalar-looking strings", () => {
  for (const value of ["connector", "true", "42", "null", "'single quoted'", ""]) {
    assert.equal(decodeYamlScalar(` \t${value}\r\n`), value);
  }
});

test("decodeYamlScalar preserves whitespace inside quotes and decodes an empty quoted value", () => {
  assert.equal(decodeYamlScalar(' \t"  connector  "\r\n'), "  connector  ");
  assert.equal(decodeYamlScalar('""'), "");
});

test("decodeYamlScalar decodes escaped control characters, quotes, backslashes, and Unicode", () => {
  const encoded = String.raw`"line\nnext\r\t\b\f\"quote\"\\path\u263a"`;

  assert.equal(decodeYamlScalar(encoded), 'line\nnext\r\t\b\f"quote"\\path☺');
});

test("decodeYamlScalar keeps literal backslash sequences distinct from escaped control characters", () => {
  assert.equal(decodeYamlScalar(String.raw`"literal\\n"`), String.raw`literal\n`);
  assert.equal(decodeYamlScalar(String.raw`"actual\n"`), "actual\n");
});

test("decodeYamlScalar preserves malformed quoted content after removing only its outer quotes", () => {
  assert.equal(decodeYamlScalar(String.raw`"connector\q"`), String.raw`connector\q`);
  assert.equal(decodeYamlScalar('"a "quoted" value"'), 'a "quoted" value');
});

test("decodeYamlScalar leaves unmatched quotes as text", () => {
  for (const value of ['"connector', 'connector"', '"']) {
    assert.equal(decodeYamlScalar(`  ${value}  `), value);
  }
});
