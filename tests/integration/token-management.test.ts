import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const TOKENS_SRC = path.join(ROOT, "packages/remnic-core/src/tokens.ts");

// Use a temp dir so we don't pollute the real tokens.json
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-token-test-"));
const tmpTokensPath = path.join(tmpDir, "tokens.json");

// We can't import @remnic/core directly from node:test runner without tsx,
// so validate the token module exists and has correct structure via source analysis.

test("tokens.ts exports required functions", () => {
  const content = fs.readFileSync(TOKENS_SRC, "utf-8");
  const requiredExports = [
    "generateToken",
    "listTokens",
    "revokeToken",
    "getAllValidTokens",
    "resolveConnectorFromToken",
    "loadTokenStore",
    "saveTokenStore",
  ];
  for (const name of requiredExports) {
    assert.ok(content.includes(`export function ${name}`), `tokens.ts must export ${name}`);
  }
});

test("tokens.ts defines TokenEntry and TokenStore types", () => {
  const content = fs.readFileSync(TOKENS_SRC, "utf-8");
  assert.ok(content.includes("export interface TokenEntry"), "Must export TokenEntry");
  assert.ok(content.includes("export interface TokenStore"), "Must export TokenStore");
});

test("tokens.ts uses remnic_ prefix convention for known connectors", () => {
  const content = fs.readFileSync(TOKENS_SRC, "utf-8");
  const expectedPrefixes = [
    '"openclaw": "remnic_oc_"',
    '"claude-code": "remnic_cc_"',
    '"codex": "remnic_cx_"',
    '"hermes": "remnic_hm_"',
    '"replit": "remnic_rl_"',
  ];
  for (const prefix of expectedPrefixes) {
    assert.ok(content.includes(prefix), `Must define prefix ${prefix}`);
  }
});

test("tokens.ts writes file with 0o600 permissions", () => {
  const content = fs.readFileSync(TOKENS_SRC, "utf-8");
  assert.ok(content.includes("0o600"), "Must set file mode to 0o600 (owner-only)");
  assert.ok(
    content.includes("fs.openSync(tmpPath") || content.includes("fs.chmodSync(p, 0o600"),
    "Must apply owner-only permissions while writing the token store",
  );
});

test("tokens.ts default path is ~/.remnic/tokens.json with legacy Engram fallback", () => {
  const content = fs.readFileSync(TOKENS_SRC, "utf-8");
  assert.ok(content.includes('.remnic", "tokens.json"'), "Default path must be ~/.remnic/tokens.json");
  assert.ok(content.includes('.engram", "tokens.json"'), "Legacy path fallback must remain ~/.engram/tokens.json");
});

test("tokens.ts generates 24 random bytes (48 hex chars) per token", () => {
  const content = fs.readFileSync(TOKENS_SRC, "utf-8");
  assert.ok(content.includes("randomBytes(24)"), "Must use 24 random bytes");
  assert.ok(content.includes('.toString("hex")'), "Must encode as hex");
});

test("tokens.ts removes old token before generating new one for same connector", () => {
  const content = fs.readFileSync(TOKENS_SRC, "utf-8");
  assert.ok(
    content.includes('store.tokens = store.tokens.filter((t) => t.connector !== connector)'),
    "Must filter out old token before adding new one",
  );
});

test("tokens.ts handles legacy flat-map token format migration", () => {
  const content = fs.readFileSync(TOKENS_SRC, "utf-8");
  assert.ok(
    content.includes("Migrate legacy flat-map format"),
    "Must handle legacy { connector: token } format",
  );
  assert.ok(
    content.includes("Auto-migrate legacy flat-map stores in new format"),
    "Must auto-migrate legacy format to new format",
  );
});

// Cleanup
test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    // ignore
  }
});
