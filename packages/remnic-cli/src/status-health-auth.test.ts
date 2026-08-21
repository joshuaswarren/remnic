/**
 * Tests for the authenticated `remnic status` health probe (issue #2006).
 *
 * `cmdStatus` previously fetched `/engram/v1/health` with no Authorization
 * header, so an auth-enforcing daemon reported "401 Unauthorized" while
 * fully healthy — indistinguishable from a broken daemon during triage.
 *
 * The fix resolves a probe token via `resolveStatusProbeToken()` (env →
 * config `server.authToken` → first connector token from the local store →
 * undefined for open daemons) and sends `Authorization: Bearer` when one
 * is found. The fetch wiring is a two-line conditional; the load-bearing
 * logic is the precedence, so these tests exercise the resolver directly
 * via the `__statusHealthTestHooks` seam under temp-HOME isolation.
 *
 * (The full `cmdStatus` path can't be driven through the in-process
 * `runCli` harness: `PID_FILE` is a module-scope constant frozen at
 * import with the host HOME, so `isServiceRunning()` never sees the
 * temp dir — run-cli.ts documents this limitation itself.)
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { __statusHealthTestHooks } from "./index.js";

const resolveStatusProbeToken = __statusHealthTestHooks.resolveStatusProbeToken;

let tempHome = "";
let originalHome: string | undefined;
let originalAuthEnv: string | undefined;
let originalLegacyAuthEnv: string | undefined;
let originalConfigPath: string | undefined;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(path.join(os.tmpdir(), "remnic-status-test-home-"));
  process.env.HOME = tempHome;
  originalAuthEnv = process.env.REMNIC_AUTH_TOKEN;
  originalLegacyAuthEnv = process.env.ENGRAM_AUTH_TOKEN;
  originalConfigPath = process.env.REMNIC_CONFIG_PATH;
  // Point the dispatcher at an empty temp config so it does not pick up a
  // stray remnic.config.json the test runner dropped somewhere.
  process.env.REMNIC_CONFIG_PATH = path.join(tempHome, "remnic.config.json");
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAuthEnv === undefined) delete process.env.REMNIC_AUTH_TOKEN;
  else process.env.REMNIC_AUTH_TOKEN = originalAuthEnv;
  if (originalLegacyAuthEnv === undefined) delete process.env.ENGRAM_AUTH_TOKEN;
  else process.env.ENGRAM_AUTH_TOKEN = originalLegacyAuthEnv;
  if (originalConfigPath === undefined) delete process.env.REMNIC_CONFIG_PATH;
  else process.env.REMNIC_CONFIG_PATH = originalConfigPath;
  await rm(tempHome, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;
  await rm(path.join(tempHome, ".remnic"), { recursive: true, force: true });
  await rm(path.join(tempHome, ".config"), { recursive: true, force: true });
  await rm(process.env.REMNIC_CONFIG_PATH!, { force: true });
});

test("env REMNIC_AUTH_TOKEN wins over every other source", () => {
  process.env.REMNIC_AUTH_TOKEN = "env-operator-token";
  assert.equal(resolveStatusProbeToken(), "env-operator-token");
});

test("legacy env ENGRAM_AUTH_TOKEN is accepted when REMNIC_AUTH_TOKEN is unset", () => {
  process.env.ENGRAM_AUTH_TOKEN = "legacy-env-token";
  assert.equal(resolveStatusProbeToken(), "legacy-env-token");
});

test("falls back to config server.authToken when no env token is set", async () => {
  // resolveConfigPath() honours REMNIC_CONFIG_PATH (set in `before`).
  await writeFile(
    process.env.REMNIC_CONFIG_PATH!,
    JSON.stringify({ server: { authToken: "config-file-token" } }),
  );
  assert.equal(resolveStatusProbeToken(), "config-file-token");
});

test("falls back to the first connector token from the local token store", async () => {
  await mkdir(path.join(tempHome, ".remnic"), { recursive: true });
  await writeFile(
    path.join(tempHome, ".remnic", "tokens.json"),
    JSON.stringify({
      tokens: [
        { token: "second-connector-token", connector: "other", createdAt: "2026-07-18T00:00:00.000Z" },
        { token: "first-connector-token", connector: "primary", createdAt: "2026-07-17T00:00:00.000Z" },
      ],
    }),
  );
  // listTokens() returns store order; the first entry is what the probe uses.
  const token = resolveStatusProbeToken();
  assert.ok(typeof token === "string" && token.length > 0);
  assert.ok(token === "first-connector-token" || token === "second-connector-token");
});

test("returns undefined for an open daemon (no token anywhere) — probe stays unauthenticated", () => {
  assert.equal(resolveStatusProbeToken(), undefined);
});

test("env token takes precedence over a present config token", async () => {
  await writeFile(
    process.env.REMNIC_CONFIG_PATH!,
    JSON.stringify({ server: { authToken: "config-file-token" } }),
  );
  process.env.REMNIC_AUTH_TOKEN = "env-operator-token";
  assert.equal(resolveStatusProbeToken(), "env-operator-token");
});

test("skips chatgpt connector tokens (mcp-only) and uses the next ordinary connector token", async () => {
  await mkdir(path.join(tempHome, ".remnic"), { recursive: true });
  await writeFile(
    path.join(tempHome, ".remnic", "tokens.json"),
    JSON.stringify({
      tokens: [
        { token: "chatgpt-mcp-only-token", connector: "chatgpt", createdAt: "2026-07-18T00:00:00.000Z" },
        { token: "ordinary-connector-token", connector: "cli", createdAt: "2026-07-18T00:00:00.000Z" },
      ],
    }),
  );
  assert.equal(resolveStatusProbeToken(), "ordinary-connector-token");
});

test("returns undefined when the only connector token is chatgpt (mcp-only)", async () => {
  await mkdir(path.join(tempHome, ".remnic"), { recursive: true });
  await writeFile(
    path.join(tempHome, ".remnic", "tokens.json"),
    JSON.stringify({
      tokens: [{ token: "chatgpt-mcp-only-token", connector: "chatgpt", createdAt: "2026-07-18T00:00:00.000Z" }],
    }),
  );
  assert.equal(resolveStatusProbeToken(), undefined);
});

test("treats the \${REMNIC_AUTH_TOKEN} config placeholder as unresolved (falls through)", async () => {
  await writeFile(
    process.env.REMNIC_CONFIG_PATH!,
    JSON.stringify({ server: { authToken: "${REMNIC_AUTH_TOKEN}" } }),
  );
  // No env token, no connector store → undefined (placeholder did not leak).
  assert.equal(resolveStatusProbeToken(), undefined);
});

