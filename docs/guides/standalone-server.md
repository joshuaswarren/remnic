# Standalone multi-tenant server

## Introduction

Remnic can run as a standalone HTTP server that provides persistent memory to multiple agent harnesses simultaneously. In plugin mode, Remnic is embedded inside a single OpenClaw gateway process. In standalone mode, Remnic runs as its own process and exposes both a REST API and an MCP-over-HTTP endpoint that any number of clients can connect to — OpenClaw, Codex CLI, Claude Code, custom scripts, or any MCP-compatible agent.

Use standalone mode when:

- You run multiple agent harnesses (e.g., OpenClaw + Codex CLI + Claude Code) and want them to share one memory backend.
- You want to isolate different projects or clients into separate namespaces with access control.
- You need to feed conversation data from custom agents or automation scripts into Remnic's extraction pipeline.

Use plugin mode when:

- You only use OpenClaw and want zero-config memory that just works.
- You do not need cross-harness memory sharing.

## Architecture

```
┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐
│  OpenClaw    │  │  Codex CLI  │  │  Claude Code  │  │ Custom Agents │
│  (plugin)    │  │  (MCP)      │  │  (MCP)        │  │ (HTTP API)    │
└──────┬───────┘  └──────┬──────┘  └──────┬────────┘  └───────┬───────┘
       │                 │                 │                    │
       │    ┌────────────┴─────────────────┴────────────┐      │
       │    │         Remnic Standalone Server           │      │
       │    │  ┌──────────┐ ┌─────────┐ ┌────────────┐  │◄─────┘
       ├────┤  │   MCP    │ │  HTTP   │ │  Plugin    │  │
            │  │ (stdio)  │ │  REST   │ │  hooks     │  │
            │  └────┬─────┘ └────┬────┘ └─────┬──────┘  │
            │       └────────────┼─────────────┘         │
            │              ┌─────┴──────┐                │
            │              │  Remnic    │                │
            │              │  Core      │                │
            │              ├────────────┤                │
            │  ┌───────────┤ Namespaces ├────────────┐   │
            │  │  default  │  client-a  │  client-b  │   │
            │  │(personal) │  (agents)  │  (agents)  │   │
            │  └───────────┴────────────┴────────────┘   │
            │              ┌────────────┐                │
            │              │  Shared    │                │
            │              │ Knowledge  │                │
            │              └────────────┘                │
            └────────────────────────────────────────────┘
```

All clients connect to the same Remnic process. Each tenant's memories are isolated in their own namespace, with a shared namespace for cross-tenant knowledge. The server authenticates every request with a bearer token and resolves the caller's principal to enforce namespace read/write policies.

## Quick start

Generate a secure token and start the server:

```bash
# Generate a random token
export REMNIC_AUTH_TOKEN="$(openssl rand -hex 32)"

# Start the standalone server directly
npx remnic-server --host 127.0.0.1 --port 4318 --auth-token "$REMNIC_AUTH_TOKEN"
```

Verify it is running:

```bash
curl -s http://localhost:4318/engram/v1/health \
  -H "Authorization: Bearer $REMNIC_AUTH_TOKEN" | jq .
```

You should see a JSON response with `ok: true` and a `qmd` object. In a full
standalone or Docker image, `qmd.active` should be true and `qmd.mode` should be
`"cli"` or `"daemon"`. If `qmd.active` is false while `qmd.enabled` is true,
Remnic is in degraded filesystem fallback mode; use `qmd.debugStatus`,
`qmd.installedVersion`, and `qmd.collectionState` to diagnose the missing
binary, unsupported version, or collection probe problem. The API path remains
`/engram/v1/...` during the v1.x compatibility window.

To bind to all interfaces (e.g., for LAN access from other machines), use `--host 0.0.0.0`. Only do this on trusted networks or behind a reverse proxy.

### Startup readiness and degraded mode

While startup search warm-up is still running, `/engram/v1/health` answers
`503` with `code: "not_ready"` and a rising `warmupAttempts` counter. Recall
and every other route serve normally during this window — the gate only
affects the health signal.

