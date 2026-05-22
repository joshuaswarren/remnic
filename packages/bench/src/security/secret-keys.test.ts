import assert from "node:assert/strict";
import test from "node:test";

import { isSecretKey } from "./secret-keys.ts";

test("isSecretKey redacts material-suffixed secret key names", () => {
  for (const key of [
    "openaiApiKeyValue",
    "clientSecretPem",
    "privateKeyMaterial",
    "refreshTokenPlaintext",
    "authorizationHeader",
    "apiKeyCredentials",
  ]) {
    assert.equal(isSecretKey(key), true, key);
  }
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
