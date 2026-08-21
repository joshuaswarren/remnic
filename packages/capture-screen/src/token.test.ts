import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bearerFromHeader, generateToken, loadOrCreateToken, tokensMatch } from "./token.js";

test("generateToken returns a long random base64url string", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 40);
});

test("loadOrCreateToken creates once (0600) and is stable across reads", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "csr-token-"));
  const tokenPath = path.join(dir, "token");
  const first = loadOrCreateToken(tokenPath);
  const second = loadOrCreateToken(tokenPath);
  assert.equal(first, second);
  if (process.platform !== "win32") {
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  }
});

test("tokensMatch is constant-time-ish and length-safe", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", "abd"), false);
  assert.equal(tokensMatch("abc", "abcd"), false);
});

test("bearerFromHeader parses only well-formed Bearer headers", () => {
  assert.equal(bearerFromHeader("Bearer xyz"), "xyz");
  assert.equal(bearerFromHeader("bearer\txyz"), "xyz");
  assert.equal(bearerFromHeader("Basic xyz"), null);
  assert.equal(bearerFromHeader("Bearerxyz"), null);
  assert.equal(bearerFromHeader(undefined), null);
});

test("loadOrCreateToken replaces a pre-existing empty token file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "csr-token-empty-"));
  const tokenPath = path.join(dir, "token");
  writeFileSync(tokenPath, "", { mode: 0o600 });
  const token = loadOrCreateToken(tokenPath);
  assert.ok(token.length >= 40, "an empty token file must be replaced with a fresh token");
  assert.equal(loadOrCreateToken(tokenPath), token);
});
