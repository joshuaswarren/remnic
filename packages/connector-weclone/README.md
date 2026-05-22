# @remnic/connector-weclone

Memory-aware OpenAI-compatible proxy that adds Remnic persistent memory to deployed
[WeClone](https://github.com/xming521/weclone) avatars.

WeClone fine-tunes a model to sound like you. Remnic gives it memory. Together the
avatar remembers what happened yesterday and sounds like you while doing it.

## What it does

- Runs as a local OpenAI-compatible HTTP proxy in front of a WeClone API server.
- On every `POST /v1/chat/completions`, calls Remnic `/engram/v1/recall` and injects
  retrieved memory into the system prompt before forwarding to WeClone.
- Preserves OpenAI-compatible message metadata and end-to-end request headers
  while injecting memory; only the injected system-message content is rewritten.
- After WeClone responds, calls `/engram/v1/observe` fire-and-forget so the turn is
  buffered for extraction.
- Forwards all other OpenAI-compatible endpoints (`/v1/models`, uploads, etc.)
  transparently.
- Supports single-session and per-caller (`X-Caller-Id` header or `user` field)
  isolation modes.
- Degrades gracefully: if Remnic is unreachable, the request is still forwarded to
  WeClone without memory injection.

## Install

The proxy ships as part of the Remnic monorepo and is wired into the `remnic`
CLI. The recommended install path is:

```bash
remnic connectors install weclone \
  --config wecloneApiUrl=http://localhost:8000/v1 \
  --config proxyPort=8100
```

This writes two files:

- `~/.config/engram/.engram-connectors/connectors/weclone.json` — connector
  registry entry (tracked by `remnic connectors list / remove / doctor`).
- `~/.remnic/connectors/weclone.json` — proxy config read by
  `remnic-weclone-proxy` at startup.

An auth token for the Remnic daemon is also minted automatically and stored in
the proxy config so the proxy can authenticate with the daemon.

## Run

Once installed, start the proxy:

```bash
remnic-weclone-proxy
```

Or point it at a custom config path:

```bash
remnic-weclone-proxy --config /path/to/weclone.json
```

The `REMNIC_HOME` environment variable overrides the default config location
(`~/.remnic`) — useful for tests and sandboxed deployments.

## Configure

The proxy config file accepts the following fields:

| Field | Default | Description |
| --- | --- | --- |
| `wecloneApiUrl` | `http://localhost:8000/v1` | Base URL of the WeClone API. Both path-prefixed (`/v1`, `/weclone/v1`) and bare origins are supported. |
| `wecloneModelName` | `weclone-avatar` | Optional fine-tuned model name passed through to WeClone. |
| `proxyPort` | `8100` | Local port the proxy listens on. |
| `proxyBindHost` | `127.0.0.1` | Host/interface the proxy binds to. Defaults to loopback only. |
| `allowPublicBind` | `false` | Must be `true` to bind `proxyBindHost` to `0.0.0.0` or `::`. |
| `remnicDaemonUrl` | `http://localhost:4318` | URL of the Remnic daemon exposing `/engram/v1/recall` and `/engram/v1/observe`. |
| `remnicAuthToken` | — | Bearer token for the Remnic daemon. Populated by `remnic connectors install weclone`. |
| `sessionStrategy` | `single` | `single` uses one shared memory session; `caller-id` maps each caller (via `X-Caller-Id` header or `user` field) to its own namespace. |
| `memoryInjection.maxTokens` | `1500` | Approximate token budget for injected memory. |
| `memoryInjection.position` | `system-append` | `system-append` appends memory to an existing system message; `system-prepend` prepends. |
| `memoryInjection.template` | `[Memory Context]\n{memories}\n[End Memory Context]` | Template used to wrap recalled memories. `{memories}` is the sole placeholder. |

### Example config

```json
{
  "wecloneApiUrl": "http://localhost:8000/v1",
  "proxyPort": 8100,
  "proxyBindHost": "127.0.0.1",
  "remnicDaemonUrl": "http://localhost:4318",
  "remnicAuthToken": "${REMNIC_TOKEN}",
  "sessionStrategy": "caller-id",
  "memoryInjection": {
    "maxTokens": 1500,
    "position": "system-append",
    "template": "[Memory Context]\n{memories}\n[End Memory Context]"
  }
}
```

> Config examples use placeholder token strings. Never commit real bearer
> tokens to version control.

## Architecture

```
Caller (Discord bot, Telegram bot, AstrBot, LangBot, ...)
  │
  ▼
┌──────────────────────────────┐
│  remnic-weclone-proxy        │
│                              │
│  1. Intercept chat completion│
│  2. POST /engram/v1/recall   │  ──► Remnic daemon (:4318)
│  3. Inject memory into       │
│     system prompt            │
│  4. Forward to WeClone API   │  ──► WeClone model server (:8000)
│  5. Capture response         │
│  6. POST /engram/v1/observe  │  ──► Remnic daemon (:4318)
│     (fire-and-forget)        │
│  7. Return response to caller│
└──────────────────────────────┘
```

### Session identity

| `sessionStrategy` | Behavior |
| --- | --- |
| `single` | All callers share a single `weclone-default` session key. Good for a one-user avatar. |
| `caller-id` | The proxy extracts the session key from `X-Caller-Id` header, then `body.user`, then falls back to `default`. |

Callers wiring up a Discord bot should pass the Discord user ID as
`X-Caller-Id` so memory stays partitioned per user.

## Verification

- `GET /health` — returns `{ "status": "ok", "wecloneApi": "..." }` if the proxy
  is running.
- `remnic connectors doctor weclone` — verifies both config files exist.

## Security notes

- The proxy config file is written with owner-only permissions (`0o600`) because
  it embeds a Remnic bearer token.
- Hop-by-hop headers (`connection`, `keep-alive`, `proxy-authorization`, etc.)
  are stripped on forward and response paths so proxy credentials never leak
  upstream or downstream.
- Multimodal content (image parts, etc.) is preserved verbatim; only the text
  parts of the last user message are used for recall.

## License

MIT
