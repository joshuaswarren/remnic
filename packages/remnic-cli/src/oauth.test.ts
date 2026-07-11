/**
 * Behaviour tests for `remnic oauth <pending|approve|deny>`.
 *
 * These tests mock `globalThis.fetch` (the only process-wide seam the
 * dispatcher touches) and run the CLI in-process via `runCli` so the
 * full switch + handler path is exercised. The mock records every
 * request the CLI sends and serves canned responses, so the tests can
 * assert both the auth header the CLI builds and the user-facing text it
 * emits on the various error paths.
 *
 * `migrateFromEngram()` runs at the top of every non-migrate command and
 * reads/writes ~/.remnic + ~/.engram, so the file-level HOME isolation
 * (temp HOME) keeps that a no-op against an empty directory.
 *
 * `runCli` swaps `process.stdout` and `process.stderr` (not just their
 * `.write` methods) and intercepts `process.exit`; tests rely on
 * `RunCliResult.{stdout, stderr, exitCode}` for assertions. HOME and the
 * `REMNIC_AUTH_TOKEN` / `ENGRAM_AUTH_TOKEN` env vars are isolated per
 * test (no cross-test leakage).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { runCli } from "./run-cli.js";

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
}

interface FetchHandler {
  (req: { url: string; method: string; body: string }):
    | { status: number; body?: unknown }
    | Promise<{ status: number; body?: unknown }>;
}

let tempHome = "";
let originalHome: string | undefined;
let originalFetch: typeof globalThis.fetch;
let tempConfigDir = "";
let originalFetchIsTTY: boolean | undefined;
let originalStdinIsTTY: boolean | undefined;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(path.join(os.tmpdir(), "remnic-oauth-test-home-"));
  process.env.HOME = tempHome;
  originalFetch = globalThis.fetch;
  // The TTY check in cmdOAuth matters for the approve flow: when stdin is
  // not a TTY, --yes is required; when it IS a TTY, the prompt is shown.
  // We force non-TTY for every test so the prompt path is never entered
  // (which would block waiting for input). Tests that need to exercise
  // the TTY path can flip the property on the fly.
  originalStdinIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = false;
  originalFetchIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = false;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  (process.stdin as { isTTY?: boolean }).isTTY = originalStdinIsTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = originalFetchIsTTY;
  await rm(tempHome, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test gets a fresh temp config dir so resolveConfigPath() returns
  // a path the dispatcher cannot accidentally read from a previous test.
  // (resolveConfigPath() also walks ~/.config/remnic/config.json under
  // HOME; HOME isolation already covers that.)
  tempConfigDir = await mkdtemp(path.join(os.tmpdir(), "remnic-oauth-cfg-"));
  // Default operator token for the suite. Individual tests can override
  // by writing a config file with server.authToken.
  process.env.REMNIC_AUTH_TOKEN = "test-operator-token";
  // Pointer the dispatcher at the empty temp dir so it does not pick up
  // a stray remnic.config.json the test runner dropped somewhere.
  process.env.REMNIC_CONFIG_PATH = path.join(tempConfigDir, "remnic.config.json");
});

/**
 * Install a fetch stub for the duration of a test. The stub records every
 * request and routes through the supplied `handler`. The caller is
 * responsible for the mock's response shape (status + optional JSON body).
 */
