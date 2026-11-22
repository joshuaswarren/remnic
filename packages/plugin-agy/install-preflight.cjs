#!/usr/bin/env node
"use strict";

//

const URL_DEFAULT = "http://localhost:4318/mcp";

function envOrEmpty(name) {
  const v = process.env[name];
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
      "mcp-server-stdio only supports http: and https: protocols. " +
      "Use https:// or a loopback http:// address."
  );
}

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
