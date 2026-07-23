import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { bearerFromHeader, generateToken, loadOrCreateToken, tokensMatch } from "./token.js";

test("generateToken yields distinct URL-safe tokens", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("loadOrCreateToken creates a 0600 file and is stable on reload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-tok-"));
  const tokenPath = path.join(dir, "token");
  const first = loadOrCreateToken(tokenPath);
  const mode = statSync(tokenPath).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  const second = loadOrCreateToken(tokenPath);
  assert.equal(first, second);
});

test("loadOrCreateToken re-tightens a loose pre-existing token file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-tok-"));
  const tokenPath = path.join(dir, "token");
  writeFileSync(tokenPath, "preset-token\n", { mode: 0o644 });
  const token = loadOrCreateToken(tokenPath);
  assert.equal(token, "preset-token");
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
});

test("tokensMatch is length-safe and value-correct", () => {
  assert.equal(tokensMatch("abc123", "abc123"), true);
  assert.equal(tokensMatch("abc123", "abc124"), false);
  assert.equal(tokensMatch("abc", "abcd"), false);
  assert.equal(tokensMatch("", ""), true);
});

test("bearerFromHeader extracts the token or returns null", () => {
  assert.equal(bearerFromHeader("Bearer xyz"), "xyz");
  assert.equal(bearerFromHeader("bearer   xyz  "), "xyz");
  assert.equal(bearerFromHeader("Basic xyz"), null);
  assert.equal(bearerFromHeader(undefined), null);
  assert.equal(bearerFromHeader(["Bearer first", "Bearer second"]), "first");
});

test("bearerFromHeader rejects a scheme without a separator", () => {
  assert.equal(bearerFromHeader("Bearerxyz"), null);
  assert.equal(bearerFromHeader("Bearer"), null);
});
