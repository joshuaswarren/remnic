/**
 * Remote daemon targeting tests (issue #2448).
 *
 * Covers the URL/token resolvers in `remote-daemon.ts` and the remote
 * status/query/xray fetch paths against a mocked `globalThis.fetch` —
 * asserting the configured https origin is used verbatim (never forced
 * to `http://host:port`) and the bearer token from `REMNIC_AUTH_TOKEN`
 * reaches the wire.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hostedOnlyDaemonRefusalMessage,
  probeDaemonHealth,
  printHealthCheck,
  remoteRecall,
  remoteRecallXray,
  resolveDaemonBaseUrl,
  resolveHostedOnlyDaemonRefusal,
  resolveOperatorToken,
  resolveRemoteDaemon,
  resolveRemoteDaemonUrl,
} from "./remote-daemon.js";

const ENV_KEYS = [
  "REMNIC_DAEMON_URL",
  "ENGRAM_DAEMON_URL",
  "REMNIC_AUTH_TOKEN",
  "ENGRAM_AUTH_TOKEN",
  "REMNIC_HOST",
  "REMNIC_PORT",
] as const;

let tempDir = "";
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-remote-"));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

after(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): string {
  const configPath = path.join(tempDir, "remnic.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

type FetchCall = { url: string; init: RequestInit | undefined };

function mockFetch(
  handler: (url: URL, init: RequestInit | undefined) => Response,
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── resolveRemoteDaemonUrl / resolveDaemonBaseUrl ────────────────────────────

test("REMNIC_DAEMON_URL env wins and keeps the https scheme", () => {
  const configPath = writeConfig({ server: { url: "http://other.test" } });
  process.env.REMNIC_DAEMON_URL = "https://example.test";

  assert.equal(resolveRemoteDaemonUrl(configPath), "https://example.test");
  assert.equal(resolveDaemonBaseUrl(configPath), "https://example.test");
});

test("server.url is honored with a path prefix and trailing slash stripped", () => {
  const configPath = writeConfig({ server: { url: "https://example.test/remnic/" } });

  assert.equal(resolveRemoteDaemonUrl(configPath), "https://example.test/remnic");
});

test("a non-http(s) remote URL fails loud instead of falling back to local", () => {
  process.env.REMNIC_DAEMON_URL = "ftp://example.test";
  assert.throws(
    () => resolveRemoteDaemonUrl("/nonexistent/remnic.config.json"),
    /scheme must be http:\/\/ or https:\/\//,
  );
});

test("an unparseable remote URL fails loud", () => {
  process.env.REMNIC_DAEMON_URL = "not a url";
  assert.throws(
    () => resolveRemoteDaemonUrl("/nonexistent/remnic.config.json"),
    /Invalid REMNIC_DAEMON_URL/,
  );
});

test("without a remote URL the local http://host:port form is preserved", () => {
  const configPath = writeConfig({ server: { host: "10.0.0.5", port: 9999 } });

  assert.equal(resolveDaemonBaseUrl(configPath), "http://10.0.0.5:9999");
  assert.equal(resolveRemoteDaemon(configPath), undefined);

  process.env.REMNIC_PORT = "7777";
  assert.equal(resolveDaemonBaseUrl(configPath), "http://10.0.0.5:7777");

  process.env.REMNIC_PORT = "not-a-port";
  assert.throws(() => resolveDaemonBaseUrl(configPath), /Invalid REMNIC_PORT/);
});

// ── token resolution ─────────────────────────────────────────────────────────

test("remote token prefers env over server.authToken and skips placeholders", () => {
  const configPath = writeConfig({
    server: { url: "https://example.test", authToken: "file-token" },
  });

  process.env.REMNIC_AUTH_TOKEN = "env-token";
  assert.deepEqual(resolveRemoteDaemon(configPath), {
    baseUrl: "https://example.test",
    token: "env-token",
  });

  delete process.env.REMNIC_AUTH_TOKEN;
  assert.equal(resolveOperatorToken(configPath), "file-token");

  const placeholderPath = writeConfig({
    server: { url: "https://example.test", authToken: "${REMNIC_AUTH_TOKEN}" },
  });
  assert.equal(resolveOperatorToken(placeholderPath), undefined);
  assert.deepEqual(resolveRemoteDaemon(placeholderPath), {
    baseUrl: "https://example.test",
  });
});

// ── remote status path (mocked fetch) ────────────────────────────────────────

test("probeDaemonHealth targets the remote https origin with the bearer token", async () => {
  const { calls, restore } = mockFetch(() => jsonResponse(200, { status: "ok" }));
  try {
    const probe = await probeDaemonHealth("https://example.test", "tok");

    assert.deepEqual(probe, { ok: true, status: 200 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://example.test/engram/v1/health");
    assert.equal(
      (calls[0]?.init?.headers as Record<string, string>).authorization,
      "Bearer tok",
    );
  } finally {
    restore();
  }
});

test("probeDaemonHealth reports non-ok statuses without throwing", async () => {
  const { restore } = mockFetch(() => jsonResponse(401, { error: "unauthorized" }));
  try {
    const probe = await probeDaemonHealth("https://example.test", undefined);
    assert.deepEqual(probe, { ok: false, status: 401 });
  } finally {
    restore();
  }
});

test("printHealthCheck renders the remote health payload", async () => {
  const { restore } = mockFetch(
    () => jsonResponse(200, {
      status: "ok",
      qmd: { pendingEmbeddings: 2, oldestPendingAgeMs: 120_000, degradedReason: "backlog" },
    }),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    await printHealthCheck("https://example.test", "tok");
  } finally {
    console.log = originalLog;
    restore();
  }
  assert.ok(lines.includes("Health: ok"));
  assert.ok(lines.includes("  Pending embeddings: 2"));
  assert.ok(lines.includes("  Oldest pending: 2m"));
  assert.ok(lines.includes("  Degraded: backlog"));
});

// ── remote query path (mocked fetch) ─────────────────────────────────────────

test("remoteRecall POSTs the recall request to the remote origin", async () => {
  const { calls, restore } = mockFetch(
    () => jsonResponse(200, { count: 1, results: [{ content: "known fact" }] }),
  );
  try {
    const result = await remoteRecall(
      { baseUrl: "https://example.test", token: "tok" },
      { query: "known fact", mode: "auto", sessionKey: "remnic-cli:query:test" },
    );

    assert.equal(result.count, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://example.test/engram/v1/recall");
    assert.equal(calls[0]?.init?.method, "POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer tok");
    assert.equal(headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      query: "known fact",
      mode: "auto",
      sessionKey: "remnic-cli:query:test",
    });
  } finally {
    restore();
  }
});

test("remoteRecall maps 401 to an operator-facing error", async () => {
  const { restore } = mockFetch(() => jsonResponse(401, { error: "unauthorized" }));
  try {
    await assert.rejects(
      () => remoteRecall(
        { baseUrl: "https://example.test", token: "bad" },
        { query: "q", mode: "auto", sessionKey: "s" },
      ),
      /token rejected by remnic-server at https:\/\/example\.test/,
    );
  } finally {
    restore();
  }
});

// ── remote xray path (mocked fetch) ──────────────────────────────────────────

test("remoteRecallXray GETs query params and maps the snapshot payload", async () => {
  const { calls, restore } = mockFetch(
    () => jsonResponse(200, { snapshotFound: true, snapshot: { query: "known fact" } }),
  );
  try {
    const response = await remoteRecallXray(
      { baseUrl: "https://example.test/remnic", token: "tok" },
      { query: "known fact", budget: 5 },
    );

    assert.equal(response.snapshotFound, true);
    assert.deepEqual(response.snapshot, { query: "known fact" });
    assert.equal(calls.length, 1);
    const url = new URL(String(calls[0]?.url));
    assert.equal(url.protocol, "https:");
    assert.equal(url.pathname, "/remnic/engram/v1/recall/xray");
    assert.equal(url.searchParams.get("q"), "known fact");
    assert.equal(url.searchParams.get("budget"), "5");
  } finally {
    restore();
  }
});

test("remoteRecallXray reports snapshotFound false when no snapshot was captured", async () => {
  const { restore } = mockFetch(() => jsonResponse(200, { snapshotFound: false }));
  try {
    const response = await remoteRecallXray(
      { baseUrl: "https://example.test" },
      { query: "known fact" },
    );
    assert.deepEqual(response, { snapshotFound: false });
  } finally {
    restore();
  }
});

// ── hosted-only mode (issue #2712) ────────────────────────────────────────────

test("a non-loopback remote origin refuses the local daemon lifecycle; loopback or none stays local", () => {
  // Env-configured remote origin: refused, and the message is actionable —
  // names the origin and the verb, points health checks at `remnic status`,
  // and says how to get local mode back.
  process.env.REMNIC_DAEMON_URL = "https://remnic.example.com";
  const refused = resolveHostedOnlyDaemonRefusal("/nonexistent/remnic.config.json");
  assert.ok(refused, "non-loopback REMNIC_DAEMON_URL must refuse the local daemon");
  assert.equal(refused.remoteUrl, "https://remnic.example.com");
  const message = hostedOnlyDaemonRefusalMessage(refused.remoteUrl, "start");
  assert.match(message, /refusing to start a local remnic-server/);
  assert.match(message, /https:\/\/remnic\.example\.com/);
  assert.match(message, /remnic status/);

  // Config-file server.url is refused too — same resolver, same precedence.
  delete process.env.REMNIC_DAEMON_URL;
  const configPath = writeConfig({ server: { url: "https://config.example.com" } });
  const refusedFromConfig = resolveHostedOnlyDaemonRefusal(configPath);
  assert.ok(refusedFromConfig, "non-loopback server.url must refuse the local daemon");
  assert.equal(refusedFromConfig.remoteUrl, "https://config.example.com");

  // Loopback origins and no remote URL keep the local lifecycle allowed.
  process.env.REMNIC_DAEMON_URL = "http://127.0.0.1:4318";
  assert.equal(resolveHostedOnlyDaemonRefusal("/nonexistent/remnic.config.json"), undefined);
  process.env.REMNIC_DAEMON_URL = "http://localhost:4318";
  assert.equal(resolveHostedOnlyDaemonRefusal("/nonexistent/remnic.config.json"), undefined);
  delete process.env.REMNIC_DAEMON_URL;
  assert.equal(resolveHostedOnlyDaemonRefusal("/nonexistent/remnic.config.json"), undefined);
});
