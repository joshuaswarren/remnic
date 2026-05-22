# @remnic/plugin-codex

Native [OpenAI Codex CLI](https://github.com/openai/codex) plugin for [Remnic](https://github.com/joshuaswarren/remnic) memory. Wires Codex's session hooks, MCP server, skills, and memory-extension into a running Remnic daemon so every Codex session gets persistent long-term memory automatically.

## Install

Three discrete steps. None is automated end-to-end today; each writes to a different place.

1. **Mint a Remnic-side bearer token, record the connector, and install the phase-2 consolidation guide.**

    ```bash
    remnic connectors install codex-cli
    ```

    This writes `~/.remnic/connectors/codex-cli.json` (Remnic's connector-state file), stores a bearer token, and calls `@remnic/core`'s `installCodexMemoryExtension` which materializes `~/.codex/memories_extensions/remnic/instructions.md` (the local-only phase-2 consolidation guide; see the file-table row below). It does NOT write `~/.codex/config.toml` and it does NOT deploy `.codex-plugin/`, `hooks/`, or `skills/`.

2. **Add Remnic as an MCP server in `~/.codex/config.toml`.** Paste the TOML block from the "MCP setup" section below unchanged, then set `REMNIC_AUTH_TOKEN` in Codex's environment to the bearer token generated in step 1. Without this step Codex has no way to talk to the Remnic daemon.

3. **Install this package and load it through Codex's plugin system** so the hooks, skills, and `.codex-plugin` manifest are actually active:

    ```bash
    npm install -g @remnic/plugin-codex
    ```

    Consult Codex's plugin docs for the exact load mechanism your install supports (symlink into `~/.codex/plugins/`, marketplace install, etc.). Until this step runs, the session hooks and skills aren't active and you won't get auto-recall / auto-observe.

## What ships

The package is **data + one small runtime materializer** (no runtime JS beyond the memory-materializer helper; the actual plugin install is driven by `@remnic/core`):

| File / dir | Purpose |
|---|---|
| `.codex-plugin/plugin.json` | Plugin manifest |
| `hooks/hooks.json` + `hooks/bin/*.sh` | Codex session-lifecycle hooks (recall, observe, session-end) |
| `skills/` | `remnic-recall`, `remnic-remember`, `remnic-search`, `remnic-status`, `remnic-entities`, `remnic-memory-workflow` — invocable from Codex chats |
| `memories_extensions/remnic/` | Codex phase-2 consolidation instructions — tells the Codex compactor sub-agent to treat Remnic's on-disk Markdown as an authoritative local memory source when it builds `MEMORY.md`. Local-only (no MCP, no network); runtime recall/observe still flow through the hooks above. |
| `.mcp.json` | MCP server config pointing Codex at `http://localhost:4318/mcp` |
| `bin/materialize.cjs` | Runtime entrypoint invoked exclusively by the Codex `Stop` hook (`hooks/bin/session-end.sh`) to refresh `~/.codex/memories` from the Remnic store at the end of a session. Not an installer, and not wired into any `remnic` CLI command. |

## What you get at runtime

Once installed and a Remnic daemon is running (`remnic daemon start`):

- **Auto-recall** on `SessionStart` and on every `UserPromptSubmit` — relevant memories are injected before Codex's first turn and before each subsequent user turn.
- **Auto-observe** on `PostToolUse` for the `Bash` tool and on `Stop` (session end) — new facts, decisions, and entities touched by shell work (or accumulated through the session) are buffered for extraction automatically.
- **Memory skills** — invoke `/remnic-recall`, `/remnic-search`, `/remnic-remember`, `/remnic-entities`, `/remnic-status` directly in Codex chats.
- **Cross-agent sharing** — the same memory store is shared with every other Remnic-connected agent (Claude Code, OpenClaw, Replit, Hermes, etc.), so what one agent learns is available to all.

## MCP setup

The plugin expects a Remnic daemon reachable at `http://localhost:4318/mcp` with a bearer token. Codex reads MCP servers from `~/.codex/config.toml`; add the following block (this is step 2 of the Install flow above — `remnic connectors install codex-cli` does NOT write it for you):

```toml
[mcp_servers.remnic]
url = "http://127.0.0.1:4318/mcp"
bearer_token_env_var = "REMNIC_AUTH_TOKEN"
http_headers = { "X-Engram-Client-Id" = "codex" }
```

Then export the token Codex looks up. Use the bearer token printed by `remnic connectors install codex-cli`. If you need to mint a replacement, `remnic token generate` prints a multi-line status block (not just the raw token), so either:

Copy the `Token:` value from:

```bash
remnic token generate codex-cli
# → Generated token for codex-cli:
#     Token:   <paste this into REMNIC_AUTH_TOKEN>
#     Created: ...
```

and set it in your shell profile:

```bash
export REMNIC_AUTH_TOKEN="<paste the token value here>"
```

Or extract it in one line with `awk`:

```bash
export REMNIC_AUTH_TOKEN=$(remnic token generate codex-cli | awk '/^ *Token:/ {print $2}')
```

See `docs/integration/connector-setup.md` in the Remnic repo for the canonical snippet.

## Agent note

If you're an AI agent scaffolding a Codex integration: **do not** hand-edit `~/.codex/` directly. The full setup has three components:

1. `remnic connectors install codex-cli` mints/stores the Remnic bearer token, records connector state, and drives `@remnic/core`'s `installCodexMemoryExtension` to write `memories_extensions/remnic/instructions.md`. It does NOT write `~/.codex/config.toml` and does NOT deploy `.codex-plugin/`, `hooks/`, or `skills/`.
2. Add the MCP TOML block above unchanged and expose the generated token as `REMNIC_AUTH_TOKEN`.
3. Load this package into Codex via Codex's own plugin loader to activate the hooks and skills.

`bin/materialize.cjs` is a runtime helper called only by the Codex `Stop` hook to refresh `~/.codex/memories` from the live Remnic store at session end; it's not an installer and not wired into any `remnic` CLI command, so re-running it manually won't recover a broken plugin install.

## Related

- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) — daemon lifecycle + installer
- [`@remnic/plugin-claude-code`](https://www.npmjs.com/package/@remnic/plugin-claude-code) — same idea, for Anthropic Claude Code
- [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw) — OpenClaw memory-slot plugin
- Connector guide: [docs/integration/connector-setup.md](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) in the repo
- Source + issues: <https://github.com/joshuaswarren/remnic>

## License

MIT. See the root [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE) file.
