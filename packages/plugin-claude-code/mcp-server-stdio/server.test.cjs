"use strict";

// Spawn test for the stdio->HTTP MCP proxy's request deadline. A daemon front
// that accepts and then never finishes the response must not hold an MCP tool
// call past REQUEST_TIMEOUT_MS (30s): the proxy answers with a timeout error
// instead of waiting on an idle timer the trickle keeps alive.

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const { startTricklingDaemon, callMcpProxy } = require("../../../tests/helpers/stalled-daemon.cjs");

const SERVER = path.join(__dirname, "server.js");

test("trickling daemon front: the request fails at its 30s deadline", async () => {
  const front = await startTricklingDaemon();
  try {
    const { reply, signal, lines, elapsedMs } = await callMcpProxy(SERVER, front.url, { killAfterMs: 45000 });
    assert.ok(reply, `proxy never answered (signal=${signal}, ${elapsedMs}ms)`);
    assert.ok(reply.elapsedMs < 37000, `proxy answered after ${reply.elapsedMs}ms against a 30s deadline`);
    assert.equal(reply.message.id, 1);
    assert.match(reply.message.error.message, /request timed out after 30000ms/);
    assert.equal(lines.length, 1, `expected one reply, got:\n${lines.join("\n")}`);
  } finally {
    front.close();
  }
});
