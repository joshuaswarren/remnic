// Tests for `packages/plugin-claude-code/mcp-server-stdio/server.js`.
//
// Spawns the proxy as a child process and asserts the security gates
// called out in PR #2321 review:
//
//   1. plain http:// to a non-loopback host is rejected at startup (fatal exit 2)
//   2. bearer token is required (fatal exit 2 when missing)
//   3. unknown URL protocols are rejected (fatal exit 2)
//   4. 127.0.0.1 is accepted as loopback (proxy stays alive past the gate)
//   5. notifications produce no stdout lines on either the response-handler
//      success path (HTTP/200 with a JSON-RPC reply body) or the transport-
//      error path (TCP RST mid-request) — JSON-RPC 2.0 forbids notifications
//      from receiving a reply in either case.
//
// No real Remnic daemon or Claude Code session is required.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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

// Run a helper script that the caller writes to exercise a specific
// scenario against the proxy. The helper MUST emit two framed fields on
// stdout before exiting:
//   - `REQ::true|false` — true when the proxy actually sent its request
//     bytes to the mock listener (i.e. the scenario under test was reached).
//     A test scenario that never reaches the listener would silently pass
//     without exercising the proxy at all, so the harness requires this flag
//     to be true.
//   - `OUT::…::END` — captured proxy stdout (notifications should produce
//     empty `OUT`; requests that produce stdout are checked by the caller).
//
// The harness rejects any execFile error other than the natural SIGTERM/zero
// exit that the helper reaches after the proxy completes its scenario.
async function runProxyAgainstHelper(helperScript, timeoutMs = 8000) {
  const framed = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", helperScript],
      { env: { ...process.env, PROXY: proxyPath }, encoding: "utf8", timeout: timeoutMs },
      (error, stdout, stderr) => {
        // The helper self-exits after the scenario completes; both
        // SIGTERM (execFile timeout) and `error.code === null` are
        // accepted as natural completion signals.
        if (error && error.signal !== "SIGTERM" && error.code !== null) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
  const outSection = framed.stdout.split("OUT::")[1]?.split("::END")[0] ?? "";
  const reqSection = framed.stdout.split("REQ::")[1]?.split("\n")[0]?.trim();
  if (reqSection !== "true") {
    throw new Error(
      `proxy never reached the mock listener for this scenario (REQ::${reqSection ?? "<missing>"}). Captured stdout: ${JSON.stringify(framed.stdout.slice(0, 500))}, stderr: ${JSON.stringify(framed.stderr.slice(0, 500))}`
    );
  }
  return outSection;
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
  // While the child is alive, child.exitCode is null. assert.strictEqual
  // to null proves the proxy is still running (any non-null exit code means
  // it failed). notStrictEqual to 2 alone would accept code 0 or 1.
  assert.strictEqual(child.exitCode, null, "http://127.0.0.1 must not be rejected by the loopback gate");
  child.kill("SIGKILL");
  await readStderr(child).catch(() => {});
});

test("stdio proxy: notification on response-handler success produces no stdout", async () => {
  // Sub-case (a): the upstream daemon returns a valid HTTP/200 with a
  // JSON-RPC notification reply body. The proxy's res.on("end") fires
  // with the daemon's reply; the notification branch (isNotification ===
  // true) must silently discard without writing anything to stdout.
  const helper = `
    const { spawn } = require("node:child_process");
    const http = require("node:http");
    let reqReceived = false;
    const serve = http.createServer((req, res) => {
      reqReceived = true;
      req.on("data", () => {});
      req.on("end", () => {
        // Daemon returns a valid JSON-RPC envelope — the proxy's
        // notification branch must NOT relay it on stdout.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }));
      });
    });
    serve.listen(0, "127.0.0.1", () => {
      const port = serve.address().port;
      const cp = spawn(process.execPath, [process.env.PROXY], {
        env: {
          ...process.env,
          REMNIC_PLUGIN_DAEMON_TOKEN: "secret-token",
          REMNIC_PLUGIN_DAEMON_URL: "http://127.0.0.1:" + port + "/mcp",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = ""; cp.stdout.setEncoding("utf8"); cp.stdout.on("data", (c) => { out += c; });
      let err = ""; cp.stderr.setEncoding("utf8"); cp.stderr.on("data", (c) => { err += c; });
      // Send a notification (no id).
      cp.stdin.end(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\\n");
      setTimeout(() => {
        cp.kill("SIGKILL");
        serve.close();
        process.stdout.write("REQ::" + (reqReceived ? "true" : "false") + "\\n");
        process.stdout.write("OUT::" + out + "::END");
        process.stderr.write(err);
        process.exit(0);
      }, 300);
    });
  `;
  const out = await runProxyAgainstHelper(helper);
  assert.equal(
    out,
    "",
    `notification produced stdout lines on the response-handler success path (regression — JSON-RPC 2.0 forbids notifications from receiving a reply). Captured stdout: ${JSON.stringify(out)}`
  );
});

test("stdio proxy: notification on transport error produces no stdout", async () => {
  // Sub-case (b): the upstream daemon accepts the TCP connection then
  // resets the socket mid-request, so the proxy's req.on("error") fires.
  // The notification-aware error guard must log to stderr only — never
  // stdout — even though the daemon never produced an HTTP response at
  // all.
  const helper = `
    const { spawn } = require("node:child_process");
    const net = require("node:net");
    let reqReceived = false;
    // A minimal TCP server that accepts a connection, lets the proxy
    // write its request bytes, then resets the socket so the proxy sees
    // an ECONNRESET on req.
    const server = net.createServer((sock) => {
      sock.on("data", () => {
        reqReceived = true;
        // Wait for the proxy's POST to land, then reset.
        setImmediate(() => {
          try { sock.resetAndDestroy(); } catch (_) { try { sock.destroy(); } catch (_) {} }
        });
      });
      sock.on("error", () => {}); // swallow EPIPE etc.
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const cp = spawn(process.execPath, [process.env.PROXY], {
        env: {
          ...process.env,
          REMNIC_PLUGIN_DAEMON_TOKEN: "secret-token",
          REMNIC_PLUGIN_DAEMON_URL: "http://127.0.0.1:" + port + "/mcp",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = ""; cp.stdout.setEncoding("utf8"); cp.stdout.on("data", (c) => { out += c; });
      let err = ""; cp.stderr.setEncoding("utf8"); cp.stderr.on("data", (c) => { err += c; });
      // Send a notification (no id). The daemon RSTs mid-request, so the
      // proxy's req.on("error") fires — must not write to stdout.
      cp.stdin.end(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\\n");
      setTimeout(() => {
        cp.kill("SIGKILL");
        server.close();
        process.stdout.write("REQ::" + (reqReceived ? "true" : "false") + "\\n");
        process.stdout.write("OUT::" + out + "::END");
        process.stderr.write(err);
        process.exit(0);
      }, 400);
    });
  `;
  const out = await runProxyAgainstHelper(helper);
  assert.equal(
    out,
    "",
    `notification produced stdout lines on the transport-error path (regression — JSON-RPC 2.0 forbids notifications from receiving a reply). Captured stdout: ${JSON.stringify(out)}`
  );
});
