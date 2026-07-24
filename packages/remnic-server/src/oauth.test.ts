import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EngramAccessHttpServer,
  type EngramAccessService,
  generateToken,
  getAllValidTokenEntriesCached,
  revokeToken,
} from "@remnic/core";
import {
  buildOAuthRequestHandler,
  OAuthState,
  parseOAuthConfig,
  applyOAuthEnvOverrides,
  type ParsedOAuthConfig,
} from "./oauth.js";

const OPERATOR_TOKEN = "operator-test-token";
const CLIENT_ID = "remnic-chatgpt-test";
const CLIENT_SECRET = "s3cret-e2e-value";
const REDIRECT_URI = "https://chatgpt.com/connector/oauth/cb_test123";

/** Reserve a free TCP port so the issuer URL can be fixed before start. */
async function reserveFreePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (address && typeof address === "object") {
      const { port } = address;
      probe.close(() => resolve(port));
    } else {
      probe.close(() => reject(new Error("no address")));
    }
  });
  return promise;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

// Signature-faithful minimal service stub: only health() is exercised by
// these tests (scope-policy checks against a REST route).
const serviceStub = {
  health: async () => ({
    ok: true as const,
    memoryDir: "/tmp/remnic-oauth-test",
    namespacesEnabled: false,
    defaultNamespace: "default",
    searchBackend: "recent",
    qmdEnabled: false,
    qmd: {
      enabled: false,
      active: false,
      degraded: false,
      mode: "disabled" as const,
      collection: "",
      collectionState: "skipped" as const,
      installedVersion: null,
      supportedVersion: null,
      supported: null,
      upgradeAvailable: null,
      doctorAvailable: null,
      debugStatus: "disabled",
      pendingEmbeddings: null,
      oldestPendingAgeMs: null,
      embeddingBacklogThreshold: 1000,
    },
    nativeKnowledgeEnabled: false,
    projectionAvailable: false,
    corpus: [],
  }),
} satisfies Pick<EngramAccessService, "health">;

interface Harness {
  issuer: string;
  tokensPath: string;
  server: EngramAccessHttpServer;
  config: ParsedOAuthConfig;
  cleanup: () => Promise<void>;
}

