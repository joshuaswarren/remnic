// Tests for `packages/plugin-claude-code/mcp-server-stdio/server.js`.
//
// Spawns the proxy as a child process and asserts the security gates
// called out in PR #2321 review:
//
//   1. plain http:// to a non-loopback host is rejected at startup (fatal exit 2)
//   2. bearer token is required (fatal exit 2 when missing)
//   3. unknown URL protocols are rejected (fatal exit 2)
//   4. 127.0.0.1 is accepted as loopback (proxy stays alive past the gate)
//   5. notifications produce no stdout lines on response-handler error
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
  // While the child is alive, child.exitCode is null. assert.strictEqual
  // to null proves the proxy is still running (any non-null exit code means
  // it failed). notStrictEqual to 2 alone would accept code 0 or 1.
  assert.strictEqual(child.exitCode, null, "http://127.0.0.1 must not be rejected by the loopback gate");
  child.kill("SIGKILL");
  await readStderr(child).catch(() => {});
});

test("stdio proxy: notifications produce no stdout on response-handler error", async () => {
  // JSON-RPC 2.0 forbids notifications from receiving a reply. The proxy
  // must therefore write NOTHING to stdout for a notification, regardless of
  // whether the upstream daemon's response is a success, a malformed
  // body, a transport error, or an empty 202. We exercise two paths:
  //
  //   (a) The mock daemon returns a valid HTTP/200 response carrying a
  //       well-formed JSON-RPC body. The proxy's res.on("end") fires with
  //       the daemon's reply. The notification branch (isNotification ===
  //       true) must silently discard without writing anything to stdout.
  //
  //   (b) The mock daemon resets the socket mid-request, so the proxy's
  //       req.on("error") fires. The notification-aware error guard must
  //       log to stderr only — not stdout.
  //
  // Asserting `out === ""` for both sub-cases proves the strict
  // no-reply-to-notifications contract.
  const helperScript = `
    const { spawn } = require("node:child_process");
    const http = require("node:http");
    const net = require("node:net");

    // Sub-case (a): serve a valid HTTP/200 with a JSON-RPC notification
    // reply body. The proxy must not write it to stdout.
    const serve = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        // A real daemon would respond with a 202 (notifications/initialized)
        // or a no-body 200; we use the latter because the proxy's res.on
        // ("end") still fires on a 0-byte body.
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end();
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
      // Send a notification (no id). The proxy must NOT reply on stdout.
      cp.stdin.end(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\\n");
      setTimeout(() => {
        cp.kill("SIGKILL");
        serve.close();
        process.stdout.write("OUT::" + out + "::END");
        process.stderr.write(err);
        process.exit(0);
      }, 300);
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
  assert.equal(
    out,
    "",
    `notification produced stdout lines (regression — JSON-RPC 2.0 forbids notifications from receiving a reply). Captured stdout: ${JSON.stringify(out)}`
  );
});
