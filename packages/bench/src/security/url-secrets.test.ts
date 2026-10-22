import assert from "node:assert/strict";
import test from "node:test";

import { isSecretKey } from "./secret-keys.js";
import { redactUrlSecrets } from "./url-secrets.js";

test("URL logs redact userinfo and secret queries across multiple URLs", () => {
  const input = "primary=https://alice:pass@example.test/a?token=first&region=west "
    + "replica=git+ssh://bob:pass@replica.test/repo?api_key=second";
  assert.equal(
    redactUrlSecrets(input, "[REDACTED]", isSecretKey),
    "primary=https://[REDACTED]@example.test/a?token=[REDACTED]&region=west "
      + "replica=git+ssh://[REDACTED]@replica.test/repo?api_key=[REDACTED]",
  );
});

test("URL redaction preserves public parameters, paths, and fragments", () => {
  const input = "https://example.test/path@owner?tokenCount=3&passwordless=true&region=west#section";
  assert.equal(redactUrlSecrets(input, "[REDACTED]", isSecretKey), input);
});

test("URL redaction recognizes encoded secret query names and semicolon separators", () => {
  assert.equal(
    redactUrlSecrets("https://example.test/?%74oken=first&api%5Fkey=second;api+key=third&region=west",
      "[REDACTED]", isSecretKey),
    "https://example.test/?%74oken=[REDACTED]&api%5Fkey=[REDACTED];api+key=[REDACTED]&region=west",
  );
});

test("malformed query-name escapes still redact recognizable secret keys", () => {
  assert.equal(
    redactUrlSecrets("https://example.test/?token%=private&region=west", "[REDACTED]", isSecretKey),
    "https://example.test/?token%=[REDACTED]&region=west",
  );
});

test("secret query values stop at log punctuation without removing surrounding text", () => {
  for (const suffix of ["#section", "\" next", "' next", "} next", "] next", " next", "\nnext"]) {
    assert.equal(
      redactUrlSecrets(`https://example.test/?token=private${suffix}`, "[REDACTED]", isSecretKey),
      `https://example.test/?token=[REDACTED]${suffix}`,
      JSON.stringify(suffix),
    );
  }
});

test("redacting a previously redacted URL leaves its public details intact", () => {
  const input = "https://alice:pass@example.test/a?token=private&region=west";
  const redacted = "https://[REDACTED]@example.test/a?token=[REDACTED]&region=west";
  assert.equal(redactUrlSecrets(input, "[REDACTED]", isSecretKey), redacted);
  assert.equal(redactUrlSecrets(redacted, "[REDACTED]", isSecretKey), redacted);
});
