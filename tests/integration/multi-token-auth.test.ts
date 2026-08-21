import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Multi-token auth — access-http accepts both primary and connector tokens
// ---------------------------------------------------------------------------

test("EngramAccessHttpServer options accepts authTokens array", async () => {
  // Verify the type accepts authTokens
  const accessHttpPath = path.join(ROOT, "packages/remnic-core/src/access-http.ts");
  const content = fs.readFileSync(accessHttpPath, "utf-8");
  assert.ok(content.includes("authTokens"), "access-http.ts must define authTokens option");
  assert.ok(content.includes("authTokens?: string[]"), "authTokens must be string[]");
});

test("EngramAccessHttpServer isAuthorized checks both primary and connector tokens", async () => {
  const accessHttpPath = path.join(ROOT, "packages/remnic-core/src/access-http.ts");
  const content = fs.readFileSync(accessHttpPath, "utf-8");
  // Verify the isAuthorized method checks both token sources
  assert.ok(content.includes("this.authTokens"), "Must check authTokens array");
  assert.ok(content.includes("for (const valid of this.authTokens)"), "Must iterate connector tokens");
});

test("Server loads connector tokens dynamically via authTokensGetter", async () => {
  const serverPath = path.join(ROOT, "packages/remnic-server/src/index.ts");
  const content = fs.readFileSync(serverPath, "utf-8");
  assert.ok(content.includes("getAllValidTokens"), "Server must import getAllValidTokens");
  assert.ok(content.includes("authTokensGetter"), "Server must use authTokensGetter for dynamic token loading");
});

// ---------------------------------------------------------------------------
// Package dependency validation
// ---------------------------------------------------------------------------

test("@remnic/core exports token management functions", async () => {
  const indexPath = path.join(ROOT, "packages/remnic-core/src/index.ts");
  const content = fs.readFileSync(indexPath, "utf-8");
  const requiredExports = ["generateToken", "listTokens", "revokeToken", "getAllValidTokens", "resolveConnectorFromToken"];
  for (const name of requiredExports) {
    assert.ok(content.includes(name), `@remnic/core must export ${name}`);
  }
});

test("@remnic/cli imports token management from @remnic/core", async () => {
  const cliPath = path.join(ROOT, "packages/remnic-cli/src/index.ts");
  const content = fs.readFileSync(cliPath, "utf-8");
  assert.ok(content.includes("generateToken"), "CLI must import generateToken");
  assert.ok(content.includes("listTokens"), "CLI must import listTokens");
  assert.ok(content.includes("revokeToken"), "CLI must import revokeToken");
});
