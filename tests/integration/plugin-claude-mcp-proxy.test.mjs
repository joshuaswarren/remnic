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
  assert.notStrictEqual(child.exitCode, 2, "http://127.0.0.1 must not be rejected by the loopback gate");
  child.kill("SIGKILL");
  await readStderr(child).catch(() => {});
});