/** Boot the access server with the OAuth facade wired exactly like startServer(). */
async function startHarness(overrides?: Partial<Record<string, unknown>>): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-oauth-"));
  const tokensPath = path.join(dir, "tokens.json");
  const port = await reserveFreePort();
  const issuer = `http://127.0.0.1:${port}`;
  const config = parseOAuthConfig({
    enabled: true,
    issuerUrl: issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokenEndpointAuthMethod: "client_secret_post",
    redirectUris: [REDIRECT_URI],
    ...overrides,
  });
  const server = new EngramAccessHttpServer({
    service: serviceStub as unknown as EngramAccessService,
    host: "127.0.0.1",
    port,
    authToken: OPERATOR_TOKEN,
    // Production wiring (startServer): one coherent entries snapshot +
    // chatgpt-connector tokens pinned to /mcp.
    authTokenEntriesGetter: () => getAllValidTokenEntriesCached(tokensPath),
    tokenPathPolicy: (connector, pathname) => connector !== "chatgpt" || pathname === "/mcp",
    adminConsoleEnabled: false,
    externalRequestHandler: buildOAuthRequestHandler(config, { tokensPath }),
    resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource/mcp`,
  });
  await server.start();
  return {
    issuer,
    tokensPath,
    server,
    config,
    cleanup: async () => {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Run the authorize → approve → token exchange flow, returning the access token. */
async function completeOAuthFlow(h: Harness, opts?: { resource?: string }): Promise<string> {
  const { verifier, challenge } = pkcePair();
  const authorizeUrl = new URL("/authorize", h.issuer);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", "state-xyz");
  if (opts?.resource) authorizeUrl.searchParams.set("resource", opts.resource);

  const page = await fetch(authorizeUrl);
  assert.equal(page.status, 200, "authorize must render the approval page");
  const html = await page.text();
  assert.match(html, /remnic oauth approve/, "page must show the CLI approval command");
  assert.doesNotMatch(html, /password|client_secret|bearer/i, "page must never ask for credentials");

  // Operator lists pending and approves via the operator-only endpoint.
  const pendingResp = await fetch(`${h.issuer}/oauth/pending`, {
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  assert.equal(pendingResp.status, 200);
  const pendingBody = (await pendingResp.json()) as {
    pending: Array<{ ref: string; clientId: string; redirectUri: string }>;
  };
  assert.equal(pendingBody.pending.length >= 1, true, "authorize must create a pending txn");
  const txn = pendingBody.pending[pendingBody.pending.length - 1];
  assert.ok(txn);
  assert.equal(txn.clientId, CLIENT_ID);
  assert.equal(txn.redirectUri, REDIRECT_URI);

  const approveResp = await fetch(`${h.issuer}/oauth/pending/${txn.ref}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  assert.equal(approveResp.status, 200);
  const approveBody = (await approveResp.json()) as { status: string; redirect: string };
  assert.equal(approveBody.status, "approved");
  const redirect = new URL(approveBody.redirect);
  assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT_URI);
  assert.equal(redirect.searchParams.get("state"), "state-xyz");
  const code = redirect.searchParams.get("code");
  assert.ok(code, "redirect must carry the authorization code");

  // Token exchange (client_secret_post + PKCE verifier), form-encoded like
  // a real OAuth client.
  const tokenResp = await fetch(`${h.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      ...(opts?.resource ? { resource: opts.resource } : {}),
    }),
  });
  assert.equal(tokenResp.status, 200, `token exchange must succeed: ${await tokenResp.clone().text()}`);
  const tokens = (await tokenResp.json()) as { access_token: string; token_type: string };
  assert.equal(tokens.token_type, "Bearer");
  assert.match(tokens.access_token, /^remnic_cg_/, "access token must be a chatgpt-connector token");
  return tokens.access_token;
}

async function mcpInitialize(h: Harness, accessToken: string): Promise<Response> {
  return fetch(`${h.issuer}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "oauth-test", version: "1.0" } },
    }),
  });
}

test("OAuth discovery documents are served unauthenticated and truthful", async () => {
  const h = await startHarness();
  try {
    for (const wellKnown of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const resp = await fetch(`${h.issuer}${wellKnown}`);
      assert.equal(resp.status, 200, `${wellKnown} must be public`);
      const body = (await resp.json()) as { resource: string; authorization_servers: string[] };
      assert.equal(body.resource, `${h.issuer}/mcp`);
      assert.deepEqual(body.authorization_servers, [`${h.issuer}/`]);
    }
    const asResp = await fetch(`${h.issuer}/.well-known/oauth-authorization-server`);
    assert.equal(asResp.status, 200);
    const asBody = (await asResp.json()) as Record<string, unknown>;
    assert.equal(asBody.authorization_endpoint, `${h.issuer}/authorize`);
    assert.equal(asBody.token_endpoint, `${h.issuer}/token`);
    assert.deepEqual(asBody.code_challenge_methods_supported, ["S256"]);
    // Truthfully narrowed: only the single configured method + grant.
    assert.deepEqual(asBody.token_endpoint_auth_methods_supported, ["client_secret_post"]);
    assert.deepEqual(asBody.grant_types_supported, ["authorization_code"]);
    assert.equal(asBody.registration_endpoint, undefined, "DCR must not be advertised");

    // 401 challenge advertises the resource metadata URL (RFC 9728).
    const unauth = await fetch(`${h.issuer}/mcp`, { method: "POST" });
    assert.equal(unauth.status, 401);
    assert.equal(
      unauth.headers.get("www-authenticate"),
      `Bearer resource_metadata="${h.issuer}/.well-known/oauth-protected-resource/mcp"`,
    );
  } finally {
    await h.cleanup();
  }
});