function installFetchMock(handler: FetchHandler): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as { url?: string }).url ?? String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string"
      ? init.body
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body).toString("utf8")
        : "";
    requests.push({
      url,
      method,
      authorization: headers.authorization ?? headers.Authorization ?? null,
      body,
    });
    const result = await handler({ url, method, body });
    const responseBody = result.body === undefined
      ? ""
      : typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body);
    return new Response(responseBody, {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { requests };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

const SAMPLE_PENDING = {
  pending: [
    {
      ref: "abc123",
      clientId: "chatgpt-demo",
      redirectUri: "https://chatgpt.com/oauth/callback",
      scopes: ["mcp:read", "mcp:write"],
      resource: "https://mcp.example.com",
      createdAt: "2026-07-11T05:30:00.000Z",
      expiresAt: "2026-07-11T05:40:00.000Z",
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// `oauth pending` — list pending requests
// ════════════════════════════════════════════════════════════════════════════

test("oauth pending (text) renders the list and sends the bearer token", async () => {
  const { requests } = installFetchMock(({ url, method }) => {
    assert.match(url, /\/oauth\/pending$/);
    assert.equal(method, "GET");
    return { status: 200, body: SAMPLE_PENDING };
  });
  try {
    const result = await runCli(["oauth", "pending"]);
    assert.equal(result.exitCode, 0, `unexpected stderr: ${result.stderr}`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer test-operator-token");
    assert.match(result.stdout, /Pending OAuth authorizations \(1\):/);
    assert.match(result.stdout, /ref=abc123/);
    assert.match(result.stdout, /client=chatgpt-demo/);
    assert.match(result.stdout, /redirect=https:\/\/chatgpt\.com\/oauth\/callback/);
  } finally {
    restoreFetch();
  }
});

test("oauth pending (text) reports the empty-state message when the list is empty", async () => {
  installFetchMock(() => ({ status: 200, body: { pending: [] } }));
  try {
    const result = await runCli(["oauth", "pending"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /No pending OAuth authorizations\./);
  } finally {
    restoreFetch();
  }
});

test("oauth pending --format json emits the raw response body verbatim", async () => {
  installFetchMock(() => ({ status: 200, body: SAMPLE_PENDING }));
  try {
    const result = await runCli(["oauth", "pending", "--format", "json"]);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout.trim()) as { pending: unknown[] };
    assert.equal(parsed.pending.length, 1);
    const first = parsed.pending[0] as { ref: string; clientId: string };
    assert.equal(first.ref, "abc123");
    assert.equal(first.clientId, "chatgpt-demo");
  } finally {
    restoreFetch();
  }
});

test("oauth pending --format json falls back to an empty envelope on a null body", async () => {
  installFetchMock(() => ({ status: 200, body: "" }));
  try {
    const result = await runCli(["oauth", "pending", "--format", "json"]);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout.trim()) as { pending: unknown[] };
    assert.deepEqual(parsed.pending, []);
  } finally {
    restoreFetch();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// `oauth approve` — confirm + POST
// ════════════════════════════════════════════════════════════════════════════

test("oauth approve with --yes prints the request details and POSTs the decision", async () => {
  const { requests } = installFetchMock(({ url, method }) => {
    if (method === "GET" && /\/oauth\/pending$/.test(url)) {
      return { status: 200, body: SAMPLE_PENDING };
    }
    if (method === "POST" && /\/oauth\/pending\/abc123\/approve$/.test(url)) {
      return {
        status: 200,
        body: {
          ref: "abc123",
          status: "approved",
          redirect: "https://chatgpt.com/oauth/callback?code=xyz",
        },
      };
    }
    return { status: 500, body: { error: "unexpected" } };
  });
  try {
    const result = await runCli(["oauth", "approve", "abc123", "--yes"]);
    assert.equal(result.exitCode, 0, `unexpected stderr: ${result.stderr}`);
    // Two requests: one GET to look up the ref, one POST to approve.
    assert.equal(requests.length, 2);
    const post = requests[1];
    assert.equal(post.method, "POST");
    assert.match(post.url, /\/oauth\/pending\/abc123\/approve$/);
    assert.equal(post.authorization, "Bearer test-operator-token");
    // Confirm the operator sees the details + the warning + the outcome.
    assert.match(result.stdout, /ref:         abc123/);
    assert.match(result.stdout, /client:      chatgpt-demo/);
    assert.match(result.stdout, /redirect:    https:\/\/chatgpt\.com\/oauth\/callback/);
    assert.match(result.stdout, /scopes:      mcp:read mcp:write/);
    assert.match(result.stdout, /resource:    https:\/\/mcp\.example\.com/);
    assert.match(
      result.stdout,
      /WARNING: approval grants the requesting application an MCP access token/,
    );
    assert.match(result.stdout, /Approved ref=abc123 \(status: approved\)\./);
    assert.match(result.stdout, /Client redirect: https:\/\/chatgpt\.com\/oauth\/callback\?code=xyz/);
  } finally {
    restoreFetch();
  }
});

test("oauth approve without --yes in a non-TTY refuses to POST the approval", async () => {
  const { requests } = installFetchMock(({ url, method }) => {
    if (method === "GET" && /\/oauth\/pending$/.test(url)) {
      return { status: 200, body: SAMPLE_PENDING };
    }
    return { status: 500, body: { error: "should not be called" } };
  });
  try {
    const result = await runCli(["oauth", "approve", "abc123"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /refusing to send the approval without an explicit --yes flag/,
    );
    // The lookup GET may run (it does in the current implementation so
    // the operator can see WHAT they would be approving), but the
    // decision POST must NEVER happen — the no-TTY gate fires before it.
    const decisions = requests.filter((req) => req.method === "POST");
    assert.equal(
      decisions.length,
      0,
      "approve without --yes must never POST to the decision endpoint",
    );
  } finally {
    restoreFetch();
  }
});

test("oauth approve with an unknown ref prints a clear error without POSTing", async () => {
  const { requests } = installFetchMock(({ url, method }) => {
    if (method === "GET" && /\/oauth\/pending$/.test(url)) {
      return { status: 200, body: SAMPLE_PENDING };
    }
    return { status: 500, body: { error: "should not be called" } };
  });
  try {
    const result = await runCli(["oauth", "approve", "nope", "--yes"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /no pending authorization with ref "nope"/,
    );
    const decisions = requests.filter((req) => req.method === "POST");
    assert.equal(
      decisions.length,
      0,
      "approve with unknown ref must never POST to the decision endpoint",
    );
  } finally {
    restoreFetch();
  }
});

test("oauth approve without a ref prints usage and exits non-zero without any HTTP call", async () => {
  const { requests } = installFetchMock(() => {
    throw new Error("fetch must not be called when ref is missing");
  });
  try {
    const result = await runCli(["oauth", "approve"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Usage: remnic oauth approve <ref>/);
    assert.equal(requests.length, 0);
  } finally {
    restoreFetch();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// `oauth deny` — POST deny
// ════════════════════════════════════════════════════════════════════════════

test("oauth deny POSTs the deny decision and prints the outcome", async () => {
  const { requests } = installFetchMock(({ url, method }) => {
    if (method === "POST" && /\/oauth\/pending\/abc123\/deny$/.test(url)) {
      return { status: 200, body: { ref: "abc123", status: "denied" } };
    }
    return { status: 500, body: { error: "unexpected" } };
  });
  try {
    const result = await runCli(["oauth", "deny", "abc123"]);
    assert.equal(result.exitCode, 0, `unexpected stderr: ${result.stderr}`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.match(requests[0].url, /\/oauth\/pending\/abc123\/deny$/);
    assert.equal(requests[0].authorization, "Bearer test-operator-token");
    assert.match(result.stdout, /Denied ref=abc123 \(status: denied\)\./);
  } finally {
    restoreFetch();
  }
});

test("oauth deny without a ref prints usage and exits non-zero without any HTTP call", async () => {
  const { requests } = installFetchMock(() => {
    throw new Error("fetch must not be called when ref is missing");
  });
  try {
    const result = await runCli(["oauth", "deny"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Usage: remnic oauth deny <ref>/);
    assert.equal(requests.length, 0);
  } finally {
    restoreFetch();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Error mapping — 401 / connection refused / 404 / 409
// ════════════════════════════════════════════════════════════════════════════

test("oauth pending surfaces a clear 401 message when the daemon rejects the token", async () => {
  installFetchMock(() => ({ status: 401, body: { error: "unauthorized" } }));
  try {
    const result = await runCli(["oauth", "pending"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /operator token rejected/);
  } finally {
    restoreFetch();
  }
});

test("oauth pending surfaces a clear 'is remnic-server running?' message on connection refused", async () => {
  installFetchMock(() => {
    // The Node undici fetch failure mode is an aggregate TypeError whose
    // message contains "fetch failed" + a nested cause with ECONNREFUSED.
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:4318");
    const err = new TypeError("fetch failed");
    (err as Error & { cause?: unknown }).cause = cause;
    throw err;
  });
  try {
    const result = await runCli(["oauth", "pending"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /cannot reach remnic-server/);
    assert.match(result.stderr, /is remnic-server running\?/);
  } finally {
    restoreFetch();
  }
});

test("oauth approve maps 404 from the daemon to a clear 'unknown or expired ref' message", async () => {
  // First GET (list) returns a pending entry; the POST to approve
  // returns 404 (the daemon GCed the entry between the two requests).
  installFetchMock(({ url, method }) => {
    if (method === "GET") return { status: 200, body: SAMPLE_PENDING };
    if (method === "POST") return { status: 404, body: { error: "invalid_request" } };
    return { status: 500 };
  });
  try {
    const result = await runCli(["oauth", "approve", "abc123", "--yes"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unknown or expired ref/);
  } finally {
    restoreFetch();
  }
});

test("oauth deny maps 409 with an error_description to a clear message", async () => {
  installFetchMock(() => ({
    status: 409,
    body: { error: "invalid_request", error_description: "denied" },
  }));
  try {
    const result = await runCli(["oauth", "deny", "abc123"]);
    assert.notEqual(result.exitCode, 0);
    // The server's error_description must reach the operator verbatim.
    assert.match(result.stderr, /denied/);
  } finally {
    restoreFetch();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Operator token resolution
// ════════════════════════════════════════════════════════════════════════════

test("oauth with no operator token configured exits 1 with a clear error", async () => {
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;
  // No server.authToken in the config file either (REMNIC_CONFIG_PATH
  // points at a non-existent file). cmdOAuth must reject the call loudly
  // instead of attempting the request.
  let fetchCalled = false;
  installFetchMock(() => {
    fetchCalled = true;
    return { status: 200, body: { pending: [] } };
  });
  try {
    const result = await runCli(["oauth", "pending"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /no operator token configured/);
    assert.equal(
      fetchCalled,
      false,
      "must not hit the daemon when the operator token is missing",
    );
  } finally {
    restoreFetch();
  }
});

test("oauth prefers server.authToken from the config over REMNIC_AUTH_TOKEN", async () => {
  // Write a config with server.authToken = "config-token" and confirm the
  // CLI uses it (and not REMNIC_AUTH_TOKEN = "test-operator-token").
  await writeFile(
    process.env.REMNIC_CONFIG_PATH ?? "",
    JSON.stringify({ server: { authToken: "config-token", port: 4318 } }),
    "utf8",
  );
  const { requests } = installFetchMock(() => ({ status: 200, body: { pending: [] } }));
  try {
    const result = await runCli(["oauth", "pending"]);
    assert.equal(result.exitCode, 0, `unexpected stderr: ${result.stderr}`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer config-token");
  } finally {
    restoreFetch();
  }
});

test("oauth honours server.host and server.port from the config", async () => {
  await writeFile(
    process.env.REMNIC_CONFIG_PATH ?? "",
    JSON.stringify({ server: { host: "10.0.0.42", port: 9999, authToken: "tok" } }),
    "utf8",
  );
  const { requests } = installFetchMock(() => ({ status: 200, body: { pending: [] } }));
  try {
    const result = await runCli(["oauth", "pending"]);
    assert.equal(result.exitCode, 0, `unexpected stderr: ${result.stderr}`);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^http:\/\/10\.0\.0\.42:9999\/oauth\/pending/);
  } finally {
    restoreFetch();
  }
});

test("oauth rejects an unknown subcommand with usage guidance and no HTTP call", async () => {
  const { requests } = installFetchMock(() => {
    throw new Error("must not be called");
  });
  try {
    const result = await runCli(["oauth", "revoke-everything"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Unknown oauth subcommand "revoke-everything"/);
    assert.match(result.stderr, /remnic oauth --help/);
    assert.equal(requests.length, 0, "invalid subcommands must never reach the daemon");
  } finally {
    restoreFetch();
  }
});

test("oauth pending surfaces a clear error when the daemon returns non-JSON", async () => {
  installFetchMock(() => ({ status: 200, body: "<html>gateway error</html>" }));
  try {
    const result = await runCli(["oauth", "pending"]);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /non-JSON response/);
  } finally {
    restoreFetch();
  }
});
