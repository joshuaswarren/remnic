"use strict";

// Spawn tests for the stdio->HTTP MCP proxy's cleartext-http gate
// (post-merge review of #3435 / fix #3438). Each case runs the real
// server.js as a child process and asserts on exit code and stderr.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "server.js");

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remnic-mcp-proxy-test-"));
}

// Spawn server.js with stdin kept open until `release()` is called, so a
// started proxy stays alive long enough to observe its stderr. Resolves
// with { code, stderr } once the process exits.
function runProxy(url, { env = {}, releaseAfterMs = 300 } = {}) {
  const home = mkHome();
  const childEnv = { ...process.env, HOME: home };
  // The opt-in must not leak in from the developer's shell: the
  // default-refusal case has to run with the variable truly unset.
  delete childEnv.REMNIC_MCP_ALLOW_CLEARTEXT_HTTP;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...childEnv,
        REMNIC_PLUGIN_DAEMON_URL: url,
        REMNIC_PLUGIN_DAEMON_TOKEN: "test-token",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.on("data", (c) => (stdout += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
    // If the process is still alive after the grace window it started
    // successfully: close stdin so it drains and exits.
    setTimeout(() => {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
    }, releaseAfterMs);
  });
}

test("refuses plain http to a non-loopback host (exit 2)", async () => {
  const { code, stderr } = await runProxy("http://192.0.2.1:4318/mcp");
  assert.equal(code, 2);
  assert.match(stderr, /refuse to send bearer token cleartext/);
});

test("REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1 warns and starts", async () => {
  const { code, stderr } = await runProxy("http://192.0.2.1:4318/mcp", {
    env: { REMNIC_MCP_ALLOW_CLEARTEXT_HTTP: "1" },
  });
  assert.equal(code, 0);
  assert.match(stderr, /WARNING: REMNIC_PLUGIN_DAEMON_URL uses plain http/);
  assert.match(stderr, /REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1/);
});

test("a non-1 opt-out value still refuses", async () => {
  for (const value of ["true", "yes", "0", ""]) {
    const { code, stderr } = await runProxy("http://192.0.2.1:4318/mcp", {
      env: { REMNIC_MCP_ALLOW_CLEARTEXT_HTTP: value },
    });
    assert.equal(code, 2, `value ${JSON.stringify(value)} should refuse`);
    assert.match(stderr, /refuse to send bearer token cleartext/);
  }
});

test("loopback http starts without warning or refusal", async () => {
  const { code, stderr } = await runProxy("http://127.0.0.1:4318/mcp");
  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /cleartext|refuse/);
});