test("full OAuth flow: authorize → CLI-style approve → token → authenticated /mcp", async () => {
  const h = await startHarness();
  try {
    const accessToken = await completeOAuthFlow(h, { resource: `${h.issuer}/mcp` });

    // Minted token works on /mcp immediately (mint-then-use coherence).
    const init = await mcpInitialize(h, accessToken);
    assert.equal(init.status, 200);
    assert.ok(init.headers.get("mcp-session-id"), "initialize must assign an MCP session id");
    const initBody = (await init.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    assert.equal(initBody.result.protocolVersion, "2025-06-18");
    assert.equal(initBody.result.serverInfo.name, "remnic");

    // tools/list with the same token also works.
    const tools = await fetch(`${h.issuer}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(tools.status, 200);
    const toolsBody = (await tools.json()) as { result: { tools: Array<{ name: string }> } };
    assert.equal(toolsBody.result.tools.length > 0, true);
  } finally {
    await h.cleanup();
  }
});

test("scope policy: chatgpt token is /mcp-only; operator and other connectors keep access", async () => {
  const h = await startHarness();
  try {
    const accessToken = await completeOAuthFlow(h);

    // ChatGPT token: /mcp works, everything else is denied.
    assert.equal((await mcpInitialize(h, accessToken)).status, 200);
    for (const denied of ["/engram/v1/health", "/engram/v1/adapters"]) {
      const resp = await fetch(`${h.issuer}${denied}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      assert.equal(resp.status, 401, `chatgpt token must be denied on ${denied}`);
    }
    // Including the OAuth operator endpoints — it cannot approve its own pendings.
    const pendingWithChatGpt = await fetch(`${h.issuer}/oauth/pending`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(pendingWithChatGpt.status, 401);

    // Static operator token: full REST access.
    const opHealth = await fetch(`${h.issuer}/engram/v1/health`, {
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    assert.equal(opHealth.status, 200);
    const opHealthBody = (await opHealth.json()) as { ok?: boolean };
    assert.equal(opHealthBody.ok, true);

    // Ordinary connector token (same store): unrestricted, as before OAuth.
    const codexEntry = generateToken("codex", h.tokensPath);
    const codexHealth = await fetch(`${h.issuer}/engram/v1/health`, {
      headers: { authorization: `Bearer ${codexEntry.token}` },
    });
    assert.equal(codexHealth.status, 200, "non-chatgpt connector tokens keep full access");

    // Revoke-immediately-use: revoking the chatgpt connector kills the token.
    assert.equal(revokeToken("chatgpt", h.tokensPath), true);
    assert.equal((await mcpInitialize(h, accessToken)).status, 401, "revoked token must be rejected");
  } finally {
    await h.cleanup();
  }
});

test("re-linking rotates the chatgpt token: old token stops working", async () => {
  const h = await startHarness();
  try {
    const first = await completeOAuthFlow(h);
    assert.equal((await mcpInitialize(h, first)).status, 200);
    const second = await completeOAuthFlow(h);
    assert.notEqual(second, first);
    assert.equal((await mcpInitialize(h, second)).status, 200);
    assert.equal((await mcpInitialize(h, first)).status, 401, "rotation must invalidate the old token");
  } finally {
    await h.cleanup();
  }
});

test("authorize rejections: bad client, unregistered redirect, missing PKCE, setup mode", async () => {
  const h = await startHarness();
  try {
    const { challenge } = pkcePair();
    const base = new URL("/authorize", h.issuer);
    base.searchParams.set("response_type", "code");
    base.searchParams.set("client_id", CLIENT_ID);
    base.searchParams.set("redirect_uri", REDIRECT_URI);
    base.searchParams.set("code_challenge", challenge);
    base.searchParams.set("code_challenge_method", "S256");

    // Unknown client_id → direct 400, no redirect.
    const badClient = new URL(base);
    badClient.searchParams.set("client_id", "someone-else");
    const badClientResp = await fetch(badClient);
    assert.equal(badClientResp.status, 400);

    // Redirect URI not byte-exact in the allowlist → direct 400.
    const badRedirect = new URL(base);
    badRedirect.searchParams.set("redirect_uri", `${REDIRECT_URI}/extra`);
    const badRedirectResp = await fetch(badRedirect);
    assert.equal(badRedirectResp.status, 400);
    const badRedirectBody = (await badRedirectResp.json()) as { error_description?: string };
    assert.match(badRedirectBody.error_description ?? "", /redirect_uri/i);

    // Missing code_challenge → post-redirect error (302 back to the client
    // with ?error=, per OAuth error routing — redirect target is validated).
    const noPkce = new URL(base);
    noPkce.searchParams.delete("code_challenge");
    const noPkceResp = await fetch(noPkce, { redirect: "manual" });
    assert.equal(noPkceResp.status, 302);
    const errRedirect = new URL(noPkceResp.headers.get("location") ?? "");
    assert.equal(`${errRedirect.origin}${errRedirect.pathname}`, REDIRECT_URI);
    assert.equal(errRedirect.searchParams.get("error"), "invalid_request");

    // No pending txns were created by any rejected request.
    const pending = await fetch(`${h.issuer}/oauth/pending`, {
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    const pendingBody = (await pending.json()) as { pending: unknown[] };
    assert.equal(pendingBody.pending.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("setup mode (empty redirectUris): discovery live, every authorization refused", async () => {
  const h = await startHarness({ redirectUris: [] });
  try {
    const discovery = await fetch(`${h.issuer}/.well-known/oauth-authorization-server`);
    assert.equal(discovery.status, 200);

    const { challenge } = pkcePair();
    const url = new URL("/authorize", h.issuer);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const resp = await fetch(url);
    assert.equal(resp.status, 400, "no redirect URI is registered, so authorization must refuse");
  } finally {
    await h.cleanup();
  }
});

test("token endpoint rejections: wrong secret, wrong verifier, code reuse, refresh grant", async () => {
  const h = await startHarness();
  try {
    // Set up an approved code via the normal flow, but do the exchange manually.
    const { verifier, challenge } = pkcePair();
    const url = new URL("/authorize", h.issuer);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    assert.equal((await fetch(url)).status, 200);
    const pendingBody = (await (
      await fetch(`${h.issuer}/oauth/pending`, { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } })
    ).json()) as { pending: Array<{ ref: string }> };
    const ref = pendingBody.pending[0]?.ref;
    assert.ok(ref);
    const approveBody = (await (
      await fetch(`${h.issuer}/oauth/pending/${ref}/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      })
    ).json()) as { redirect: string };
    const code = new URL(approveBody.redirect).searchParams.get("code");
    assert.ok(code);

    const exchange = (body: Record<string, string>) =>
      fetch(`${h.issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });

    // Wrong client secret → 400 invalid_client (token untouched, code intact).
    const wrongSecret = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: "wrong",
    });
    assert.equal(wrongSecret.status, 400);
    assert.equal(((await wrongSecret.json()) as { error?: string }).error, "invalid_client");

    // Wrong PKCE verifier → 400 invalid_grant.
    const wrongVerifier = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: randomBytes(48).toString("base64url"),
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    assert.equal(wrongVerifier.status, 400);
    assert.equal(((await wrongVerifier.json()) as { error?: string }).error, "invalid_grant");

    // Correct exchange succeeds…
    const good = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    assert.equal(good.status, 200);

    // …and the code is single-use: replay fails.
    const replay = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error?: string }).error, "invalid_grant");

    // Refresh grant is not supported.
    const refresh = await exchange({
      grant_type: "refresh_token",
      refresh_token: "whatever",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    assert.equal(refresh.status, 400);
    assert.equal(((await refresh.json()) as { error?: string }).error, "unsupported_grant_type");
  } finally {
    await h.cleanup();
  }
});

test("poll endpoint: wrong secret rejected, approved poll returns the callback redirect", async () => {
  const h = await startHarness();
  try {
    const { challenge } = pkcePair();
    const url = new URL("/authorize", h.issuer);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "poll-state");
    const html = await (await fetch(url)).text();
    const txnMatch = html.match(/var txn = "([0-9a-f]{32})"/);
    const secretMatch = html.match(/var secret = "([0-9a-f]{32})"/);
    assert.ok(txnMatch?.[1] && secretMatch?.[1], "page must embed txn id and poll secret");
    const txn = txnMatch[1];
    const pollSecret = secretMatch[1];

    const poll = (body: unknown) =>
      fetch(`${h.issuer}/oauth/authorize/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Wrong secret → 401; missing fields → 400.
    assert.equal((await poll({ txn, pollSecret: "0".repeat(32) })).status, 401);
    assert.equal((await poll({ txn })).status, 400);

    // Pending before decision.
    const pendingPoll = await poll({ txn, pollSecret });
    assert.equal(pendingPoll.status, 200);
    assert.deepEqual(await pendingPoll.json(), { status: "pending" });

    // Approve, then the poll returns the redirect with code + state.
    const pendingList = (await (
      await fetch(`${h.issuer}/oauth/pending`, { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } })
    ).json()) as { pending: Array<{ ref: string }> };
    const ref = pendingList.pending[0]?.ref;
    assert.ok(ref);
    await fetch(`${h.issuer}/oauth/pending/${ref}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    const approvedPoll = (await (await poll({ txn, pollSecret })).json()) as {
      status: string;
      redirect: string;
    };
    assert.equal(approvedPoll.status, "approved");
    const redirect = new URL(approvedPoll.redirect);
    assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT_URI);
    assert.equal(redirect.searchParams.get("state"), "poll-state");
    assert.ok(redirect.searchParams.get("code"));

    // Unknown txn reads as expired (no oracle for txn existence).
    const unknown = await poll({ txn: "f".repeat(32), pollSecret });
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { status: "expired" });
  } finally {
    await h.cleanup();
  }
});

test("operator endpoints require the operator token; deny flow reaches the poller", async () => {
  const h = await startHarness();
  try {
    const { challenge } = pkcePair();
    const url = new URL("/authorize", h.issuer);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const html = await (await fetch(url)).text();
    const txn = html.match(/var txn = "([0-9a-f]{32})"/)?.[1];
    const pollSecret = html.match(/var secret = "([0-9a-f]{32})"/)?.[1];
    assert.ok(txn && pollSecret);

    // No token / bad token → 401 for pending list and decisions.
    assert.equal((await fetch(`${h.issuer}/oauth/pending`)).status, 401);
    const pendingList = (await (
      await fetch(`${h.issuer}/oauth/pending`, { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } })
    ).json()) as { pending: Array<{ ref: string }> };
    const ref = pendingList.pending[0]?.ref;
    assert.ok(ref);
    assert.equal((await fetch(`${h.issuer}/oauth/pending/${ref}/deny`, { method: "POST" })).status, 401);

    // Deny with the operator token; the poller sees "denied".
    const deny = await fetch(`${h.issuer}/oauth/pending/${ref}/deny`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    assert.equal(deny.status, 200);
    const denied = await fetch(`${h.issuer}/oauth/authorize/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txn, pollSecret }),
    });
    assert.deepEqual(await denied.json(), { status: "denied" });

    // Approving a denied txn conflicts.
    const approveDenied = await fetch(`${h.issuer}/oauth/pending/${ref}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    assert.equal(approveDenied.status, 409);

    // Unknown ref → 404.
    const missing = await fetch(`${h.issuer}/oauth/pending/nope/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    assert.equal(missing.status, 404);
  } finally {
    await h.cleanup();
  }
});

test("disabled OAuth serves no facade endpoints and keeps the bare Bearer challenge", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-oauth-off-"));
  const tokensPath = path.join(dir, "tokens.json");
  const config = parseOAuthConfig({ enabled: false });
  const server = new EngramAccessHttpServer({
    service: serviceStub as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: OPERATOR_TOKEN,
    authTokenEntriesGetter: () => getAllValidTokenEntriesCached(tokensPath),
    tokenPathPolicy: (connector, pathname) => connector !== "chatgpt" || pathname === "/mcp",
    adminConsoleEnabled: false,
    externalRequestHandler: buildOAuthRequestHandler(config, { tokensPath }),
  });
  const status = await server.start();
  try {
    const base = `http://127.0.0.1:${status.port}`;
    for (const p of ["/.well-known/oauth-authorization-server", "/authorize", "/oauth/pending"]) {
      const resp = await fetch(`${base}${p}`);
      assert.notEqual(resp.status, 200, `${p} must not be served when OAuth is disabled`);
    }
    const unauth = await fetch(`${base}/mcp`, { method: "POST" });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("www-authenticate"), "Bearer");
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("oauth config parsing rejects invalid input and applies env overrides", async (t) => {
  // Invalid enum / URL / boolean values throw with precise messages.
  assert.throws(() => parseOAuthConfig({ enabled: true }), /issuerUrl/);
  assert.throws(
    () => parseOAuthConfig({ enabled: true, issuerUrl: "https://x.example", clientId: "c" }),
    /clientSecret/,
  );
  assert.throws(
    () =>
      parseOAuthConfig({
        enabled: true,
        issuerUrl: "http://not-localhost.example",
        clientId: "c",
        clientSecret: "s",
      }),
    /https/,
  );
  assert.throws(
    () =>
      parseOAuthConfig({
        enabled: true,
        issuerUrl: "https://x.example",
        clientId: "c",
        clientSecret: "s",
        tokenEndpointAuthMethod: "client_secret_basic",
      }),
    /tokenEndpointAuthMethod/,
  );
  assert.throws(
    () =>
      parseOAuthConfig({
        enabled: true,
        issuerUrl: "https://x.example",
        clientId: "c",
        clientSecret: "s",
        redirectUris: ["not-a-url"],
      }),
    /redirectUris\[0\]/,
  );
  assert.throws(() => parseOAuthConfig({ enabled: "maybe" }), /boolean/);

  // String booleans coerce ("false"/"0" are falsy — repo rule 24).
  assert.equal(parseOAuthConfig({ enabled: "false" }).enabled, false);
  assert.equal(parseOAuthConfig({ enabled: "0" }).enabled, false);

  // Env overrides win over the file block.
  const envKeys = [
    "REMNIC_OAUTH_ENABLED",
    "REMNIC_OAUTH_ISSUER_URL",
    "REMNIC_OAUTH_CLIENT_ID",
    "REMNIC_OAUTH_CLIENT_SECRET",
    "REMNIC_OAUTH_REDIRECT_URIS",
  ] as const;
  const saved = new Map(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.REMNIC_OAUTH_ENABLED = "true";
  process.env.REMNIC_OAUTH_ISSUER_URL = "https://env.example";
  process.env.REMNIC_OAUTH_CLIENT_ID = "env-client";
  process.env.REMNIC_OAUTH_CLIENT_SECRET = "env-secret";
  process.env.REMNIC_OAUTH_REDIRECT_URIS = "https://chatgpt.com/connector/oauth/a, https://chatgpt.com/connector/oauth/b";
  const parsed = applyOAuthEnvOverrides({ enabled: false, clientId: "file-client" });
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.issuerUrl, "https://env.example");
  assert.equal(parsed.clientId, "env-client");
  assert.deepEqual(parsed.redirectUris, [
    "https://chatgpt.com/connector/oauth/a",
    "https://chatgpt.com/connector/oauth/b",
  ]);
});

test("rate limiting: decision bucket returns JSON 429 when exhausted; poll bucket stays independent", async () => {
  const h = await startHarness();
  try {
    // The decision limiter is 30/min. Fire 31 approve attempts against a
    // non-existent ref (each would otherwise be a 404) — the 31st must be
    // a 429 from the limiter, proving the operator mutation route is
    // rate-limited.
    let sawRateLimit = false;
    let rateLimitBody: { error?: string } | undefined;
    for (let i = 0; i < 31; i++) {
      const resp = await fetch(`${h.issuer}/oauth/pending/no-such-ref/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      });
      if (resp.status === 429) {
        sawRateLimit = true;
        rateLimitBody = (await resp.json()) as { error?: string };
        break;
      }
    }
    assert.equal(sawRateLimit, true, "decision route must 429 once its bucket is exhausted");
    assert.equal(rateLimitBody?.error, "rate_limited", "429 body must be deterministic JSON");

    // The poll bucket is independent: even after the decision limiter
    // tripped, a poll still gets a normal (non-429) response.
    const poll = await fetch(`${h.issuer}/oauth/authorize/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txn: "f".repeat(32), pollSecret: "0".repeat(32) }),
    });
    assert.notEqual(poll.status, 429, "poll bucket must not be consumed by decision traffic");
  } finally {
    await h.cleanup();
  }
});

test("OAuthState.reviveCode: a persist failure can un-burn the code so the exchange retries", () => {
  const config = parseOAuthConfig({
    enabled: true,
    issuerUrl: "http://127.0.0.1:4318",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
  });
  const state = new OAuthState(config);
  const txn = state.createPending({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: [],
    resource: undefined,
    state: undefined,
    codeChallenge: "x".repeat(43),
  });
  const { code } = state.approveByRef(txn.ref);

  // First exchange consumes the code.
  const first = state.takeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, resource: undefined });
  assert.ok(first, "first takeCode must succeed");
  // Single-use: a second attempt is rejected while consumed.
  assert.equal(
    state.takeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, resource: undefined }),
    undefined,
    "a consumed code must not be reusable",
  );
  // Simulating a token-persist failure: revive, then the retry succeeds.
  state.reviveCode(code);
  const retry = state.takeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, resource: undefined });
  assert.ok(retry, "revived code must be exchangeable again");

  // A binding mismatch is NOT revived by reviveCode (only un-burns; the
  // wrong-client attempt below still fails on its own merits).
  state.reviveCode(code);
  assert.equal(
    state.takeCode({ code, clientId: "someone-else", redirectUri: REDIRECT_URI, resource: undefined }),
    undefined,
    "wrong client_id must still be rejected after revive",
  );
});

test("token exchange: persist failure returns 500 and preserves the code; retry after recovery succeeds once", async () => {
  // tokensPath lives in a read-only directory, so token-store LOAD (file
  // absent → empty) works but the WRITE fails with EACCES — forcing the
  // real catch in exchangeAuthorizationCode without breaking reads.
  // Restoring write permission lets a retry of the SAME code succeed,
  // proving the code was not burned by the failed persist.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-oauth-persistfail-"));
  const roDir = path.join(dir, "ro");
  await mkdir(roDir, { recursive: true });
  await chmod(roDir, 0o555);
  const tokensPath = path.join(roDir, "tokens.json"); // parent is read-only → EACCES on write
  const port = await reserveFreePort();
  const issuer = `http://127.0.0.1:${port}`;
  const config = parseOAuthConfig({
    enabled: true,
    issuerUrl: issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
  });
  const server = new EngramAccessHttpServer({
    service: serviceStub as unknown as EngramAccessService,
    host: "127.0.0.1",
    port,
    authToken: OPERATOR_TOKEN,
    authTokenEntriesGetter: () => getAllValidTokenEntriesCached(tokensPath),
    tokenPathPolicy: (connector, pathname) => connector !== "chatgpt" || pathname === "/mcp",
    adminConsoleEnabled: false,
    externalRequestHandler: buildOAuthRequestHandler(config, { tokensPath }),
  });
  await server.start();
  try {
    const { verifier, challenge } = pkcePair();
    const authorizeUrl = new URL("/authorize", issuer);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    assert.equal((await fetch(authorizeUrl)).status, 200);
    const pending = (await (
      await fetch(`${issuer}/oauth/pending`, { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } })
    ).json()) as { pending: Array<{ ref: string }> };
    const ref = pending.pending[0]?.ref;
    assert.ok(ref);
    const approve = (await (
      await fetch(`${issuer}/oauth/pending/${ref}/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      })
    ).json()) as { redirect: string };
    const code = new URL(approve.redirect).searchParams.get("code");
    assert.ok(code);

    const exchange = () =>
      fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }),
      });

    // Persist fails → 500 server_error, no token minted.
    const failed = await exchange();
    assert.equal(failed.status, 500);
    assert.equal(((await failed.json()) as { error?: string }).error, "server_error");
    assert.deepEqual([...getAllValidTokenEntriesCached(tokensPath)], [], "no token may be persisted on failure");

    // Recover: restore write permission so the token store can persist.
    await chmod(roDir, 0o755);
    const ok = await exchange();
    assert.equal(ok.status, 200, `retry must succeed after recovery: ${await ok.clone().text()}`);
    assert.match(((await ok.json()) as { access_token: string }).access_token, /^remnic_cg_/);

    // Single-use preserved: a third attempt with the now-spent code fails.
    const replay = await exchange();
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error?: string }).error, "invalid_grant");
  } finally {
    await server.stop();
    await chmod(roDir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyOAuthEnvOverrides rejects a present-but-non-object server.oauth block", () => {
  // `"oauth": true` / a string is invalid config, not "disabled" — it must
  // throw rather than silently coerce to {} and turn OAuth off.
  for (const bad of [true, "on", 42, ["x"]]) {
    assert.throws(() => applyOAuthEnvOverrides(bad), /server\.oauth/);
  }
  // undefined (absent) is legal → disabled.
  assert.equal(applyOAuthEnvOverrides(undefined).enabled, false);
});

test("poll reports expired (not approved) once the authorization code is gone", () => {
  const config = parseOAuthConfig({
    enabled: true,
    issuerUrl: "http://127.0.0.1:4318",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
  });
  const state = new OAuthState(config);
  const txn = state.createPending({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: [],
    resource: undefined,
    state: undefined,
    codeChallenge: "x".repeat(43),
  });
  state.approveByRef(txn.ref);
  // While the code is live, poll hands back the redirect.
  const approved = state.poll(txn.txn, txn.pollSecret);
  assert.equal(approved?.status, "approved");
  // Consume the code (as the token exchange does). The pending txn still
  // reads "approved" (600 s TTL) but the code (120 s TTL) is gone, so poll
  // must NOT redirect the browser to a dead code — it reports expired.
  const code = new URL((approved as { redirect: string }).redirect).searchParams.get("code");
  assert.ok(code, "approved poll must carry a code in the redirect");
  const taken = state.takeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, resource: undefined });
  assert.ok(taken, "sanity: code was consumable");
  const afterConsume = state.poll(txn.txn, txn.pollSecret);
  assert.equal(afterConsume?.status, "expired", "poll must not redirect with a spent/expired code");
});

test("approved transactions survive the pending TTL while the authorization code is still live", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  try {
    const config = parseOAuthConfig({
      enabled: true,
      issuerUrl: "http://127.0.0.1:4318",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUris: [REDIRECT_URI],
      approvalTtlSeconds: 1, // 1 s pending TTL vs 120 s code TTL
    });
    const state = new OAuthState(config);
    const txn = state.createPending({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: [],
      resource: undefined,
      state: undefined,
      codeChallenge: "x".repeat(43),
    });
    state.approveByRef(txn.ref);
    // Advance PAST the 1 s pending TTL but well within the 120 s code TTL.
    t.mock.timers.tick(1_500);
    const stillApproved = state.poll(txn.txn, txn.pollSecret);
    assert.equal(stillApproved?.status, "approved", "approval before the deadline must remain redeemable");
    // Advance past the code TTL: now both code and txn are gone.
    t.mock.timers.tick(120_000);
    const afterCode = state.poll(txn.txn, txn.pollSecret);
    assert.equal(afterCode?.status, "expired");
  } finally {
    t.mock.timers.reset();
  }
});
