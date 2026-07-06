#!/usr/bin/env node
/**
 * Fake LSP server — a scripted JSON-RPC-over-stdio responder for tests.
 *
 * Checked into the package's test fixtures. Synthetic responses only —
 * it does NOT analyze code. Instead it reads a scenario from argv and
 * produces canned LSP-shaped responses that match the real protocol
 * wire format (rule 33 — cite spec version: LSP 3.17).
 *
 * Scenario is passed as the LAST argv element (after `--`):
 *
 *   node fake-server.mjs -- <scenario-name>
 *
 * Scenarios:
 *   happy             — full handshake + returns definition locations.
 *   missing           — exits immediately with code 1.
 *   handshake_timeout — accepts initialize request but never responds.
 *   request_timeout   — completes handshake but never responds to definition.
 *   protocol_error    — sends a malformed frame after receiving initialize.
 *   crash_after_start — completes handshake, then exits mid-run.
 */

import process from "node:process";

const scenario = process.argv[process.argv.length - 1];

// ──────────────────────────────────────────────────────────────────────────
// Persistent stdin buffer — survives across readFrame calls so data from
// a combined chunk that contains multiple frames is not lost.
// ──────────────────────────────────────────────────────────────────────────

let stdinBuf = "";
let stdinWaiters = [];

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  // Notify all waiters that new data arrived.
  const waiters = stdinWaiters;
  stdinWaiters = [];
  for (const w of waiters) w();
});
process.stdin.on("end", () => {
  const waiters = stdinWaiters;
  stdinWaiters = [];
  for (const w of waiters) w();
});

/** Wait for more stdin data to arrive. */
function waitForData() {
  const { promise, resolve } = Promise.withResolvers();
  stdinWaiters.push(resolve);
  return promise;
}

// ──────────────────────────────────────────────────────────────────────────
// Frame I/O helpers — read/write Content-Length-prefixed messages.
// ──────────────────────────────────────────────────────────────────────────

function writeFrame(obj) {
  const body = JSON.stringify(obj);
  const byteLength = Buffer.byteLength(body, "utf8");
  process.stdout.write(`Content-Length: ${byteLength}\r\n\r\n${body}`);
}

async function readFrame() {
  // Loop until we have a complete frame in the persistent buffer.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const sep = stdinBuf.indexOf("\r\n\r\n");
    if (sep < 0) {
      // No complete header yet — wait for more data.
      if (stdinBuf === null) return null; // stdin ended
      await waitForData();
      continue;
    }
    const header = stdinBuf.slice(0, sep);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      // Malformed — treat as end of stream.
      return null;
    }
    const contentLength = Number(match[1]);
    const bodyStart = sep + 4;
    const bodyEnd = bodyStart + contentLength;
    if (stdinBuf.length < bodyEnd) {
      // Body not fully received — wait for more.
      await waitForData();
      continue;
    }
    const body = stdinBuf.slice(bodyStart, bodyEnd);
    // Consume the frame from the persistent buffer, keeping any residual.
    stdinBuf = stdinBuf.slice(bodyEnd);
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Scenario handlers
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  switch (scenario) {
    case "missing":
      process.exit(1);

    case "handshake_timeout":
      await readFrame(); // consume initialize, never respond
      await new Promise(() => {}); // hang forever
      return;

    case "request_timeout": {
      const init = await readFrame();
      writeFrame({
        jsonrpc: "2.0",
        id: init.id,
        result: {
          capabilities: { definitionProvider: true },
          serverInfo: { name: "fake-timeout" },
        },
      });
      await readFrame(); // initialized
      await readFrame(); // definition request — never respond
      await new Promise(() => {});
      return;
    }

    case "protocol_error": {
      await readFrame(); // initialize
      process.stdout.write("THIS IS NOT A VALID LSP FRAME\r\n\r\n");
      process.exit(0);
      return;
    }

    case "crash_after_start": {
      const init = await readFrame();
      writeFrame({
        jsonrpc: "2.0",
        id: init.id,
        result: {
          capabilities: { definitionProvider: true },
          serverInfo: { name: "fake-crash" },
        },
      });
      await readFrame(); // initialized
      process.exit(1); // crash mid-run
      return;
    }

    case "happy":
    default: {
      const init = await readFrame();
      if (!init) return;
      writeFrame({
        jsonrpc: "2.0",
        id: init.id,
        result: {
          capabilities: { definitionProvider: true },
          serverInfo: { name: "fake-happy", version: "1.0.0" },
        },
      });
      await readFrame(); // initialized
      await readFrame(); // didOpen

      // Answer definition/shutdown/exit until stdin closes.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const req = await readFrame();
        if (!req) return;
        if (req.method === "textDocument/definition") {
          const envLoc = process.env.FAKE_LSP_DEFINITION;
          const result = envLoc
            ? JSON.parse(envLoc)
            : [
                {
                  uri: "file:///fake/src/target.ts",
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 10 },
                  },
                },
              ];
          writeFrame({ jsonrpc: "2.0", id: req.id, result });
        } else if (req.method === "shutdown") {
          writeFrame({ jsonrpc: "2.0", id: req.id, result: null });
        } else if (req.method === "exit") {
          process.exit(0);
        }
      }
    }
  }
}

main().catch(() => process.exit(1));
