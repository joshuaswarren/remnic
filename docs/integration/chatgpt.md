# Using Remnic from chatgpt.com (developer mode)

This guide walks through connecting a local Remnic server to ChatGPT on the
web via ChatGPT's developer mode. The flow uses ChatGPT's streamable-HTTP MCP
transport and OAuth 2.1 with a local operator-approval step.

The chatgpt.com developer-mode flow is a **public-internet** MCP flow:
ChatGPT's backend has to reach your server. You do not point ChatGPT at
`http://localhost:4318`. You expose the server over HTTPS (Tailscale Funnel or
a Cloudflare Tunnel), put a real `client_id` / `client_secret` you control
into Remnic's config, and ChatGPT runs the OAuth dance against that public
URL. The local operator approves every link request on the server machine.

> **Not the ChatGPT Apps widget.** This guide is the OAuth + streamable-HTTP
> MCP integration, not the SDK-style widget resource documented in
> [`../chatgpt-apps-demo.md`](../chatgpt-apps-demo.md). The widget there works
> locally against `/mcp` with a bearer token; this guide covers the public
> flow ChatGPT itself uses.

---

## Prerequisites

- **ChatGPT plan:** Pro, Plus, Business, Enterprise, or Edu on the web. The
  developer-mode MCP flow is a ChatGPT-side feature and is not available on
  the mobile or desktop ChatGPT clients.
- **ChatGPT developer mode enabled:** ChatGPT web → **Settings** → **Security
  and login** → **Developer mode** → turn on. ChatGPT will not show the
  developer-mode app option at `chatgpt.com/plugins` until this is on.
- **Remnic server running locally.** Start the standalone daemon:
  ```bash
  export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
  remnic daemon start
  remnic status
  ```
  See [Connector Setup Guide](./connector-setup.md) and
  [Deployment Topologies](./deployment-topologies.md) for full setup,
  including the OpenClaw plugin-mode alternative. The default port is
  `4318`; substitute your own port everywhere if you change it.
- **A `client_id` and `client_secret` you generate yourself.** Remnic is the
  authorization server in this flow — there is no third-party IdP. You mint
  the credentials in Remnic's config and paste the same values into ChatGPT's
  app-creation UI. Generate a strong secret with:
  ```bash
  openssl rand -hex 32
  ```

---

## Step 1: Expose the server over public HTTPS

ChatGPT's backend only speaks to public HTTPS URLs. You need a tunnel that
gives your local server a stable `https://...` URL and terminates TLS
outside the tunnel. **Do not bind Remnic to `0.0.0.0` on the public
internet and skip the tunnel** — ChatGPT requires HTTPS and the bearer-token
+ OAuth model in this guide assumes the tunnel, not raw exposure.

> **Authentication is mandatory.** Remnic's OAuth facade is the gatekeeper,
> but treat the public URL as untrusted: never expose the server over HTTPS
> without `server.oauth.enabled: true` and a strong `clientSecret`. A bare
> `/mcp` with the operator bearer token behind a tunnel is an instant memory
> exfiltration path.

### Option A: Tailscale Funnel (recommended)

Tailscale Funnel is the simplest path: one command, no account setup, and the
resulting URL (`https://<node>.<tailnet>.ts.net`) is stable for the lifetime
of the node.

1. Install and log in to Tailscale on the machine running Remnic:
   ```bash
   # See https://tailscale.com/download for your platform
   tailscale up
   ```
2. Enable Funnel for the Remnic port (substitute the port you started on):
   ```bash
   sudo tailscale funnel 4318
   ```
3. Tailscale prints the public URL. It will look like:
   ```
   https://<node>.<tailnet>.ts.net/
   ```
   Copy that — this is the value you will paste into `server.oauth.issuerUrl`
   below. Tailscale Funnel terminates TLS at the edge, so Remnic only needs
   to bind to `127.0.0.1` on the plain HTTP port; you do **not** need
   certificates or a reverse proxy.

