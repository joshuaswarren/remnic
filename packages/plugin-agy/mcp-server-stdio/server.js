#!/usr/bin/env node
// Bridges the Remnic HTTP MCP endpoint to a stdio MCP server Antigravity CLI (agy) can
// speak. Same transport contract as @remnic/plugin-claude-code's proxy; the
// difference is credential resolution (see below).
//
// URL: reads `REMNIC_PLUGIN_DAEMON_URL`, defaulting to `http://localhost:4318/mcp`
//
// Transport: line-delimited JSON-RPC over stdin (with chunk-boundary safe
// accumulation), JSON-RPC over stdout. The Remnic daemon's `/mcp` endpoint
// streams SSE in some modes; for tool-call sizing this proxy reads a single
// buffered response per request and tolerates empty 202 bodies used by
// notifications/initialized.
//
// Exit codes:
//   0  graceful shutdown
//   2  fatal config error (missing required env, non-loopback http, etc.)

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

function isString(v) {
  return Object.prototype.toString.call(v) === "[object String]";
}

const URL_DEFAULT = "http://localhost:4318/mcp";
const REQUEST_TIMEOUT_MS = 30_000;
const EXIT_DRAIN_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB; matches MCP tool-result upper bound

function readEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function fatal(msg) {
  process.stderr.write(`remnic-mcp-proxy: ${msg}\n`);
  process.exit(2);
}

function sanitizeMessage(msg) {
  if (!isString(msg)) return "internal error";
  let s = msg.replace(/[\p{Cc}]/gu, " ");
  s = s.replace(/\s(?:file:|\/)[^\s'"]+/g, " <path> ");
  if (s.length > 200) s = `${s.slice(0, 200)}…`;
  return s;
}

function isLoopbackHostname(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (bare === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(bare)) return true;
  return false;
}

function envOrEmpty(name) {
  const v = readEnv(name, "");
  return v.includes("${") ? "" : v;
}

function tokenFromStore() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return "";
  for (const file of [
    path.join(home, ".remnic", "tokens.json"),
    path.join(home, ".engram", "tokens.json"),
  ]) {
    try {
      if (!fs.existsSync(file)) continue;
      const store = JSON.parse(fs.readFileSync(file, "utf8"));
      const tokens = Array.isArray(store.tokens) ? store.tokens : [];
      for (const connector of ["agy-cli", "agy", "openclaw"]) {
        const hit = tokens.find((t) => t && t.connector === connector && t.token);
        if (hit) return hit.token;
      }
      const first = tokens.find((t) => t && t.token);
      if (first) return first.token;
      for (const key of ["agy-cli", "agy", "openclaw"]) {
        if (store[key]) return store[key];
      }
    } catch {
      /* try next file */
    }
  }
  return "";
}

const daemonUrl =
  envOrEmpty("REMNIC_PLUGIN_DAEMON_URL") ||
  envOrEmpty("REMNIC_DAEMON_URL") ||
  envOrEmpty("ENGRAM_DAEMON_URL") ||
  URL_DEFAULT;
const token =
  envOrEmpty("REMNIC_PLUGIN_DAEMON_TOKEN") ||
  envOrEmpty("REMNIC_DAEMON_TOKEN") ||
  envOrEmpty("REMNIC_AUTH_TOKEN") ||
  tokenFromStore();
if (!token) {
  fatal(
    "no Remnic daemon token found. Run `remnic token generate agy-cli` or set REMNIC_DAEMON_TOKEN / REMNIC_PLUGIN_DAEMON_TOKEN."
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
const allowCleartextHttp = envOrEmpty("REMNIC_MCP_ALLOW_CLEARTEXT_HTTP") === "1";
if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
  if (allowCleartextHttp) {
    process.stderr.write(
      `remnic-mcp-proxy: WARNING: REMNIC_PLUGIN_DAEMON_URL uses plain http:// to a non-loopback host (${parsed.hostname}); ` +
        "the bearer token will be sent cleartext because REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1 is set.\n"
    );
  } else {
    fatal(
      `REMNIC_PLUGIN_DAEMON_URL uses plain http:// to a non-loopback host (${parsed.hostname}); refuse to send bearer token cleartext. Use https:// or http://localhost / http://127.0.0.x, or set REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1 for a trusted network.`
    );
  }
}
const transport = parsed.protocol === "https:" ? https : http;

let inFlight = 0;
let stdinEnded = false;
let exiting = false;

let stdinTail = ""; // partial line carried across stdin data events
const lineQueue = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const buf = `${stdinTail}${chunk}`;
  const parts = buf.split("\n");
  stdinTail = parts.pop();
  for (const p of parts) {
    if (p.length === 0) continue;
    lineQueue.push(p);
  }
  drain();
});
process.stdin.on("end", () => {
  stdinEnded = true;
  if (stdinTail.length > 0) {
    lineQueue.push(stdinTail);
    stdinTail = "";
    drain();
  }
  tryExit();
});

