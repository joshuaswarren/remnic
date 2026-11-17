#!/usr/bin/env node
"use strict";

// Install preflight for @remnic/plugin-agy (#3451): the plugin install must
// never complete green while the bundled mcp-server-stdio will refuse to
// start. Run before `agy plugin install` (README, install step):
//
//   node install-preflight.cjs
//
// Exit 0: the MCP proxy will start (silent for loopback/https, one warning
//         line when the cleartext opt-in is engaged).
// Exit 2: the MCP proxy would exit 2 on startup. The message names the
//         daemon URL, the refusal, and the opt-in, mirroring server.js.
//
// The env resolution order and the loopback/http gate duplicate
// mcp-server-stdio/server.js deliberately — the proxy cannot be imported
// (it starts a server at module load), and the two checks must agree or
// this preflight would lie about the install outcome.

const URL_DEFAULT = "http://localhost:4318/mcp";

function envOrEmpty(name) {
  const v = process.env[name];
  // Unexpanded "${...}" placeholders are treated as unset, same as the
  // proxy — an install-time template must not pass as a real URL.
  if (v === undefined || v === "" || v.includes("${")) return "";
  return v;
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

function fail(message) {
  process.stderr.write(`remnic-agy install-preflight: ${message}\n`);
  process.exit(2);
}

const daemonUrl =
  envOrEmpty("REMNIC_PLUGIN_DAEMON_URL") ||
  envOrEmpty("REMNIC_DAEMON_URL") ||
  envOrEmpty("ENGRAM_DAEMON_URL") ||
  URL_DEFAULT;

let parsed;
try {
  parsed = new URL(daemonUrl);
} catch {
  fail(`daemon URL is not parseable: ${daemonUrl}. Fix REMNIC_PLUGIN_DAEMON_URL / REMNIC_DAEMON_URL or unset it to use the default ${URL_DEFAULT}.`);
}

if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
  fail(
    `daemon URL ${daemonUrl} uses unsupported protocol ${parsed.protocol} (expected http: or https:); ` +
      "mcp-server-stdio will refuse to send the bearer token over plaintext to a non-loopback target. " +
      "Use https:// or a loopback http:// address, or set REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1 on a trusted network."
  );
}

// The same cleartext gate mcp-server-stdio applies at startup. Without the
// opt-in the proxy exits 2 and the remember/recall tools never register —
// so this is a hard install failure, not a warning. With the opt-in the
// proxy starts but still sends the token cleartext, so the preflight warns
// and proceeds.
const allowCleartextHttp = envOrEmpty("REMNIC_MCP_ALLOW_CLEARTEXT_HTTP") === "1";
if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
  if (!allowCleartextHttp) {
    fail(
      `daemon URL ${daemonUrl} uses plain http:// to a non-loopback host (${parsed.hostname}); ` +
        "mcp-server-stdio will refuse to start because the bearer token would travel cleartext, " +
        "leaving the remember/recall MCP tools dead after an otherwise green install. " +
        "Use https:// or a loopback address (http://localhost / http://127.0.0.x), " +
        "or set REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1 on a trusted network."
    );
  }
  process.stderr.write(
    `remnic-agy install-preflight: WARNING: daemon URL ${daemonUrl} uses plain http:// to a non-loopback host (${parsed.hostname}); ` +
      "the bearer token travels cleartext because REMNIC_MCP_ALLOW_CLEARTEXT_HTTP=1 is set.\n"
  );
}

process.exit(0);