If warm-up cannot complete (for example the `qmd` binary is missing from a
long-lived service's `PATH`), the server does not stay `not_ready` forever:
after `server.readinessDegradedAfterAttempts` failed attempts (default `3`,
roughly two minutes) health switches to `200` with `degraded: true`,
`warmupAttempts`, and `lastError` merged into the normal health payload, and
warm-up retries continue in the background until they succeed. Set
`server.readinessDegradedAfterAttempts` to `0` (or the
`REMNIC_READY_DEGRADED_AFTER_ATTEMPTS` env var) to keep the strict gate, e.g.
when an orchestrator must hold traffic until the search index is warm.
`server.readinessOverride` (`REMNIC_READY_OVERRIDE`) still forces the gate
open immediately.

## Connecting agent harnesses

### OpenClaw (plugin mode)

OpenClaw uses Remnic as a native plugin bridge — it communicates in-process, not over HTTP unless you explicitly delegate to a running daemon. See the main [Installation](../../README.md#installation) section for plugin setup.

If you are also running a standalone server for other clients, OpenClaw's plugin instance and the standalone server share the same memory directory on disk. Changes made by either are visible to both.

### Codex CLI (MCP over HTTP)

Start the Remnic server as shown in Quick Start, then add to `~/.codex/config.toml`:

```toml
[mcp_servers.remnic]
url = "http://127.0.0.1:4318/mcp"
bearer_token_env_var = "REMNIC_AUTH_TOKEN"
```

Or in `~/.codex/config.json`:

```json
{
  "mcpServers": {
    "remnic": {
      "type": "http",
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_REMNIC_AUTH_TOKEN"
      }
    }
  }
}
```

See the [Codex CLI Integration Guide](codex-cli.md) for session-start hooks and automatic recall.

### Claude Code (MCP over HTTP)

Add Remnic to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "remnic": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}"
      }
    }
  }
}
```

Claude Code will discover Remnic's tools automatically. Canonical tool names use the `remnic.*` prefix; legacy `engram.*` aliases remain available through v1.x.

### Custom HTTP agents

Any HTTP client can use the REST API directly. Here are examples in Python and JavaScript.

**Python:**

```python
import requests

REMNIC_URL = "http://localhost:4318"
HEADERS = {"Authorization": "Bearer YOUR_TOKEN"}

# Feed conversation into memory
requests.post(f"{REMNIC_URL}/engram/v1/observe", json={
    "sessionKey": "my-agent-session-1",
    "messages": [
        {"role": "user", "content": "What's the status of project Alpha?"},
        {"role": "assistant", "content": "Project Alpha is on track for Q2 delivery."},
    ]
}, headers=HEADERS)

# Recall relevant context
resp = requests.post(f"{REMNIC_URL}/engram/v1/recall", json={
    "query": "project Alpha status"
}, headers=HEADERS)
print(resp.json()["results"])
```

**JavaScript / TypeScript:**

```javascript
const REMNIC_URL = "http://localhost:4318";
const headers = {
  "Authorization": "Bearer YOUR_TOKEN",
  "Content-Type": "application/json"
};

// Feed conversation into memory
await fetch(`${REMNIC_URL}/engram/v1/observe`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    sessionKey: "my-agent-session-1",
    messages: [
      { role: "user", content: "What's the status of project Alpha?" },
      { role: "assistant", content: "Project Alpha is on track for Q2 delivery." },
    ],
  }),
});

// Recall relevant context
const resp = await fetch(`${REMNIC_URL}/engram/v1/recall`, {
  method: "POST",
  headers,
  body: JSON.stringify({ query: "project Alpha status" }),
});
const data = await resp.json();
console.log(data.results);
```

## Multi-tenant namespace configuration

Namespaces isolate memory per tenant while allowing controlled sharing. They are opt-in — `namespacesEnabled` defaults to `false`. Enable them in your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "namespacesEnabled": true,
          "sharedNamespace": "shared",
          "defaultRecallNamespaces": ["shared"],
          "namespacePolicies": {
            "default": { "read": ["*"], "write": ["default-principal"] },
            "client-a": { "read": ["client-a-agent", "admin"], "write": ["client-a-agent"] },
            "client-b": { "read": ["client-b-agent", "admin"], "write": ["client-b-agent"] },
            "shared": { "read": ["*"], "write": ["admin"] }
          },
          "principalFromSessionKeyMode": "prefix",
          "principalFromSessionKeyRules": {
            "client-a:": "client-a-agent",
            "client-b:": "client-b-agent"
          }
        }
      }
    }
  }
}
```