process.stdin.on("error", (err) => {
  fatal(`stdin error: ${sanitizeMessage(err.message)}`);
});

process.stdout.on("error", (err) => {
  process.stderr.write(`remnic-mcp-proxy: stdout error: ${sanitizeMessage(err.message)}\n`);
  process.exit(1);
});

function writeRaw(payload) {
  try {
    process.stdout.write(`${payload}\n`);
  } catch (err) {
    process.stderr.write(`remnic-mcp-proxy: stdout write failed: ${sanitizeMessage(err.message)}\n`);
  }
}

function writeError(id, code, message, requestId) {
  const safeMsg = sanitizeMessage(message);
  const payload = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message: safeMsg },
  };
  if (requestId !== undefined && requestId !== null) payload.id = requestId;
  writeRaw(JSON.stringify(payload));
}

function writeResult(id, result) {
  writeRaw(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function writeNotificationAck() {
  // Per JSON-RPC 2.0, a notification has no `id` and the receiver MUST NOT reply.
  // The proxy acknowledges indirectly by emitting nothing for notifications.
}

function drain() {
  while (lineQueue.length > 0) {
    const line = lineQueue.shift();
    handleLine(line);
  }
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    writeError(null, -32700, `parse error: ${sanitizeMessage(err.message)}`);
    return;
  }
  if (msg === null || Array.isArray(msg) || !(msg instanceof Object)) {
    writeError(null, -32600, "invalid request: not a JSON-RPC object");
    return;
  }
  if (!isString(msg.method) || msg.method.length === 0) {
    writeError(msg.id ?? null, -32600, "invalid request: missing or empty method");
    return;
  }
  const isNotification = !Object.prototype.hasOwnProperty.call(msg, "id");
  inFlight += 1;
  forward(msg, isNotification).finally(() => {
    inFlight -= 1;
    tryExit();
  });
}

function forward(msg, isNotification) {
  // For the SDK's "initialized" notification, the daemon may return 202 with
  // an empty body and no Content-Type. Treat that as a successful notification
  // ack: emit no reply and resolve without surfacing a parse error. For
  // requests, missing/empty body is also a parse error from the daemon.
  const payload = {
    jsonrpc: msg.jsonrpc ?? "2.0",
    method: msg.method,
    params: msg.params ?? {},
  };
  if (!isNotification) payload.id = msg.id ?? null;
  const body = JSON.stringify(payload);
  const nsHeader = envOrEmpty("REMNIC_NAMESPACE") || envOrEmpty("ENGRAM_NAMESPACE");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Engram-Client-Id": "agy-cli",
    Authorization: `Bearer ${token}`,
    "Content-Length": Buffer.byteLength(body, "utf8"),
  };
  if (nsHeader) headers["X-Engram-Namespace"] = nsHeader;
  return new Promise((resolve) => {
    let answered = false;
    const respond = (emit) => {
      if (answered) return;
      answered = true;
      emit();
      resolve();
    };
    const req = transport.request(
      {
        method: "POST",
        // URL.hostname retains brackets on IPv6 literals ("[::1]"); the
        // request options want the bare address.
        hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:
          (parsed.pathname === "/" || !parsed.pathname
            ? "/mcp"
            : parsed.pathname) + (parsed.search || ""),
        headers,
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
          try {
            if (isNotification) {
              if (res.statusCode < 200 || res.statusCode >= 300) {
                process.stderr.write(
                  `remnic-mcp-proxy: notification ${msg.method} got HTTP ${res.statusCode}: ${sanitizeMessage(chunks).slice(0, 200)}\n`
                );
              }
              respond(() => writeNotificationAck());
              return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              respond(() =>
                writeError(
                  msg.id ?? null,
                  -32001,
                  `daemon responded ${res.statusCode}: ${sanitizeMessage(chunks).slice(0, 200)}`,
                  msg.id ?? null
                )
              );
              return;
            }
            const trimmed = chunks.trim();
            // Empty 202 / 204 bodies on a request are a contract violation
            // (the daemon should always JSON-RPC). Surface as a parse error
            // so MCP clients see the real failure mode.
            if (trimmed.length === 0) {
              respond(() =>
                writeError(
                  msg.id ?? null,
                  -32002,
                  `daemon returned empty body with HTTP ${res.statusCode}`,
                  msg.id ?? null
                )
              );
              return;
            }
            // The Remnic /mcp endpoint may emit SSE in streaming mode —
            // strip `data: ` prefixes if present.
            const cleaned = trimmed
              .split("\n")
              .filter((l) => l && !l.startsWith("event:") && !l.startsWith(":"))
              .map((l) => (l.startsWith("data: ") ? l.slice(6) : l))
              .join("\n")
              .trim();
            let parsedResp;
            try {
              parsedResp = JSON.parse(cleaned);
            } catch (err) {
              respond(() =>
                writeError(
                  msg.id ?? null,
                  -32002,
                  `daemon returned non-JSON: ${sanitizeMessage(err.message)} (preview: ${cleaned.slice(0, 200)})`,
                  msg.id ?? null
                )
              );
              return;
            }
            if (parsedResp && "error" in parsedResp) {
              respond(() => writeRaw(JSON.stringify(parsedResp)));
              return;
            }
            respond(() => writeResult(msg.id ?? null, parsedResp.result ?? parsedResp));
          } catch (err) {
            // The outer guard catches anything that slipped through the inner
            // parses. For requests, emit a JSON-RPC error envelope so the MCP
            // client sees a real failure rather than a silent stall. For
            // notifications (which carry no id and to which the receiver MUST
            // NOT reply per JSON-RPC 2.0), log to stderr only.
            respond(() => {
              if (isNotification) {
                process.stderr.write(
                  `remnic-mcp-proxy: notification ${msg.method} handler error: ${sanitizeMessage(err.message)}\n`
                );
              } else {
                writeError(
                  msg.id ?? null,
                  -32603,
                  `internal proxy error: ${sanitizeMessage(err.message)}`,
                  msg.id ?? null
                );
              }
            });
          }
        });
        res.on("error", (err) => {
          respond(() => {
            if (isNotification) {
              process.stderr.write(
                `remnic-mcp-proxy: notification ${msg.method} response stream error: ${sanitizeMessage(err.message)}\n`
              );
            } else {
              writeError(
                msg.id ?? null,
                -32003,
                `response stream error: ${sanitizeMessage(err.message)}`,
                msg.id ?? null
              );
            }
          });
        });
      }
    );
    // idle timer: it does not arm until the socket connects and restarts on
    // every byte, so a daemon front that drops packets or trickles a reply
    // held the tool call open far past REQUEST_TIMEOUT_MS.
    const deadline = setTimeout(() => {
      req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", (err) => {
      respond(() => {
        if (isNotification) {
          process.stderr.write(
            `remnic-mcp-proxy: notification ${msg.method} transport error: ${sanitizeMessage(err.message)}\n`
          );
        } else {
          writeError(msg.id ?? null, -32003, `transport error: ${sanitizeMessage(err.message)}`, msg.id ?? null);
        }
      });
    });
    req.write(body);
    req.end();
  });
}

function tryExit() {
  if (exiting) return;
  if (!stdinEnded) return;
  if (inFlight > 0) {
    setTimeout(() => {
      exiting = true;
      process.exit(0);
    }, EXIT_DRAIN_TIMEOUT_MS).unref();
    return;
  }
  exiting = true;
  process.exit(0);
}

drain();
