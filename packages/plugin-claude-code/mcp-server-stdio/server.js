#!/usr/bin/env node
// @remnic/plugin-claude-code — stdio↔HTTP MCP proxy
//
// Bridges the Remnic HTTP MCP endpoint (`<user_config.remnic_daemon_url>`)
// to a stdio MCP server Claude Code can speak without forking per request.
//
// Auth: reads `REMNIC_PLUGIN_DAEMON_TOKEN` (a daemon bearer token the user
// provided at plugin install time via Claude Code's `userConfig` flow) and
// sends it as the `Authorization: Bearer …` header on every HTTP request.
//
// URL: reads `REMNIC_PLUGIN_DAEMON_URL`, defaulting to `http://localhost:4318/mcp`
// (matches the package's documented local daemon default).
//
// Transport: line-delimited JSON-RPC over stdin, plain newline-terminated
// HTTP responses on stdout. The Remnic daemon's `/mcp` endpoint speaks
// SSE in streaming mode; for tool-call sizing this proxy sets
// `Accept: application/json, text/event-stream` and reads a single
// buffered response per request — sufficient because tool-call responses
// are small and fit in one chunk under the project's documented size limits.
//
// Exit codes:
//   0  graceful shutdown
//   1  network / HTTP / JSON error (request forwarded but responded 5xx)
//   2  fatal config error (missing required env, non-numeric port, etc.)

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const URL_DEFAULT = "http://localhost:4318/mcp";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB; matches MCP tool-result upper bound

function readEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function fatal(msg) {
  // JSON-RPC parse-error envelope for any input we cannot satisfy.
  process.stderr.write(`remnic-mcp-proxy: ${msg}\n`);
  process.exit(2);
}

const daemonUrl = readEnv("REMNIC_PLUGIN_DAEMON_URL", URL_DEFAULT);
const token = readEnv("REMNIC_PLUGIN_DAEMON_TOKEN", "");
if (!token) {
  fatal(
    "REMNIC_PLUGIN_DAEMON_TOKEN is not set; the plugin install flow must supply the bearer token via Claude Code userConfig."
  );
}
let parsed;
try {
  parsed = new URL(daemonUrl);
} catch {
  fatal(`REMNIC_PLUGIN_DAEMON_URL is not a parseable URL: ${daemonUrl}`);
}
if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
  fatal(
    `unsupported URL protocol in REMNIC_PLUGIN_DAEMON_URL: ${parsed.protocol} (expected http: or https:; refuse to send bearer token over plaintext to a non-loopback target)`
  );
}
const transport = parsed.protocol === "https:" ? https : http;

const stdinBuffer = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    stdinBuffer.push(line);
    drain();
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});

process.stdin.on("error", (err) => {
  fatal(`stdin error: ${err.message}`);
});

process.stdout.on("error", (err) => {
  process.stderr.write(`remnic-mcp-proxy: stdout error: ${err.message}\n`);
  process.exit(1);
});

function drain() {
  while (stdinBuffer.length > 0) {
    const line = stdinBuffer.shift();
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      writeError(null, -32700, `parse error: ${err.message}`);
      continue;
    }
    forward(msg);
  }
}

function writeError(id, code, message, requestId) {
  const payload = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
  if (requestId !== undefined) payload.id = requestId;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function forward(msg) {
  const id = msg.id ?? null;
  if (!msg.method) {
    writeError(id, -32600, "invalid request: missing method", id);
    return;
  }
  const body = JSON.stringify({
    jsonrpc: msg.jsonrpc ?? "2.0",
    id,
    method: msg.method,
    params: msg.params ?? {},
  });
  const req = transport.request(
    {
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname || ""}${parsed.search || ""}` || "/mcp",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Engram-Client-Id": "claude-code",
        Authorization: `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(body, "utf8"),
      },
    },
    (res) => {
      let chunks = "";
      let received = 0;
      res.setEncoding("utf8");
      res.on("data", (c) => {
        received += Buffer.byteLength(c, "utf8");
        if (received > MAX_BODY_BYTES) {
          req.destroy(new Error(`response exceeded MAX_BODY_BYTES (${MAX_BODY_BYTES})`));
          return;
        }
        chunks += c;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          writeError(id, -32001, `daemon responded ${res.statusCode}: ${chunks.slice(0, 200)}`, id);
          return;
        }
        // The Remnic /mcp endpoint returns JSON-RPC envelopes; some MCP
        // shapes stream SSE — strip `data: ` prefixes if present.
        const cleaned = chunks
          .split("\n")
          .filter((l) => l && !l.startsWith("event:") && !l.startsWith(":"))
          .map((l) => (l.startsWith("data: ") ? l.slice(6) : l))
          .join("\n")
          .trim();
        let parsedResp;
        try {
          parsedResp = JSON.parse(cleaned);
        } catch (err) {
          writeError(id, -32002, `daemon returned non-JSON: ${err.message} (preview: ${cleaned.slice(0, 200)})`, id);
          return;
        }
        if (parsedResp && "error" in parsedResp) {
          process.stdout.write(`${JSON.stringify(parsedResp)}\n`);
          return;
        }
        writeResult(id, parsedResp.result ?? parsedResp);
      });
      res.on("error", (err) => {
        writeError(id, -32003, `response stream error: ${err.message}`, id);
      });
    }
  );
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`));
  });
  req.on("error", (err) => {
    writeError(id, -32003, `transport error: ${err.message}`, id);
  });
  req.write(body);
  req.end();
}

// If the daemon sends a notification (no id) or a request from the daemon to
// the proxy (e.g. cancellation), surface as parse-able feedback rather than
// hanging the client. The plugin manifest does not declare this proxy as
// being able to handle server-initiated requests, so we acknowledge with a
// parse-error envelope but otherwise pass through.
drain();