**How it works:**

1. Each tenant's agents use a session key prefix — e.g., `client-a:session-123`.
2. The `principalFromSessionKeyRules` map matches the prefix to a principal name (`client-a-agent`).
3. The principal determines which namespaces the caller can read and write based on `namespacePolicies`.
4. The `shared` namespace is readable by everyone (`"*"`) but writable only by the `admin` principal.

This means:

- `client-a`'s agents can read and write their own namespace, read the shared namespace, but cannot access `client-b`'s namespace.
- `client-b`'s agents have the same isolation in reverse.
- An admin can write to the shared namespace to publish cross-tenant knowledge.

When you want a standalone server instance to run as a specific tenant, set the
default principal in `remnic.config.json`:

```bash
cat > remnic.config.json <<EOF
{
  "server": {
    "host": "127.0.0.1",
    "port": 4318,
    "authToken": "${REMNIC_AUTH_TOKEN}",
    "principal": "client-a-agent"
  }
}
EOF
```

Then start the server normally with `npx remnic-server` (or `remnic daemon start`
if your config is already in place).

For multi-tenant access from a single standalone instance, prefer session-key
prefix rules. Header-based per-request principal override is not currently
available through `remnic-server` (see [Per-Request Principal Override](#per-request-principal-override) below).

See the [Namespaces documentation](../namespaces.md) for full details on namespace storage layout, QMD collection configuration, and CLI tooling.

## The observe endpoint

`POST /engram/v1/observe` feeds conversation messages into Remnic's memory pipeline. This is the primary integration point for custom agents that are not using MCP.

### Request

```json
{
  "sessionKey": "my-agent-session-1",
  "messages": [
    { "role": "user", "content": "What's the status of project Alpha?" },
    { "role": "assistant", "content": "Project Alpha is on track for Q2 delivery." }
  ],
  "namespace": "client-a",
  "skipExtraction": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | string | Yes | Conversation session identifier. Used for LCM archival and principal resolution when `principalFromSessionKeyMode` is `prefix`. |
| `messages` | array | Yes | Array of message objects with `role` (`"user"` or `"assistant"`) and `content` (string). Must be non-empty. |
| `namespace` | string | No | Target namespace. Defaults to the resolved namespace from the principal. |
| `skipExtraction` | boolean | No | When `true`, messages are archived in LCM but not sent through the extraction pipeline. Useful for LCM-only archival of high-volume conversations. |

### Response (HTTP 202 Accepted)

```json
{
  "accepted": 2,
  "sessionKey": "my-agent-session-1",
  "namespace": "client-a",
  "lcmArchived": true,
  "extractionQueued": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `accepted` | number | Number of messages accepted. |
| `sessionKey` | string | Echo of the session key. |
| `namespace` | string | Resolved namespace. |
| `lcmArchived` | boolean | Whether messages were archived in LCM (requires `lcmEnabled: true`). |
| `extractionQueued` | boolean | Whether messages were queued for extraction. `false` when `skipExtraction` is `true`. |

### What happens under the hood

1. **Namespace resolution** — The target namespace is resolved from the request's `namespace` field, the session key prefix, or the authenticated principal.
2. **LCM archival** — If `lcmEnabled` is `true`, messages are immediately indexed into the LCM SQLite archive with full-text search.
3. **Extraction pipeline** — Unless `skipExtraction` is `true`, messages are ingested into the extraction buffer. When the buffer trigger fires, an LLM extracts structured memories (facts, decisions, preferences, etc.) from the accumulated turns.

### Rate limiting

The observe endpoint is rate-limited to **30 requests per minute** per server instance. Dry runs and idempotency replays do not count toward the limit. If the limit is exceeded, the server returns HTTP 429.

## LCM search

`POST /engram/v1/lcm/search` performs full-text search over the LCM conversation archive. This searches raw archived messages, not extracted memories.

**When to use which search:**

| Search method | What it searches | Best for |
|---------------|-----------------|----------|
| `POST /engram/v1/recall` | Extracted memories (semantic + keyword) | Finding relevant knowledge, facts, decisions |
| `POST /engram/v1/lcm/search` | Raw archived conversation messages (FTS) | Finding exact phrases, debugging what was said, auditing |
| `GET /engram/v1/memories` | Memory browse with filters | Browsing by category, status, namespace |

### Request

```json
{
  "query": "project Alpha delivery",
  "sessionKey": "my-agent-session-1",
  "limit": 10
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Full-text search query. |
| `sessionKey` | string | No | Filter results to a specific session. |
| `namespace` | string | No | Filter by namespace. |
| `limit` | number | No | Maximum results (default: 10). |

### Response (HTTP 200)

```json
{
  "query": "project Alpha delivery",
  "namespace": "default",
  "results": [
    {
      "sessionId": "my-agent-session-1",
      "content": "Project Alpha is on track for Q2 delivery.",
      "turnIndex": 4
    }
  ],
  "count": 1,
  "lcmEnabled": true
}
```

If `lcmEnabled` is `false`, the response will have an empty `results` array and `lcmEnabled: false`.

### LCM status

`GET /engram/v1/lcm/status` returns LCM availability and stats:

```json
{
  "enabled": true,
  "archiveAvailable": true,
  "stats": {
    "totalTurns": 4271
  }
}
```

## Per-request principal override

Standalone `remnic-server` does not currently expose a CLI flag to enable
trusted per-request principal override. In standalone mode, principal resolution
comes from `server.principal` in config or from session-key prefix rules.

If you need `X-Engram-Principal` header trust today, use the OpenClaw-hosted HTTP
access server instead of `remnic-server`:

```bash
openclaw engram access http-serve \
  --host 127.0.0.1 \
  --port 4318 \
  --token "$REMNIC_AUTH_TOKEN" \
  --trust-principal-header
```

### Usage (OpenClaw compatibility path)

Include the header in your requests:

```bash
curl -X POST http://localhost:4318/engram/v1/observe \
  -H "Authorization: Bearer $REMNIC_AUTH_TOKEN" \
  -H "X-Engram-Principal: client-a-agent" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "session-123",
    "messages": [
      {"role": "user", "content": "Update on project Alpha."},
      {"role": "assistant", "content": "All milestones are on track."}
    ]
  }'
```

The `X-Engram-Principal` header value becomes the authenticated principal for that request, determining namespace read/write access.

### Security considerations

- **Only enable `--trust-principal-header` when the bearer token provides sufficient trust.** Anyone with the token can impersonate any principal.
- If you run the server behind a reverse proxy, ensure the proxy strips or validates the `X-Engram-Principal` header from untrusted clients.
- Without `--trust-principal-header`, the header is silently ignored — principal resolution falls back to configured principal or session key rules.
- For production multi-tenant standalone setups, consider running separate server instances per tenant with different tokens and fixed configured principals, rather than trusting a single token with header-based principal resolution.

## Shared knowledge layer

The shared namespace provides cross-tenant knowledge sharing. All tenants can read from it during recall, but only authorized principals can write to it.

### Setup

1. Define a `shared` namespace in `namespacePolicies` with `"read": ["*"]` so all tenants can read:

```json
{
  "namespacePolicies": {
    "shared": { "read": ["*"], "write": ["admin"] }
  }
}
```

2. Include `"shared"` in `defaultRecallNamespaces` so it is automatically included in recall for all tenants:

```json
{
  "defaultRecallNamespaces": ["shared"]
}
```

3. Optionally enable auto-promotion to copy extracted memories to the shared namespace:

```json
{
  "autoPromoteToSharedEnabled": true,
  "autoPromoteMinConfidenceTier": "implied",
  "autoPromoteToSharedCategories": ["fact", "correction", "decision", "preference"]
}
```

### Writing to the shared namespace

Use the `memory_promote` tool to manually promote a memory, or use `memory_store` with `namespace: "shared"` when the authenticated principal has write access. In standalone mode, that means `server.principal` (or your session-key routing rules) must resolve to a writer for the `shared` namespace:

```bash
curl -X POST http://localhost:4318/engram/v1/memories \
  -H "Authorization: Bearer $REMNIC_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Company-wide coding standard: all APIs must return JSON.",
    "category": "decision",
    "namespace": "shared"
  }'
```

### Use cases

- **Shared coding standards** — Decisions and rules that all agents should follow.
- **Cross-project context** — Facts about shared infrastructure, team members, or organizational structure.
- **Curated knowledge** — Manually promoted memories that are useful across tenants.
