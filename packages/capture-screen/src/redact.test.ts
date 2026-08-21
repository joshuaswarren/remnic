import assert from "node:assert/strict";
import { test } from "node:test";

import { compileRedactionPatterns, REDACTION_PLACEHOLDER, redactText } from "./redact.js";
import { CaptureConfigError } from "./errors.js";

test("US SSNs are redacted", () => {
  const out = redactText("my ssn is 123-45-6789 ok");
  assert.match(out, /my ssn is \[REDACTED\] ok/);
});

test("Luhn-valid payment cards are redacted; non-Luhn digit runs are left", () => {
  assert.equal(redactText("card 4242 4242 4242 4242 end").includes(REDACTION_PLACEHOLDER), true);
  assert.equal(redactText("card 4242-4242-4242-4242 end").includes(REDACTION_PLACEHOLDER), true);
  // Sixteen 1s is not Luhn-valid — must not be redacted (avoids nuking IDs/counts).
  assert.equal(redactText("ref 1111 1111 1111 1111 end"), "ref 1111 1111 1111 1111 end");
});

test("user redaction patterns are applied in addition to the built-ins", () => {
  const patterns = compileRedactionPatterns(["SECRET-[A-Z0-9]+"]);
  const out = redactText("token SECRET-ABC123 and ssn 123-45-6789", patterns);
  assert.match(out, /token \[REDACTED\] and ssn \[REDACTED\]/);
});

test("a global user pattern redacts every occurrence and is reusable", () => {
  const patterns = compileRedactionPatterns(["\\bpw\\b"]);
  assert.equal(redactText("pw here pw there", patterns), "[REDACTED] here [REDACTED] there");
  // Reusing the same compiled pattern must not skip matches (lastIndex reset).
  assert.equal(redactText("pw again", patterns), "[REDACTED] again");
});

test("text with no sensitive content is unchanged", () => {
  const text = "just some ordinary window text with numbers 42 and 2026-07-20";
  assert.equal(redactText(text), text);
});

test("an invalid user regex fails loudly at compile time", () => {
  assert.throws(() => compileRedactionPatterns(["(unclosed"]), CaptureConfigError);
});