> **Note:** Tailscale Funnel proxies through Tailscale's edge and terminates
> TLS before forwarding to your daemon. This means mTLS client-certificate
> verification is **not possible** behind Funnel — see [Security
> notes](#security-notes) below.

### Option B: Cloudflare Tunnel (alternative)

`cloudflared tunnel` also works as a generic TLS-terminating front. Run
`cloudflared tunnel` against the same Remnic port; use whatever hostname
Cloudflare assigns as your `issuerUrl`. This guide is intentionally
account-agnostic; see the `cloudflared` docs for the one-time login and DNS
routing on your account.

Whatever tunnel you use, the rule is: the URL ChatGPT sees (the value of
`server.oauth.issuerUrl` below) must match the URL the tunnel fronts —
discovery, redirects, and the `WWW-Authenticate` resource-metadata pointer
all key off it.

---

## Step 2: Configure OAuth in Remnic

Remnic is the **authorization server** in this flow. You define the
`client_id`, the `client_secret`, the redirect allowlist, and the public
issuer URL in Remnic's config; you paste the same `client_id` /
`client_secret` into ChatGPT's app-creation UI.

Add the following to your Remnic server config (e.g. `~/.config/remnic/config.json`
or wherever you keep the server config; env overrides are listed below):

```jsonc
{
  "server": {
    "oauth": {
      "enabled": true,
      "issuerUrl": "https://<node>.<tailnet>.ts.net",
      "clientId": "remnic-chatgpt",
      "clientSecret": "<openssl rand -hex 32 output>",
      "tokenEndpointAuthMethod": "client_secret_post",
      "redirectUris": [],
      "approvalTtlSeconds": 600
    }
  }
}
```

Field-by-field:

| Key | Required | Description |
|-----|----------|-------------|
| `enabled` | yes | Master gate. Must be `true` for ChatGPT to discover the OAuth endpoints. Default `false`. |
| `issuerUrl` | yes | **Public HTTPS base URL of the tunneled server.** Must match the URL ChatGPT sees exactly — this is the value the discovery documents are served from, and the value used in `WWW-Authenticate: Bearer resource_metadata=...` on `401` responses. |
| `clientId` | yes | Operator-chosen identifier. You paste the same string into ChatGPT's app-creation UI. Pick anything memorable; the same value is the credential both sides trust. |
| `clientSecret` | yes | High-entropy secret. Generate with `openssl rand -hex 32`. The same value is pasted into ChatGPT as the OAuth client secret. |
| `tokenEndpointAuthMethod` | yes | Exactly one of `client_secret_post`, `client_secret_basic`, or `none`. This single method is both **advertised** in the discovery document and **enforced** at the token endpoint. Pick one and stick with it. |
| `redirectUris` | yes | Exact byte-for-byte allowlist of allowed ChatGPT redirect URIs. No prefixes, no patterns. You will add the value ChatGPT shows you after the app is created (see Step 3). Empty array = nothing can link. |
| `approvalTtlSeconds` | no | How long a pending authorization transaction lives while waiting for the local operator to approve. Default `600` (10 minutes). |

Environment overrides (all `REMNIC_OAUTH_*`):

| Variable | Maps to |
|----------|---------|
| `REMNIC_OAUTH_ENABLED` | `server.oauth.enabled` (booleans: `true`/`1`/`yes`/`on`; anything else is falsy) |
| `REMNIC_OAUTH_ISSUER_URL` | `server.oauth.issuerUrl` |
| `REMNIC_OAUTH_CLIENT_ID` | `server.oauth.clientId` |
| `REMNIC_OAUTH_CLIENT_SECRET` | `server.oauth.clientSecret` |
| `REMNIC_OAUTH_TOKEN_AUTH_METHOD` | `server.oauth.tokenEndpointAuthMethod` |
| `REMNIC_OAUTH_REDIRECT_URIS` | `server.oauth.redirectUris` (comma-separated) |
| `REMNIC_OAUTH_APPROVAL_TTL_SECONDS` | `server.oauth.approvalTtlSeconds` |

Restart the Remnic server so the OAuth facade mounts:

```bash
remnic daemon restart
remnic status
```

Verify discovery is reachable on the public URL:

```bash
curl https://<node>.<tailnet>.ts.net/.well-known/oauth-authorization-server
# Expect JSON with authorization_endpoint, token_endpoint, and the single
# token_endpoint_auth_methods_supported value matching your config.
```

If discovery returns a connection error or the wrong JSON, the tunnel or
`issuerUrl` is misconfigured — fix that before continuing, because every
later step depends on it.

---

## Step 3: Create the app in ChatGPT

1. In a browser, go to <https://chatgpt.com/plugins>.
2. Click the **+** (add) button, choose **developer-mode app**.
3. Fill in the form:
   - **MCP server URL:** `<issuerUrl>/mcp` — for example,
     `https://<node>.<tailnet>.ts.net/mcp`.
   - **Authentication:** **OAuth**.
   - **Client ID:** the same `clientId` you put in `server.oauth.clientId`
     (e.g. `remnic-chatgpt`).
   - **Client Secret:** the same `clientSecret` you put in
     `server.oauth.clientSecret` (the `openssl rand -hex 32` output).
4. Save the app. ChatGPT will run an initial discovery check; if it
   succeeds, the app is created and its management page shows the
   per-app **redirect/callback URL** — it looks like
   `https://chatgpt.com/connector/oauth/{callback_id}`. **Copy that exact
   value.** ChatGPT appends this URL to the authorization request and
   Remnic's allowlist must match it byte-for-byte.
5. Edit your Remnic config to add the copied URL to `redirectUris`:
   ```jsonc
   {
     "server": {
       "oauth": {
         "redirectUris": [
           "https://chatgpt.com/connector/oauth/<callback_id>"
         ]
       }
     }
   }
   ```
   Restart the server:
   ```bash
   remnic daemon restart
   ```
6. Back in ChatGPT, link / connect the app. ChatGPT will start the
   authorization-code + PKCE (S256) flow against the discovery
   `authorization_endpoint`; the operator-approval step happens on the
   server machine (next section).

> **If ChatGPT errors before you can copy the redirect URL:** the app is
> still created, but ChatGPT's app management page may not display it
> until the first link attempt succeeds. Re-open the app's settings;
> the redirect URL is on the app's detail page.

---

## Step 4: Approve the link request locally

When ChatGPT starts the authorization flow, Remnic's OAuth facade
generates a pending transaction and serves an approval-instructions page in
the user's browser. The page does **not** ask for any credential — it shows
the approval ref and instructions to run the CLI on the server machine.

On the **server machine** (the one running Remnic), in another terminal:

```bash
remnic oauth pending
```

Expected output (text):

```
Pending OAuth authorization requests (1):

  ref:        a8f3-91d2-4e07
  client:     remnic-chatgpt
  redirect:   https://chatgpt.com/connector/oauth/<callback_id>
  scopes:     (none requested)
  resource:   https://<node>.<tailnet>.ts.net/mcp
  created:    2026-07-11T09:42:13.117Z
  expires:    2026-07-11T09:52:13.117Z
```

**Verify the `client`, `redirect`, `scopes`, and `resource` match what you
expect before approving.** This is the only place you can refuse a request
that, e.g., is asking for the wrong redirect URI or a different MCP resource.

Approve (add `--yes` to skip the interactive prompt):

```bash
remnic oauth approve a8f3-91d2-4e07 --yes
```

Or, for the interactive form:

```bash
remnic oauth approve a8f3-91d2-4e07
```

Expected output (text):

```
Approving authorization request a8f3-91d2-4e07

  client:     remnic-chatgpt
  redirect:   https://chatgpt.com/connector/oauth/<callback_id>
  scopes:     (none requested)
  resource:   https://<node>.<tailnet>.ts.net/mcp

Approved. ChatGPT will complete the browser flow automatically.
```

The browser tab on the ChatGPT side will then automatically complete the
flow and ChatGPT will mark the app as linked. If the transaction has
expired (`approvalTtlSeconds` elapsed, default 10 minutes) the page will
show an "expired approval" message and ChatGPT will retry from the
beginning — re-run `remnic oauth pending` to see the new ref.

To refuse a request:

```bash
remnic oauth deny a8f3-91d2-4e07 --yes
```

---

## Step 5: Use the app in the ChatGPT composer

Once linked, ChatGPT treats the app's MCP tools as developer-mode tools in
the composer. The MCP tools exposed by Remnic are the same tools the
standalone server exposes to every other MCP client (see [Connector Setup
Guide](./connector-setup.md) for the full tool list). Common ones to try:

- `remnic.recall` — pull relevant memories into the conversation.
- `remnic.memory_store` — explicitly save a memory.
- `remnic.briefing` — session-start context load.
- `remnic.observe` — observe a turn for later extraction.
- `remnic.search` — direct search over the memory store.
- `remnic.chatgpt_memory_inspector` — the read-only widget-backed inspector
  (see [`../chatgpt-apps-demo.md`](../chatgpt-apps-demo.md)).

Example prompts (paste into the ChatGPT composer):

```
Use remnic.recall to find my preferences about TypeScript project
layout, then summarize the top three.

Use remnic.briefing to load relevant context from last week about
the Acme migration, then list the open questions.

Use remnic.memory_store to remember: "I prefer Bun over pnpm for
new TypeScript projects in 2026."
```

> **Write tools require per-conversation confirmation.** Remnic's tool
> annotations mark tools without a `readOnlyHint` annotation as
> write/mutate tools. ChatGPT will prompt the user to confirm any such
> tool call before invoking it. The same is true in the admin console; see
> [Connector Setup Guide](./connector-setup.md) for the read/write split
> per tool.

> **Tighten the tool surface.** If you do not want every tool exposed
> (for example, if you only want `remnic.recall` in ChatGPT), open the
> app's settings page in ChatGPT and disable the tools you do not need.
> Remnic's server returns the same tool list to every OAuth-authenticated
> ChatGPT session; per-app tool filtering is on ChatGPT's side.

### Token rotation on re-link

When you re-link the app (or ChatGPT rotates its tokens for any other
reason), Remnic issues a new access token under the connector id `chatgpt`
and revokes the old one. You can see the current token with:

```bash
remnic token list
```

Expected output (excerpt):

```
Connector tokens:
  chatgpt          remnic_cg_…           (created 2026-07-11T09:55:01.221Z)
  ...
```

The connector id is `chatgpt` and the token prefix is `remnic_cg_`. This
rotation is expected: re-linking is the only ChatGPT-side mechanism that
re-runs the OAuth approval flow.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| ChatGPT loops on a 401 from `/mcp` and never reaches the approval page | `redirectUris` allowlist does not match the per-app redirect URL ChatGPT shows. | Open the app in ChatGPT, copy the **exact** `https://chatgpt.com/connector/oauth/{callback_id}` URL, paste it into `server.oauth.redirectUris`, restart `remnic-server`. The match is byte-exact — trailing slash, query string, or `www.` vs no `www.` all break it. |
| `/.well-known/oauth-authorization-server` returns a connection error from ChatGPT, but works locally | `issuerUrl` does not match the public URL the tunnel fronts. | Set `issuerUrl` to the same `https://...` URL ChatGPT sees (e.g. `https://<node>.<tailnet>.ts.net`), not `http://127.0.0.1:4318`. Restart the server. |
| "Expired approval" in the browser tab on the server machine | `approvalTtlSeconds` elapsed (default 600 s) before the operator ran `remnic oauth approve`. | Run `remnic oauth approve <new-ref>` from the new pending transaction; the old ref is gone. Raise `approvalTtlSeconds` in the OAuth config if your operator is regularly slower. |
| ChatGPT says "service unavailable" or the tool list is empty after the tunnel is working | The tunnel went offline (Tailscale node disconnected, `cloudflared` lost the connection). | Check the tunnel's status (`tailscale status`, `cloudflared tunnel info ...`) and re-establish. The server itself does not need a restart once the tunnel is back. |
| ChatGPT keeps showing the **old** tool list after Remnic added or renamed a tool | ChatGPT caches the discovered tool list per app. | Use the **Refresh** action on the app's settings page in ChatGPT; it forces a re-fetch of the discovery document and tool list. Server-side changes do not invalidate ChatGPT's cache. |
| `remnic oauth pending` says "No pending requests" while the browser is on the approval page | The page is polling the wrong server, or the server is bound to a different port than `issuerUrl` points at. | Check the URL in the browser tab — it should be `<issuerUrl>/oauth/authorize/poll?...`. If it is `127.0.0.1`, the tunnel is not routing correctly. |
| ChatGPT returns "Invalid client" or "Invalid client_secret" at the token endpoint | `clientId` / `clientSecret` pasted into ChatGPT does not match `server.oauth.clientId` / `server.oauth.clientSecret`. | Remnic enforces the single `tokenEndpointAuthMethod` from your config. Re-copy the values from your config file (no surrounding whitespace, no shell-expanded placeholders) and re-paste into the ChatGPT app. |
| Operator `remnic oauth approve` returns 401 | The CLI is talking to a Remnic daemon that does not have the same operator bearer token. | The CLI uses the same operator auth as the rest of the daemon-backed commands (`REMNIC_AUTH_TOKEN` / config). Re-check the config / env on the server machine. |

---

## Security notes

- **Exact-redirect allowlist, not prefix.** `server.oauth.redirectUris` is
  compared byte-for-byte against the `redirect_uri` parameter ChatGPT sends.
  No patterns, no wildcards, no path prefixes. The reason is that any
  prefix/pattern scheme becomes an open redirect in the face of path
  normalization differences between OAuth clients and authorization
  servers. The cost is one config edit per app; the benefit is that
  ChatGPT can only ever bounce the authorization code back to the exact
  URL Remnic expects.

- **Single token-endpoint auth method.** The `tokenEndpointAuthMethod`
  config value is the **only** method Remnic advertises in the discovery
  document and the **only** method Remnic will accept at the token
  endpoint. There is no fallback. Pick one (`client_secret_post` is the
  ChatGPT-compatible default), keep the same value in the config, and
  paste the same `client_id` / `client_secret` into ChatGPT.

- **Approval requires the local operator token.** Knowing the approval
  ref alone is not enough to authorize a request: the CLI's `approve`
  command authenticates against the local Remnic daemon with the operator
  bearer token. The web approval page never accepts a credential — it only
  shows the ref and polls for status. This is by design: the public
  tunnel is untrusted territory; only the operator on the server machine
  can complete the link.

- **`memoryDir` exposure is full memory access.** Anyone who can present a
  valid ChatGPT-issued access token to your `/mcp` endpoint can read
  everything in your memory directory and (for tools without
  `readOnlyHint`) write to it. Treat the public URL as if it were your
  memory directory itself. Use Tailscale ACLs / Cloudflare Access rules
  to restrict what else can hit the URL if your account supports it.

- **Optional hardening: OpenAI published egress IP allowlist.** OpenAI
  publishes the IPs ChatGPT's backend uses. If your account / tunnel
  supports source-IP allowlisting, restrict the funnel to those IPs. See
  the OpenAI docs for the current list — it changes.

- **mTLS is not possible behind Funnel / Cloudflare Tunnel.** Tailscale
  Funnel and `cloudflared tunnel` terminate TLS at the edge and forward
  plain HTTP to your daemon. Remnic therefore cannot verify a client
  certificate in this configuration; the OAuth bearer token is the entire
  authentication story at the MCP layer. If you need mTLS, run Remnic
  behind a reverse proxy that preserves the client-cert handshake end to
  end (nginx with `ssl_verify_client on`, Caddy with `tls` client auth,
  etc.) — and accept that you are giving up the zero-config tunnel.

---

## Endpoint reference (authoritative from contract)

The following paths are mounted by Remnic's OAuth facade and are
authoritative from the integration contract. If a future SDK change moves
any of them, this doc will be updated to match.

- `GET /.well-known/oauth-protected-resource` — RFC 9728 protected-resource
  metadata.
- `GET /.well-known/oauth-protected-resource/mcp` — same shape, scoped to
  the `/mcp` resource.
- `GET /.well-known/oauth-authorization-server` — RFC 8414 authorization-
  server metadata. ChatGPT fetches this during discovery; the
  `authorization_endpoint` and `token_endpoint` values are derived from
  `server.oauth.issuerUrl`.
- `GET /oauth/authorize` — start of the authorization-code + PKCE (S256)
  flow. Validates `client_id`, exact `redirect_uri` match, `response_type=code`,
  and PKCE S256 challenge. Renders the approval-instructions page.
- `POST /oauth/token` — authorization-code grant only. Enforces the
  single configured `tokenEndpointAuthMethod`, verifies the PKCE verifier,
  and returns a long-lived bearer token. Re-linking rotates the token.
- `POST /oauth/authorize/poll` — used by the approval page to wait for
  operator approval. Body is `{ txn, pollSecret }`; response is
  `{ status: "pending" }`, `{ status: "approved", redirect: "..." }`, or
  `{ status: "denied" | "expired" }`.
- `GET /oauth/pending` (operator-only) — list pending transactions.
- `POST /oauth/pending/:ref/approve` (operator-only) — approve.
- `POST /oauth/pending/:ref/deny` (operator-only) — deny.
- `POST /mcp` — the streamable-HTTP MCP endpoint. The
  `401 Unauthorized` response from `/mcp` carries
  `WWW-Authenticate: Bearer resource_metadata="<issuerUrl>/.well-known/oauth-protected-resource/mcp"`
  (RFC 9728), which is what tells ChatGPT where to start discovery.

---

## See also

- [`../chatgpt-apps-demo.md`](../chatgpt-apps-demo.md) — the SDK-style
  widget inspector (separate flow, runs locally with a bearer token).
- [`./connector-setup.md`](./connector-setup.md) — MCP clients, the
  generic `/mcp` bearer-token setup, and the full tool list.
- [`./deployment-topologies.md`](./deployment-topologies.md) — Remnic
  server deployment shapes (localhost, LAN, container, reverse proxy).
- [`../connectors.md`](../connectors.md) — `remnic connectors` CLI
  reference (live connectors; the OAuth flow here is not a "connector"
  in that sense).
- [`../operations.md`](../operations.md) — server lifecycle,
  `REMNIC_AUTH_TOKEN`, and how to read daemon logs (useful when
  troubleshooting discovery or `WWW-Authenticate`).
