import assert from "node:assert/strict";
import test from "node:test";

import { isSecretKey } from "./secret-keys.ts";
import { redactUrlSecrets } from "./url-secrets.ts";

test("isSecretKey redacts material-suffixed secret key names", () => {
  for (const key of [
    "openaiApiKeyValue",
    "clientSecretPem",
    "privateKeyMaterial",
    "refreshTokenPlaintext",
    "authorizationHeader",
    "apiKeyCredentials",
    "AWS_SECRET_ACCESS_KEY",
    "awsSecretAccessKey",
    "aws_secret_access_key",
  ]) {
    assert.equal(isSecretKey(key), true, key);
  }
});

test("redactUrlSecrets redacts AWS-style secret access key query params", () => {
  assert.equal(
    redactUrlSecrets(
      "https://x.test/?aws_secret_access_key=abc&region=us-east-1",
      "[REDACTED]",
      isSecretKey,
    ),
    "https://x.test/?aws_secret_access_key=[REDACTED]&region=us-east-1",
  );
});

test("isSecretKey preserves non-secret lookalike key names", () => {
  for (const key of [
    "passwordless",
    "tokenCount",
    "credentialingOrg",
    "headerSize",
    "materializedAt",
  ]) {
    assert.equal(isSecretKey(key), false, key);
  }
});
