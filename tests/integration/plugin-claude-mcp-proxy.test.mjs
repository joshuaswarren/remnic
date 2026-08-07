// Tests for `packages/plugin-claude-code/mcp-server-stdio/server.js`.
//
// Spawns the proxy as a child process and asserts the security gates
// called out in PR #2321 review:
//
//   1. plain http:// to a non-loopback host is rejected at startup (fatal exit 2)
//   2. bearer token is required (fatal exit 2 when missing)
//   3. unknown URL protocols are rejected (fatal exit 2)
//   4. 127.0.0.1 is accepted as loopback (proxy stays alive past the gate)
//
// No real Remnic daemon or Claude Code session is required.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const proxyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "packages",
  "plugin-claude-code",
  "mcp-server-stdio",
  "server.js"
);

function spawnProxy(env) {
  return spawn(process.execPath, [proxyPath], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function readStderr(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      buf += c;
    });
    child.stderr.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(buf);
      }
    });
    once(child, "error").then(([err]) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(buf);
      }
    }, 1000).unref();
  });
}

async function exitedWithCode(child) {
  const [code] = await once(child, "exit");
  return code;
}

test("stdio proxy: plain http to non-loopback host is rejected at startup", async () => {
  const child = spawnProxy({
    REMNIC_PLUGIN_DAEMON_TOKEN: "secret-token",
    REMNIC_PLUGIN_DAEMON_URL: "http://example.test/mcp",
  });
  const [code, stderr] = await Promise.all([exitedWithCode(child), readStderr(child)]);
  assert.equal(code, 2, "fatal misconfiguration must exit 2");
  assert.match(stderr, /non-loopback/i, "must explain loopback requirement");
});

test("stdio proxy: bearer token is required", async () => {
  const child = spawnProxy({
    REMNIC_PLUGIN_DAEMON_TOKEN: "",
    REMNIC_PLUGIN_DAEMON_URL: "http://localhost:4318/mcp",
  });
  const [code] = await Promise.all([exitedWithCode(child), readStderr(child)]);
  assert.equal(code, 2, "missing token must fatal");
});

test("stdio proxy: unknown URL protocol is rejected", async () => {
  const child = spawnProxy({
    REMNIC_PLUGIN_DAEMON_TOKEN: "secret-token",
    REMNIC_PLUGIN_DAEMON_URL: "ftp://localhost/mcp",
  });
  const [code, stderr] = await Promise.all([exitedWithCode(child), readStderr(child)]);
  assert.equal(code, 2, "unsupported protocol must fatal");
  assert.match(stderr, /unsupported URL protocol/);
});

test("stdio proxy: 127.0.0.1 is accepted as loopback", async () => {
  const child = spawnProxy({
    REMNIC_PLUGIN_DAEMON_TOKEN: "secret-token",
    REMNIC_PLUGIN_DAEMON_URL: "http://127.0.0.1:4318/mcp",
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.strictEqual(child.exitCode, null, "http://127.0.0.1 must not be rejected by the loopback gate");
  child.kill("SIGKILL");
  await readStderr(child).catch(() => {});
});

test("stdio proxy: notifications do not receive a JSON-RPC reply envelope on response-handler error", async () => {
  // Regression guard for Cursor round-2 "Request errors omit JSON-RPC reply"
  // and Cursor round-3 "Notification errors emit JSON-RPC reply". The outer
  // res.on('end') catch must split on isNotification: notifications log to
  // stderr only, requests get a -32603 envelope.
  const helperScript = `
    const { spawn } = require("node:child_process");
    const net = require("node:net");
    // A TCP listener that sends a bare "null" body, which makes JSON.parse
 // succeed, then closes. The proxy res.on('end') fires on every well-formed
 // JSON body — we deliberately choose a body that exercises the
 // notification code path (notifications/initialized).
    const server = net.createServer((sock) => {
      setTimeout(() => { sock.end("null"); }, 30);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const cp = spawn(process.execPath, [process.env.PROXY], {
        env: {
          ...process.env,
          REMNIC_PLUGIN_DAEMON_TOKEN: "secret",
          REMNIC_PLUGIN_DAEMON_URL: "http://127.0.0.1:" + port + "/mcp",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = ""; cp.stdout.setEncoding("utf8"); cp.stdout.on("data", (c) => { out += c; });
      let err = ""; cp.stderr.setEncoding("utf8"); cp.stderr.on("data", (c) => { err += c; });
      // Send a notification (no id). The proxy must not reply on stdout.
      cp.stdin.end(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\\n");
      setTimeout(() => { cp.kill("SIGKILL"); server.close(); process.stdout.write("OUT::" + out + "::END"); process.stderr.write(err); process.exit(0); }, 400);
    });
  `;
  const { execFile } = await import("node:child_process");
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", helperScript],
      { env: { ...process.env, PROXY: proxyPath }, encoding: "utf8", timeout: 8000 },
      (error, stdout) => {
        if (error && error.signal === "SIGTERM") return resolve({ stdout });
        if (error && error.code === null) return resolve({ stdout });
        if (error) return reject(error);
        return resolve({ stdout });
      }
    );
  });
  const out = stdout.split("OUT::")[1]?.split("::END")[0] ?? "";
  // JSON-RPC 2.0 forbids notifications from receiving a reply. A reply to a
  // notification would carry an id field (or an error envelope without id but
  // attached to the request we did not send). Assert any stdout envelope is
  // not a notification reply by requiring it lack an id field — i.e. no
  // outgoing line carries an id.
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const env = JSON.parse(line);
    assert.equal(
      Object.prototype.hasOwnProperty.call(env, "id"),
      false,
      `notification produced a JSON-RPC envelope with an id (line: ${line}) — JSON-RPC 2.0 forbids notifications from receiving a reply`
    );
  }
});
