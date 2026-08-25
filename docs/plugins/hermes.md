# Hermes Agent Plugin

Remnic MemoryProvider for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Provides automatic memory recall on every LLM turn and automatic observation of every response via the Hermes MemoryProvider protocol. The deepest available integration — memory is structural, not optional.

Hermes integration follows the same boundary as every other host: Remnic core owns memory semantics, while the Hermes package stays a thin adapter over Hermes' real plugin and MemoryProvider contracts.

Canonical upstream references:

- Hermes repository: <https://github.com/NousResearch/hermes-agent>
- Hermes docs/site: <https://hermes-agent.nousresearch.com>

## Contents

- [Which Hermes plugin slot Remnic uses](#which-hermes-plugin-slot-remnic-uses)
- [Why MemoryProvider](#why-memoryprovider)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [How Hermes discovers the provider](#how-hermes-discovers-the-provider)
- [Configuration reference](#configuration-reference)
- [Optional Hermes-managed LLM bridge](#optional-hermes-managed-llm-bridge)
- [Policy-bound LLM bridge (opt-in)](#policy-bound-llm-bridge-opt-in)
- [Environment variable overrides](#environment-variable-overrides)
- [Token bootstrap](#token-bootstrap)
- [How the provider works](#how-the-provider-works)
- [Lifecycle parity audit](#lifecycle-parity-audit)
- [Tools registered](#tools-registered)
- [Profile and session isolation](#profile-and-session-isolation)
- [Error handling philosophy](#error-handling-philosophy)
- [Engram compat window](#engram-compat-window)
- [Troubleshooting](#troubleshooting)
- [Migration notes (Engram era)](#migration-notes-engram-era)
- [Uninstall](#uninstall)

---

## Which Hermes plugin slot Remnic uses

Remnic registers as a Hermes **memory provider** (`plugin.yaml` declares `kind: exclusive`, the Hermes manifest kind used for provider plugins selected through `memory.provider`). This is the only slot Remnic occupies and the only slot it needs.

The manifest declares Hermes-supported capability metadata with `provides_tools` and `provides_hooks`. It does not declare or register a context engine.

**Remnic does not, and should not, register as a Hermes `context_engine`.** Hermes' `context_engine` slot replaces the built-in `ContextCompressor` — it controls how Hermes compresses *its own outgoing conversation history* before sending to the LLM. That is a different concern from external memory recall. Remnic delivers all of the following through the MemoryProvider protocol (`prefetch()` → recall envelope), with no `context_engine` registration involved:

- Recalled memories from the Remnic store
- Lossless Context Management (LCM) compressed-history sections, when the Remnic daemon has `lcmEnabled: true`
- Entity context, identity anchors, continuity loops, and any other recall-side enrichment served by the daemon

If a static analysis tool, AI reviewer, or third-party guide tells you "Remnic needs `register_context_engine` in Hermes to enable LCM," that guidance is incorrect. LCM lives on the Remnic daemon. It is delivered to Hermes via the recall response. The `memory_provider` hook is the correct and sufficient integration point.

A Remnic-backed `ContextEngine` (one that uses Remnic's LCM to compress Hermes' *local* history) is a possible future additive feature. It is not required for any of the capabilities Remnic exposes today.

---

## Why MemoryProvider

MCP gives Hermes tools it can call, but the agent must decide to call them. The MemoryProvider protocol hooks into Hermes at the framework level so memory operations happen regardless of what the agent chooses to do.

| Aspect | MCP Only | MemoryProvider |
|--------|----------|---------------|
| Recall | Agent must call `remnic_recall` | Automatic on every turn |
| Observe | Agent must call `remnic_store` | Automatic after every response |
| Latency | Tool call overhead per turn | Pre-fetched, non-blocking |
| Reliability | Agent may omit the call | Structural — cannot be skipped |

The plugin also registers the `remnic_*` tools for cases where the agent should control recall or storage explicitly — for example, pinning a specific fact mid-session. The two approaches are complementary.

---

## Prerequisites

- **Remnic daemon** running on `127.0.0.1:4318` (configurable). See the [Remnic repository](https://github.com/joshuaswarren/remnic) for installation.
- **Hermes Agent v0.7.0 or later** — the MemoryProvider protocol was introduced in v0.7.0.
- **Python 3.10 or later**.

---

## Installation

### Option A: pip + CLI (recommended)

```bash
pip install --upgrade remnic-hermes
remnic connectors install hermes
```

`remnic connectors install hermes` generates an auth token, writes `~/.remnic/tokens.json`, adds the `remnic:` block to your Hermes `config.yaml`, materializes the plugin discovery shim at `$HERMES_HOME/plugins/remnic/__init__.py` (so Hermes finds the provider — see [How Hermes discovers the provider](#how-hermes-discovers-the-provider)), and runs a daemon health check. It does **not** start the daemon — if unreachable, it prints `remnic daemon start` as the next step. You still need to set `memory.provider: remnic` (and `memory_enabled: true`) in your Hermes `config.yaml` to activate the provider. Restart Hermes after running it.

### Option B: pip only (manual config)

```bash
pip install --upgrade remnic-hermes
```

Then add the config block manually and create the memory-provider shim — see [Configuration reference](#configuration-reference) and [How Hermes discovers the provider](#how-hermes-discovers-the-provider).

### Option C: editable install from source

```bash
cd packages/plugin-hermes
pip install -e ".[dev]"
```

### How Hermes discovers the provider

Hermes memory providers are discovered by directory scan, not by pip metadata. Upstream (`plugins/memory/__init__.py`, verified against `NousResearch/hermes-agent` commit `53adb3f`, 2026-07-16) scans:

1. Bundled providers: `<hermes-repo>/plugins/memory/<name>/`
2. User-installed providers: `$HERMES_HOME/plugins/<name>/` — when `HERMES_HOME` is unset, Hermes falls back to its platform-native default home: `~/.hermes/plugins/<name>/` on Linux/macOS, `%LOCALAPPDATA%\hermes\plugins\<name>\` on Windows (`hermes_constants.py:_get_platform_default_hermes_home`). `remnic connectors install hermes` resolves the same home for the shim and the `remnic:` config block.

A pip install of `remnic-hermes` into site-packages is **not** scanned, so the package alone does not register with Hermes. `remnic connectors install hermes` materializes the required shim for you; for pip-only installs, create a small shim directory whose `__init__.py` bridges to the pip package:

```python
# $HERMES_HOME/plugins/remnic/__init__.py
"""Remnic memory provider shim. Calls collector.register_memory_provider()."""

from remnic_hermes import register  # register() handles config loading itself
```

Hermes' discovery heuristic requires the literal text `register_memory_provider` or `MemoryProvider` to appear in the shim's `__init__.py` source (cheap text scan before import), which the docstring above satisfies. Hermes calls the module's `register(collector)`; the collector exposes `register_memory_provider()` but carries **no** `.config` attribute, so `remnic_hermes.register()` falls back to reading the Hermes host config via `hermes_cli.config.load_config_readonly()` (with a `load_config()` fallback on older Hermes releases; added in `remnic-hermes` 1.0.5, issue #1929).

Then select the provider in `config.yaml`:

```yaml
memory:
  provider: remnic
  memory_enabled: true
```

Only one memory provider can be active at a time (`kind: exclusive`).

---

## Configuration reference

The plugin entry point is `register(ctx)` in `remnic_hermes/__init__.py`. It reads configuration from `ctx.config["remnic"]`, falling back to `ctx.config["engram"]` if the `remnic` key is absent. When the context carries no `config` attribute at all (Hermes' memory-provider discovery collector), the Hermes host config is loaded directly via `hermes_cli.config.load_config_readonly()`. The extracted dict is passed to `RemnicMemoryProvider`.

In Hermes `config.yaml`, the config block sits at the **top level** under a `remnic:` key (or `engram:` for legacy configs), alongside the `memory:` block that selects the provider:

```yaml
memory:
  provider: remnic        # must match the shim directory name under $HERMES_HOME/plugins/
  memory_enabled: true

remnic:
  host: "127.0.0.1"
  port: 4318
  allow_insecure_http: false
  token: ""
  client_id: ""
  session_key: ""
  timeout: 30.0
  prefetch_wait_timeout: 2.0
  # Optional loopback LLM bridge — off unless llm_bridge.enabled is true.
  # llm_bridge:
  #   enabled: true
  #   host: "127.0.0.1"
  #   port: 8765          # 0 = pick a free ephemeral port (a fixed port is REQUIRED when client_config_path is set)
  #   max_body_bytes: 524288
  #   timeout_seconds: 120.0
  #   client_config_path: ""   # set to write the 0600 client JSON (includes a loopback bearer)
```

### Field reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | string | `"127.0.0.1"` | Hostname or IP of the Remnic daemon. Overridden by `REMNIC_HOST` env var. |
| `port` | integer | `4318` | TCP port of the Remnic daemon. Overridden by `REMNIC_PORT` env var. |
| `allow_insecure_http` | boolean | `false` | Use HTTP for a non-loopback host. Loopback hosts always use HTTP. Other hosts use HTTPS unless this explicit compatibility option is `true`. |
| `token` | string | `""` | Auth token for the daemon. If empty, auto-loaded from the token store (see [Token bootstrap](#token-bootstrap)). |
| `client_id` | string | `""` | Printable ASCII daemon namespace selector with at most 256 characters and no edge spaces. The client sends a configured value as `X-Engram-Client-Id`, `X-Engram-Namespace`, and the REST `namespace` field. If empty, `namespace` is used. If both are empty, the request uses the daemon default while the legacy client identifier remains `"hermes"`. Added in 1.0.6 (issue #2310). |
| `session_key` | string | `""` | Printable ASCII session identifier without edge spaces. Config input is trimmed. The client passes it on every recall/observe call. If empty, the plugin generates `hermes-<12 random hex chars>` at startup. |
| `timeout` | float | `30.0` | HTTP request timeout in seconds applied to all daemon calls. |
| `prefetch_wait_timeout` | float | `2.0` | Maximum seconds `prefetch()` blocks the turn waiting for a first-fetch recall (always additionally capped by `timeout`). Set `0` for pure fire-and-forget: prefetch only ever returns cached results and never waits. Invalid values (negative, non-numeric, NaN/inf) are rejected at load. Added in 1.0.5 (issue #1929). |

The nested `llm_bridge` block is documented in [Policy-bound LLM bridge (opt-in)](#policy-bound-llm-bridge-opt-in). It is the only nested config section; every other field is flat. Unknown `llm_bridge` keys — including any attempt to set a `model` or `provider` — are rejected at load, because the bridge's model policy is server-owned.

`namespace` is accepted as an alias for `client_id`. A non-empty `client_id` takes precedence when both fields are set.

Remote HTTP users must set `allow_insecure_http: true` before upgrading. Remove this option after the daemon serves HTTPS.

No other fields are read. Fields documented elsewhere, such as `recall_top_k`, `recall_mode`, or `token_env`, do not exist in this implementation.

---

## Optional Hermes-managed LLM bridge

`remnic-hermes` can expose a Hermes-resolved provider to Remnic through a small **loopback-only** OpenAI-compatible bridge. This is opt-in and intended for deferred extraction, consolidation, and summary jobs — not recall-critical work with a short latency budget.

The bridge policy never stores a provider API key or OAuth token. The supervisor passes provider environment variables to the bridge process only for Hermes resolution and does not forward them to the Remnic daemon. It generates a separate, launch-scoped **bridge request token** for the bridge and Remnic daemon children; that token is used solely in their local HTTP Authorization header. The daemon child receives basic runtime variables plus supported `REMNIC_*`/`ENGRAM_*` daemon settings, except the bridge readiness secret. Hermes remains the sole resolver and owner of provider credentials.

### Policy

Create a local policy file, for example `~/.remnic/hermes-llm-bridge/policy.json`:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.6-terra",
  "timeout_seconds": 90
}
```

These are the only accepted policy keys. The bridge rejects policy files containing credential-bearing or unrecognized fields, exposes only the policy model from `GET /v1/models`, ignores a client-supplied model selector, requires the launch-scoped bearer token on all provider-facing endpoints, and binds only `127.0.0.1`.

### Remnic daemon configuration

In the **Remnic daemon configuration** (not the `remnic:` block in Hermes' `config.yaml`), route deferred local-LLM work to the bridge and leave direct-provider fallback disabled:

```json
{
  "remnic": {
    "localLlmEnabled": true,
    "localLlmUrl": "http://127.0.0.1:4329/v1",
    "localLlmModel": "gpt-5.6-terra",
    "localLlmApiKeyEnv": "REMNIC_HERMES_BRIDGE_TOKEN",
    "localLlmAuthHeader": true,
    "localLlmFallback": false,
    "openaiApiKey": false,
    "rerankEnabled": false,
    "recallPlannerLlmEnabled": false
  }
}
```

The explicit `openaiApiKey: false` disables Remnic's fallback inheritance of `OPENAI_API_KEY`; it is required even on hosts that currently have no direct provider key. Keep `rerankEnabled` and `recallPlannerLlmEnabled` off unless the chosen provider has been measured against their synchronous recall budget. Their deterministic/QMD retrieval path remains independent of this bridge.

### Lifecycle

Run the supervisor with the Python executable that has both Hermes and `remnic-hermes` installed:

```bash
remnic-hermes-supervisor \
  --python /absolute/path/to/hermes-python \
  --policy "$HOME/.remnic/hermes-llm-bridge/policy.json" \
  --remnic-bin "$(command -v remnic-server)"
```

The supervisor starts the bridge first, generates the bridge request token, requires a separate per-launch cryptographic readiness proof from that exact bridge instance, then starts the daemon with a restricted child environment containing runtime basics, supported `REMNIC_*`/`ENGRAM_*` daemon settings, and the request token. Provider environment variables are passed only to the bridge for Hermes resolution and are not forwarded to the Remnic daemon. The readiness secret is delivered to the bridge through a dedicated launch-scoped environment variable, never process arguments or the daemon environment. A different process that already owns the port cannot satisfy the readiness check, and a local process without the request token cannot use the provider-facing endpoints. An unexpected exit from either child stops its peer and makes the supervisor fail. Do not run the daemon outside this supervisor when using the `${REMNIC_HERMES_BRIDGE_TOKEN}` configuration above. On `SIGTERM` or `SIGINT`, it forwards the received signal to both children before final cleanup.

---

## Environment variable overrides

Environment variables are consulted only when the corresponding field is absent from the config block. Inline config values win.

| Variable | Overrides | Notes |
|----------|-----------|-------|
| `REMNIC_HOST` | `remnic.host` | Primary |
| `REMNIC_PORT` | `remnic.port` | Primary |
| `ENGRAM_HOST` | `remnic.host` | Legacy fallback; checked when `REMNIC_HOST` is unset |
| `ENGRAM_PORT` | `remnic.port` | Legacy fallback; checked when `REMNIC_PORT` is unset |

**Precedence (highest to lowest):** inline config field → `REMNIC_*` env var → `ENGRAM_*` env var → compiled default.

The auth token is **not** read from an environment variable. It comes from the inline `token:` field or the token store file.

---

## Policy-bound LLM bridge (opt-in)

Hermes deployments that authenticate through host-managed providers (OAuth
profiles, portal subscriptions) can let a local Remnic daemon use those
provider policies for **optional background generation** without copying any
provider credential into Remnic configuration.

When enabled, the plugin starts a tiny HTTP server inside the Hermes process
that exposes exactly one OpenAI-compatible endpoint on loopback:

```text
POST /v1/chat/completions   # chat completions (non-streaming)
GET  /healthz               # supervision health check
```

Completion is delegated to Hermes' installed `PluginLlm` runtime
(`agent.plugin_llm.PluginLlm`, the host facade over
`agent.auxiliary_client.call_llm`). Memory-provider discovery uses a
collector that can register providers but does not carry that facade;
the plugin resolves `PluginLlm` from the live Hermes runtime and defers
listener start until it is importable. The host keeps owning provider
routing, auth resolution, timeouts, and fallback; the plugin never sees
a raw API key or OAuth token.

### Security properties

- **Loopback-only listener.** The bind host is validated with the same
  classifier the daemon client uses. IPv4 and IPv6 loopback literals and
  `localhost` are accepted; wildcard (`0.0.0.0`, `::`) and non-loopback
  binds are rejected before any socket is created.
- **Server-owned model policy.** A request's `model`, `provider`, or any
  other routing field is discarded at the door: the delegate receives only
  the message list, and the response reports the model the host actually
  used. There is no `model`/`provider` key in `llm_bridge` config either —
  setting one fails registration loudly instead of being honored.
- **Generated loopback bearer.** The optional `client_config_path` output
  describes the endpoint, limits, and a generated random token. It is
  written with `0600` permissions. It never copies a host provider
  credential. Every request, including `/healthz`, is checked with a
  constant-time compare. Local callers without the bearer are denied.
  The token is never logged. Generating the file requires a fixed
  `port` (an ephemeral port would move the endpoint on every restart),
  and the bearer is reused across restarts, so a daemon that read the
  file once keeps working across Hermes restarts.
- **Bounded and quiet.** Bodies above `max_body_bytes` get `413`;
  queue wait and delegate work share one `timeout_seconds` deadline.
  A depleted queue budget starts no delegate. Handler threads are
  capped at accept time, before authentication, so an unauthenticated
  loopback flood cannot exhaust the process. Request bodies are never
  logged, and error responses are fixed strings — no exception text, no
  echoes.

### Daemon configuration

Point the Remnic daemon at the generated client JSON by setting
`llmBridgeClientConfigPath` to the same path as Hermes
`remnic.llm_bridge.client_config_path`. `parseConfig` reads `endpoint`
and `token` into `backgroundGeneration` only. Extraction, day summary,
dependency revalidation, and embeddings keep using `openaiBaseUrl` and
are unchanged. Hourly summarizer is the background-generation consumer, including structured extended hourly summaries.

```json
{
  "llmBridgeClientConfigPath": "/path/to/llm-bridge-client.json"
}
```

Equivalent explicit fields:

```json
{
  "backgroundGeneration": {
    "endpoint": "http://127.0.0.1:8765/v1/chat/completions",
    "token": "<generated-loopback-bearer>",
    "timeoutSeconds": 120
  }
}
```

Do not assign the bridge to `openaiBaseUrl`. That shared base URL is
used for `/v1/responses` and `/v1/embeddings`, which this listener does
not serve. The `model` value a client sends is ignored by the bridge —
it exists only to satisfy OpenAI-shaped callers.

### Supervision

The bridge runs on daemon threads inside the Hermes process and lives and
dies with it — there is no separate service to supervise. Supervisors should
watch the Hermes process itself and may probe `GET /healthz` with the
generated bearer from the client file. The bridge is **fail-open**: invalid
config, a missing Hermes `PluginLlm` runtime, or a failed bind logs a
warning and leaves plugin registration, recall, and observation fully
working.

### Background-only: never on the recall path

Memory recall and observation always go directly from the provider to the
Remnic daemon and never route through the bridge. The bridge exists solely
for optional background generation (for example, daemon-side summaries). If
the bridge is down, disabled, or slow, recall quality and turn latency are
unaffected.

---

## Token bootstrap

### Automatic (via CLI)

`remnic connectors install hermes` handles the full flow:

1. Validates the Hermes profile and config directory.
2. Generates a per-connector auth token scoped to Hermes.
3. Adds the `remnic:` block to Hermes `config.yaml` (with rollback on failure).
4. Commits the token to `~/.remnic/tokens.json`.
5. Writes the connector config to `~/.config/engram/.engram-connectors/connectors/hermes.json`.
6. Materializes the plugin discovery shim at `$HERMES_HOME/plugins/remnic/__init__.py` (honors `HERMES_HOME`, else `~/.hermes`) so Hermes can discover the provider. Best-effort: if the shim cannot be written, install still succeeds and prints a manual-creation hint. A user-authored shim already at that path is left untouched.
7. Runs a daemon health check — reports whether the daemon is reachable but does **not** start it. If unreachable, install still succeeds and prints `remnic daemon start` as the next step.

Activation is a separate, non-destructive step the installer never performs for you: set `memory.provider: remnic` (and `memory_enabled: true`) in your Hermes `config.yaml`.

To install into a non-default Hermes profile:

    remnic connectors install hermes --config profile=Research

### Manual

Write `~/.remnic/tokens.json` in the following format:

```json
{
  "tokens": [
    { "connector": "hermes", "token": "remnic_hm_...", "createdAt": "2026-01-01T00:00:00Z" }
  ]
}
```

The token loader searches for `connector: "hermes"` first, then `connector: "openclaw"`. It also checks `~/.engram/tokens.json` as a legacy fallback.

### Token resolution order

1. Inline `token:` field in `config.yaml`.
2. `connector: "hermes"` entry in `~/.remnic/tokens.json`.
3. `connector: "openclaw"` entry in `~/.remnic/tokens.json`.
4. `connector: "hermes"` entry in `~/.engram/tokens.json` (legacy fallback).
5. `connector: "openclaw"` entry in `~/.engram/tokens.json` (legacy fallback).
6. Empty string — daemon calls will return 401 until a token is configured.

---

## How the provider works

### `initialize`

Called when the plugin loads. Creates an `httpx.AsyncClient` for the daemon and issues a `GET /health` request. Loopback hosts use HTTP. Remote hosts use HTTPS unless `allow_insecure_http` is `true`. A failed health check is non-fatal because the daemon can become available later. If the client is not initialized, later hook methods return without errors.

Note: the HTTP base path currently uses `/engram/v1` because the Remnic daemon exposes a legacy surface during the v1.x compat window. This will change to `/remnic/v1` once the daemon ships the dual-path rollout.

### `prefetch` / `queue_prefetch` — the Hermes injection path

**This is how memory reaches the model in Hermes.** Verified against upstream `NousResearch/hermes-agent` commit `53adb3f` (2026-07-16): `agent/turn_context.py` calls `MemoryManager.prefetch_all()` → `provider.prefetch(query, session_id=...)` **synchronously** on the turn hot path, and the returned text is injected into the current turn's user message. Hermes imposes no timeout of its own on `prefetch()`, so the provider is responsible for bounding its own latency. After each completed turn, Hermes calls `queue_prefetch()` and `sync_turn()` on a background executor.

`prefetch()` behavior:

1. **Skips recall entirely** if the query is absent or fewer than 3 words (whitespace-split). This avoids triggering recall on very short acknowledgments like "ok" or "thanks".
2. Serves from a per-session in-memory cache (60s TTL, invalidated by `sync_turn` and session switches) when possible.
3. On a cache miss, starts `POST /recall` (query, `sessionKey`, `topK: 8`) on a background event loop and waits up to `prefetch_wait_timeout` seconds (default 2.0, capped by `timeout`) for the result. If the recall is still in flight when the wait expires, `prefetch()` returns `""` for this turn and the completed result populates the cache for the next turn.
4. A non-empty `context` in the daemon response is wrapped in a `<remnic-memory count="N">` block. **`count` may be `0` with a populated `context`** — the daemon returns profile and knowledge-index sections even when no specific memory IDs matched the query. The block is injected either way; only an empty `context` yields `""` (fixed in 1.0.5, issue #1929).
5. Exceptions are swallowed (logged at DEBUG on the `remnic_hermes.provider` logger); returns `""` on any error so the LLM call proceeds normally.

### `pre_llm_call`

Retained for hosts that embed the provider directly, but **Hermes never calls `pre_llm_call` on memory providers** — the `pre_llm_call` hook exists only in Hermes' general plugin system (`hermes_cli.plugins`), a separate registration path from the MemoryProvider protocol. Do not describe `pre_llm_call` as the Hermes injection path; that is `prefetch()` above. `pre_llm_call(messages)` performs the same recall as `prefetch()` (last user message as query, same 3-word gate, same `<remnic-memory>` block) without the cache/wait machinery.

### `sync_turn`

Called after every agent response. Takes the full session `transcript` and sends the **last 2 messages** (user + assistant) to `POST /observe`. This provides near-real-time observation without the cost of replaying the entire transcript on every turn.

Exceptions are swallowed.

### `extract_memories`

Called when the session ends. Receives a `session` dict; reads `session["messages"]` and sends the **full transcript** to `POST /observe`. This is the deep extraction pass — the daemon analyses the complete conversation for structured memory candidates.

Exceptions are swallowed.

### `on_session_switch`

Called by Hermes when its active session id changes without tearing down the provider. If `remnic.session_key` is explicitly configured, Remnic preserves that stable key. If `session_key` is omitted and the plugin generated an ephemeral key, Remnic updates it to the new Hermes session id so recalls and observations remain scoped to the current Hermes conversation after `/new`, `/reset`, or similar session-boundary operations.

### `shutdown`

Closes the `httpx.AsyncClient`. Safe to call when the client was never initialized.

---

## Lifecycle parity audit

Audit date: 2026-04-30. Upstream Hermes reference used: `NousResearch/hermes-agent` commit `1d8068d` (`2026-04-30T12:57:02-07:00`).

Remnic remains a Hermes memory provider plugin. In `plugin.yaml`, `kind: exclusive` marks the package as an exclusive provider selected by `memory.provider`, `provides_tools` enumerates the Remnic and legacy Engram tool surfaces, and `provides_hooks` declares the wired `on_session_reset` hook. The Hermes `context_engine` slot is still intentionally unused because it replaces Hermes' local `ContextCompressor`; it is not the right slot for recall, observation, heartbeat, dreams, or reset handling.

| OpenClaw surface | Hermes surface | Status | Remnic behavior |
|------------------|----------------|--------|-----------------|
| `agent_heartbeat` | Hermes cron scheduler (`cron/scheduler.py`) and agent/tool jobs | Equivalent but different | Remnic does not register a plugin tick hook. Hermes scheduled jobs can call Remnic maintenance tools such as `remnic_memory_summarize_hourly`, `remnic_conversation_index_update`, `remnic_dreams_run`, and `remnic_compounding_weekly_synthesize`. |
| `before_reset` | Plugin hooks `on_session_finalize` and `on_session_reset`, plus MemoryProvider `on_session_end` / `on_session_switch` | Wired for session scoping | Remnic registers an `on_session_reset` hook when Hermes exposes `ctx.register_hook`, and the provider implements `on_session_switch` so generated session keys follow the new Hermes session id. Stable configured `session_key` values are preserved. |
| `commands.list` / `registerCommand` | `ctx.register_command` for in-session slash commands and `ctx.register_cli_command` for `hermes <subcommand>` commands | Available, not wired | Remnic exposes explicit capabilities as agent tools rather than Hermes slash/CLI commands today. The command surfaces exist upstream and can be used later for operator-style commands if there is a concrete UX need. |
| `dreaming` slot | No dedicated dreaming plugin slot; Hermes uses cron/background jobs and context-engine lifecycle for compression only | Equivalent but different | Remnic keeps dream/consolidation semantics inside the daemon. Hermes can invoke them through `remnic_dreams_status` and `remnic_dreams_run`; recurring background execution should be modeled as a Hermes cron job, not as a `context_engine`. |

No upstream Hermes feature request is needed from this audit: each OpenClaw lifecycle surface has either a direct Hermes plugin hook or a supported Hermes scheduling/command equivalent. The only non-equivalent detail is naming: Hermes does not have an OpenClaw-style `dreaming` slot, but its cron/background-task model is the correct host-native way to schedule Remnic dream work.

---

## Tools registered

| Tool name | Parameters | Description |
|-----------|-----------|-------------|
| `remnic_recall` | `query: string` | Recall memories from Remnic matching a natural language query |
| `remnic_store` | `content: string` | Store a memory in Remnic for future recall |
| `remnic_search` | `query: string` | Full-text search across all Remnic memories |
| `remnic_lcm_search` | `query: string`, `sessionKey?: string`, `namespace?: string`, `limit?: integer` | Search the daemon-side LCM conversation archive |
| `remnic_recall_explain` | `sessionKey?: string`, `namespace?: string` | Return the last recall snapshot |
| `remnic_recall_tier_explain` | `sessionKey?: string`, `namespace?: string` | Return tier attribution for the last direct-answer recall |
| `remnic_recall_xray` | `query: string`, `sessionKey?: string`, `namespace?: string`, `budget?: integer`, `disclosure?: chunk|section|raw` | Run recall with X-ray attribution capture |
| `remnic_memory_last_recall` | `sessionKey?: string` | Fetch the memory IDs injected in the last recall |
| `remnic_memory_intent_debug` | `namespace?: string` | Inspect the latest intent/planner snapshot |
| `remnic_memory_qmd_debug` | `namespace?: string` | Inspect the latest QMD recall snapshot |
| `remnic_memory_graph_explain` | `namespace?: string` | Inspect graph recall expansion from the last recall |
| `remnic_memory_feedback_last_recall` | `memoryId: string`, `vote: up|down`, `note?: string` | Record relevance feedback for a recalled memory |
| `remnic_set_coding_context` | `sessionKey: string`, `codingContext?: object|null`, `projectTag?: string` | Attach coding project context to a session |
| `remnic_memory_get` | `memoryId: string`, `namespace?: string` | Fetch one stored memory by id |
| `remnic_memory_store` | `content: string`, `sessionKey?: string`, `category?: string`, `confidence?: number`, `namespace?: string`, `tags?: string[]`, `entityRef?: string`, `ttl?: string`, `sourceReason?: string` | Store a memory with the daemon's richer memory-store schema |
| `remnic_memory_timeline` | `memoryId: string`, `namespace?: string`, `limit?: number` | Fetch the timeline for one stored memory |
| `remnic_memory_profile` | `namespace?: string` | Read the user profile surface |
| `remnic_memory_entities` | `namespace?: string` | List tracked entities |
| `remnic_memory_questions` | `namespace?: string` | List open memory questions |
| `remnic_memory_identity` | `namespace?: string` | Read identity memory state |
| `remnic_memory_promote` | `memoryId: string`, `namespace?: string`, `sessionKey?: string` | Promote a memory candidate or stored memory |
| `remnic_memory_outcome` | `memoryId: string`, `outcome: success|failure`, `namespace?: string`, `sessionKey?: string`, `timestamp?: string` | Record or inspect a memory outcome |
| `remnic_entity_get` | `name: string`, `namespace?: string` | Fetch one tracked entity by name |
| `remnic_memory_capture` | `content: string`, `namespace?: string`, `category?: string`, `tags?: string[]`, `entityRef?: string`, `confidence?: number`, `ttl?: string`, `sourceReason?: string` | Capture an explicit memory note |
| `remnic_memory_action_apply` | `action: string`, `category?: string`, `content?: string`, `outcome?: applied|skipped|failed`, `reason?: string`, `memoryId?: string`, `sessionKey?: string`, `namespace?: string`, `dryRun?: boolean` | Apply a memory action |
| `remnic_continuity_audit_generate` | `period?: weekly|monthly`, `key?: string` | Generate a continuity audit report |
| `remnic_continuity_incident_open` | `symptom: string`, `namespace?: string`, `triggerWindow?: string`, `suspectedCause?: string` | Open a continuity incident |
| `remnic_continuity_incident_close` | `id: string`, `fixApplied: string`, `verificationResult: string`, `namespace?: string`, `preventiveRule?: string` | Close a continuity incident with verification |
| `remnic_continuity_incident_list` | `state?: open|closed|all`, `namespace?: string`, `limit?: number` | List continuity incidents by state |
| `remnic_continuity_loop_add_or_update` | `id: string`, `cadence: string`, `purpose: string`, `status: string`, `killCondition: string` | Add or update a continuity improvement loop |
| `remnic_continuity_loop_review` | `id: string`, `namespace?: string`, `status?: string`, `notes?: string`, `reviewedAt?: string` | Review an existing continuity improvement loop |
| `remnic_identity_anchor_get` | `namespace?: string` | Read the identity continuity anchor |
| `remnic_identity_anchor_update` | `namespace?: string`, `identityTraits?: string`, `communicationPreferences?: string`, `operatingPrinciples?: string`, `continuityNotes?: string` | Conservatively merge identity anchor sections |
| `remnic_review_queue_list` | `runId?: string`, `namespace?: string` | Fetch the latest review queue artifact bundle |
| `remnic_review_list` | `filter?: string`, `namespace?: string`, `limit?: number` | List contradiction review items |
| `remnic_review_resolve` | `pairId: string`, `verb: string` | Resolve a contradiction review pair |
| `remnic_suggestion_submit` | `content: string`, `schemaVersion?: number`, `idempotencyKey?: string`, `dryRun?: boolean`, `sessionKey?: string`, `category?: string`, `confidence?: number`, `namespace?: string`, `tags?: string[]`, `entityRef?: string`, `ttl?: string`, `sourceReason?: string` | Queue a suggested memory for review |
| `remnic_work_task` | `action: string`, `id?: string`, `title?: string`, `description?: string`, `status?: string`, `priority?: string`, `owner?: string`, `assignee?: string`, `projectId?: string`, `tags?: string[]`, `dueAt?: string` | Manage work-layer tasks |
| `remnic_work_project` | `action: string`, `id?: string`, `name?: string`, `description?: string`, `status?: string`, `owner?: string`, `tags?: string[]`, `taskId?: string`, `projectId?: string` | Manage work-layer projects |
| `remnic_work_board` | `action: string`, `projectId?: string`, `snapshotJson?: string`, `linkToMemory?: boolean` | Export or import work-layer board snapshots and markdown |
| `remnic_shared_context_write_output` | `agentId: string`, `title: string`, `content: string`, `authority?: string` (`informational`\|`advisory`\|`binding`), `expiresAt?: string` (future ISO-8601, ≤10y), `supersedes?: string` | Write agent work product into shared context |
| `remnic_shared_feedback_record` | `agent: string`, `decision: string`, `reason: string` | Record shared feedback for peer modeling |
| `remnic_shared_priorities_append` | `agentId: string`, `text: string` | Append priorities notes for curator merge |
| `remnic_shared_context_cross_signals_run` | `date?: string` | Generate shared-context cross-signal artifacts |
| `remnic_shared_context_curate_daily` | `date?: string` | Generate the daily shared-context roundtable |
| `remnic_compounding_weekly_synthesize` | `weekId?: string` | Generate weekly compounding outputs |
| `remnic_compounding_promote_candidate` | `weekId: string`, `candidateId: string` | Promote a compounding candidate into durable memory |
| `remnic_compression_guidelines_optimize` | `dryRun?: boolean`, `eventLimit?: number` | Run compression-guideline policy optimization |
| `remnic_compression_guidelines_activate` | `expectedContentHash?: string`, `expectedGuidelineVersion?: number` | Activate a staged compression-guideline draft |
| `remnic_memory_governance_run` | `namespace?: string`, `mode?: shadow|apply`, `recentDays?: number`, `maxMemories?: number`, `batchSize?: number` | Run memory governance in shadow or apply mode |
| `remnic_procedure_mining_run` | `namespace?: string` | Run procedural memory mining |
| `remnic_procedural_stats` | `namespace?: string` | Read procedural memory stats |
| `remnic_contradiction_scan_run` | `namespace?: string` | Run an on-demand contradiction scan |
| `remnic_memory_summarize_hourly` | none | Generate hourly conversation summaries |
| `remnic_conversation_index_update` | `sessionKey?: string`, `hours?: number`, `embed?: boolean` | Update the conversation index |
| `remnic_day_summary` | `memories?: string`, `sessionKey?: string`, `namespace?: string` | Generate a structured end-of-day summary |
| `remnic_briefing` | `since?: string`, `focus?: string`, `namespace?: string`, `format?: markdown|json`, `maxFollowups?: number` | Generate a daily context briefing |
| `remnic_context_checkpoint` | `sessionKey: string`, `context: string`, `namespace?: string` | Save a structured context checkpoint for a session |
| `remnic_profiling_report` | `format?: ascii|json`, `limit?: number` | Generate a profiling report |

Each tool handler returns the raw JSON response from the daemon or `{"error": "Not connected to Remnic"}` when the client is not initialized. Direct memory tools use the daemon's REST endpoints where available; debug, explain, and MCP-native memory surfaces are forwarded through the daemon MCP endpoint.

The `remnic_*` tools give the agent explicit control for cases where automatic recall is insufficient — for example, storing a specific fact the agent has derived mid-session, searching the LCM archive directly, inspecting why a recall result appeared, opening a continuity incident, curating stored memories, saving a checkpoint, or generating a profiling report.

---

## Profile and session isolation

Hermes profiles live under `~/.hermes/profiles/<name>/` and each loads its own `config.yaml`. You can use different `session_key` values to keep memory contexts distinct across profiles:

```yaml
# ~/.hermes/profiles/research/config.yaml
plugins:
  - remnic_hermes

remnic:
  host: "127.0.0.1"
  port: 4318
  client_id: "shared"
  session_key: "research"
```

```yaml
# ~/.hermes/profiles/coding/config.yaml
plugins:
  - remnic_hermes

remnic:
  host: "127.0.0.1"
  port: 4318
  client_id: "shared"
  session_key: "coding"
```

The `client_id` selects the daemon namespace for every request. Both examples use `shared`, so they can recall the same memories.

The `session_key` is passed on every `/recall` and `/observe` call. Different values keep each profile's session state separate.

Set different `client_id` values to isolate profile namespaces. Set the same value when profiles should share one namespace.

---

## Error handling philosophy

Every MemoryProvider hook (`initialize`, `pre_llm_call`, `sync_turn`, `extract_memories`) wraps its daemon call in a bare `except Exception: pass` block. This is intentional: Remnic being unavailable must never break the agent. The agent continues normally; it just loses memory context for that turn or session.

This design means:
- The daemon can be restarted mid-session without crashing Hermes.
- Misconfigured tokens produce silent auth failures rather than agent crashes.
- Network blips are non-fatal.

If you need to diagnose silent failures, check daemon health directly:

```bash
remnic daemon status
curl -s http://127.0.0.1:4318/engram/v1/health
```

---

## Engram compat window

During the Engram to Remnic rebrand, the plugin registers legacy aliases for every Remnic tool:

| Tool name | Status | Notes |
|-----------|--------|-------|
| `remnic_recall` | Current | Use for new integrations |
| `remnic_store` | Current | Use for new integrations |
| `remnic_search` | Current | Use for new integrations |
| `remnic_lcm_search` | Current | Use for new integrations |
| `engram_recall` | Legacy alias | Routes to the same handler as `remnic_recall` |
| `engram_store` | Legacy alias | Routes to the same handler as `remnic_store` |
| `engram_search` | Legacy alias | Routes to the same handler as `remnic_search` |
| `engram_lcm_search` | Legacy alias | Routes to the same handler as `remnic_lcm_search` |

The legacy tool schemas deliberately describe themselves as "Engram" tools (e.g., "Recall memories from Engram..."). This is intentional: when a language model surfaces the `engram_*` names, the description must agree with the name so the model does not confuse the two tool sets. Do not update these descriptions to say "Remnic".

The Python class aliases `EngramMemoryProvider`, `EngramClient`, and `EngramHermesConfig` are preserved for import-path compatibility and will be removed in a future major release.

The `engram:` config block is also still accepted as a fallback. If your `config.yaml` has `engram:` instead of `remnic:`, everything works without changes.

---

## Troubleshooting

### "MemoryProvider remnic failed to initialize" or 401 errors

The auth token is missing or invalid. Re-run the connector install to regenerate it:

```bash
remnic connectors install hermes
cat ~/.remnic/tokens.json    # verify a hermes entry exists
```

### Daemon not running

```bash
remnic daemon status
remnic daemon install        # installs and starts the launchd/systemd service
```

Verify the HTTP surface is responding:

```bash
curl -s http://127.0.0.1:4318/engram/v1/health
```

### `ModuleNotFoundError: No module named 'remnic_hermes'`

The package is not installed in the Python environment Hermes uses:

```bash
which python && pip show remnic-hermes
hermes --version
```

Install into the correct environment: `<path-to-hermes-python> -m pip install --upgrade remnic-hermes`.

### Memories not appearing in context

1. Confirm the daemon is healthy: `remnic daemon status`.
2. Confirm the query is at least 3 words — `pre_llm_call` skips recall for shorter messages.
3. Confirm the token is valid: a 401 is swallowed silently, so daemon health does not catch it.
4. Use the explicit tool to test the round-trip: call `remnic_recall` with a query. If it returns `{"error": "Not connected to Remnic"}`, `initialize` never completed successfully.
5. Enable debug logging for the provider's critical path (added in 1.0.5): configure Python logging so the `remnic_hermes.provider` logger emits DEBUG. It reports prefetch wait expiries, background recall failures, and recalls that returned no context (with `count` and `sourcesUsed`).
6. If your daemon is slow (e.g. Docker with a bind-mounted memory dir), recall can exceed the prefetch wait. Raise `prefetch_wait_timeout` (trades turn latency for first-turn injection) — the background recall still completes and feeds the cache for the next turn either way.

### Memories from a previous session are not recalled

If `session_key` is not set, a new random key is generated each startup. Set a stable `session_key` in the config if you want cross-session recall to scope correctly:

```yaml
remnic:
  session_key: "my-agent"
```

Or leave it blank to rely on the Remnic daemon's global search (the daemon indexes all sessions, but `sessionKey` may affect ranking).

---

## Migration notes (Engram era)

If you are upgrading from a configuration that used the `engram-hermes` package or an `engram:` config block:

1. `pip install --upgrade remnic-hermes` replaces `engram-hermes`. Uninstall the old package first: `pip uninstall engram-hermes`.
2. Your `config.yaml` `engram:` block continues to work without changes. You can rename it to `remnic:` at any time — both are accepted.
3. Tool calls to `engram_recall`, `engram_store`, and `engram_search` continue to work. No Hermes system prompt or tool-list changes are required.
4. Python imports of `EngramMemoryProvider`, `EngramClient`, and `EngramHermesConfig` continue to resolve.
5. When you are ready to fully migrate: rename `engram:` to `remnic:` in `config.yaml` and update any explicit tool references to `remnic_*`.

---

## Uninstall

```bash
pip uninstall remnic-hermes
remnic connectors remove hermes
```

`remnic connectors remove hermes` revokes the token and removes the `remnic:` block from Hermes `config.yaml`.
