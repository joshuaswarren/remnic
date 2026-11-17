"use strict";

// Issue #3451: the agy install completed green while the bundled
// mcp-server-stdio refused to start — a non-loopback plain-http daemon URL
// exits 2 without REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1, so remember/recall
// tools never registered. install-preflight.cjs must catch the same fatal
// config conditions at install time: fleet http fails loudly and names the
// opt-in, loopback and https pass clean.

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "install-preflight.cjs");

// The child sees only the daemon-url env vars under test; everything else
// that could satisfy the credential or opt-in checks is scrubbed so a
// developer's own shell env never leaks into the result.
function runPreflight(env = {}) {
  const clean = { ...process.env };
  for (const key of [
    "REMNIC_PLUGIN_DAEMON_URL",
    "REMNIC_DAEMON_URL",
    "ENGRAM_DAEMON_URL",
    "REMNIC_MCP_ALLOW_CLEARTEXT_HTTP",
  ]) {
    delete clean[key];
  }
  Object.assign(clean, env);
  return spawnSync(process.execPath, [SCRIPT], {
    env: clean,
    encoding: "utf8",
  });
}

test("fleet-http daemon URL without the opt-in fails loudly and names it", () => {
  const { status, stderr } = runPreflight({
    REMNIC_PLUGIN_DAEMON_URL: "http://192.0.2.1:4318",
  });
  assert.notEqual(status, 0, "preflight must exit nonzero for non-loopback http");
  assert.match(stderr, /192\.0\.2\.1/, "message names the daemon host");
  assert.match(stderr, /REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1/, "message names the opt-in");
  assert.match(stderr, /mcp-server-stdio/, "message names the component that refuses");
});

test("loopback http daemon URLs pass clean", () => {
  for (const url of ["http://127.0.0.1:4318", "http://localhost:4318/mcp"]) {
    const { status, stderr } = runPreflight({ REMNIC_PLUGIN_DAEMON_URL: url });
    assert.equal(status, 0, `${url} must pass`);
    assert.equal(stderr, "", `${url} must be silent`);
  }
});

test("a non-loopback https daemon URL passes clean", () => {
  const { status, stderr } = runPreflight({
    REMNIC_PLUGIN_DAEMON_URL: "https://192.0.2.1:4318",
  });
  assert.equal(status, 0);
  assert.equal(stderr, "");
});

test("fleet-http with the opt-in set passes with a warning", () => {
  const { status, stderr } = runPreflight({
    REMNIC_PLUGIN_DAEMON_URL: "http://192.0.2.1:4318",
    REMNIC_MCP_ALLOW_CLEARTEXT_HTTP: "1",
  });
  assert.equal(status, 0, "explicit opt-in must not block the install");
  assert.match(stderr, /cleartext/i, "the warning still says the token travels cleartext");
});

test("REMNIC_DAEMON_URL fallback is checked the same way", () => {
  const { status, stderr } = runPreflight({
    REMNIC_DAEMON_URL: "http://192.0.2.1:4318",
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1/);
});

test("no daemon URL env at all defaults to loopback and passes", () => {
  const { status, stderr } = runPreflight();
  assert.equal(status, 0);
  assert.equal(stderr, "");
});
