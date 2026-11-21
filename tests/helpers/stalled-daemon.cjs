"use strict";

// Two daemon front addresses that never finish a request, for testing that
// every client call to the daemon carries one deadline covering connect plus
// response. An idle timer (Node's req.setTimeout) does not hold the caller's
// budget against either of them.
//
// startBlackhole: an address that drops packets instead of refusing them,
// the shape of a REMNIC_DAEMON_URL whose host is down or firewalled. A child
// process listens with a backlog of 1 and then blocks its event loop so it
// never accepts. Once the kernel accept queue is full, every further SYN is
// dropped and a client sits in SYN_SENT, as it would against a black-holed
// address. req.setTimeout() does not arm until the socket connects, so the
// caller's budget is ignored: only the default agent's 5s socket timeout
// (Node 19+) or the kernel's ~2 min SYN retry limit ends the attempt.

const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");

const LISTENER_SRC = `
const server = require("node:net").createServer();
server.listen(0, "127.0.0.1", 1, () => {
  process.stdout.write(server.address().port + "\\n", () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
});`;
const PROBE_MS = 300;
const MAX_FILLERS = 64;

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const timer = setTimeout(() => resolve({ socket, state: "pending" }), PROBE_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({ socket, state: "connected" });
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve({ socket, state: "refused" });
    });
  });
}

// Resolves { url, close } once a fresh connection to the port hangs, or null
// when the platform answers every SYN and cannot simulate a black hole.
async function startBlackhole() {
  const child = spawn(process.execPath, ["-e", LISTENER_SRC], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (d) => resolve(Number(String(d).trim())));
  });
  const sockets = [];
  const close = () => {
    for (const s of sockets) s.destroy();
    child.kill("SIGKILL");
  };
  for (let i = 0; i < MAX_FILLERS; i++) {
    const { socket, state } = await probe(port);
    sockets.push(socket);
    if (state === "pending") return { url: `http://127.0.0.1:${port}`, close };
    if (state === "refused") break;
  }
  close();
  return null;
}

// startTricklingDaemon: a front that accepts, sends 200 headers, then writes
// one byte of body every 500ms and never ends, like a proxy relaying a stuck
// upstream. Each byte resets an idle timer, so only an absolute deadline ends
// the request.
function startTricklingDaemon() {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    const timer = setInterval(() => res.write(" "), 500);
    res.on("close", () => clearInterval(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

// Send one JSON-RPC request through a stdio MCP proxy (server.js) aimed at
// `daemonUrl`. Resolves with the proxy's first reply (null when the proxy was
// still waiting at `killAfterMs`), the kill signal, and every stdout line so a
// caller can check the request got exactly one reply.
function callMcpProxy(serverPath, daemonUrl, { killAfterMs }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        REMNIC_PLUGIN_DAEMON_URL: `${daemonUrl}/mcp`,
        REMNIC_PLUGIN_DAEMON_TOKEN: "test-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let reply = null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find((l) => l.trim());
      if (reply === null && line && stdout.includes("\n")) {
        reply = { message: JSON.parse(line), elapsedMs: Date.now() - startedAt };
        child.stdin.end();
      }
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    child.on("error", reject);
    child.on("close", (_code, signal) => {
      clearTimeout(killer);
      const lines = stdout.split("\n").filter((l) => l.trim());
      resolve({ reply, signal, lines, elapsedMs: Date.now() - startedAt });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  });
}

module.exports = { startBlackhole, startTricklingDaemon, callMcpProxy };
