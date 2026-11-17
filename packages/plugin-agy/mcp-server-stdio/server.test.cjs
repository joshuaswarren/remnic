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

test("bare base URL without a path targets the /mcp endpoint", async () => {
  // Regression: a bare REMNIC_PLUGIN_DAEMON_URL (no path) must resolve to
  // /mcp, not /. Spawn a mock that only answers /mcp and send it a
  // tools/list through the proxy; a path bug surfaces as -32001.
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/mcp") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: { tools: [] } }));
      } else {
        res.writeHead(404);
        res.end(`unexpected path ${req.url}`);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const home = mkHome();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      HOME: home,
      REMNIC_PLUGIN_DAEMON_URL: `http://127.0.0.1:${port}`,
      REMNIC_PLUGIN_DAEMON_TOKEN: "test-token",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  child.stdin.write(`${request}\n`);
  child.stdin.end();
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(""), 5000);
    const chunks = [];
    child.stdout.on("data", (c) => {
      chunks.push(c.toString());
      const text = chunks.join("");
      const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve(line);
      }
    });
  });
  server.close();
  try { child.kill(); } catch { /* exited */ }
  fs.rmSync(home, { recursive: true, force: true });
  assert.match(reply, /"result"\s*:\s*\{\s*"tools"/, "bare base URL reached /mcp");
});

test("loopback http starts without warning or refusal", async () => {
  const { code, stderr } = await runProxy("http://127.0.0.1:4318/mcp");
  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /cleartext|refuse/);
});
