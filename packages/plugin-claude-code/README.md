# @remnic/plugin-claude-code

Native [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin for [Remnic](https://github.com/joshuaswarren/remnic) memory. Wires Claude Code's session hooks, MCP server, skills, and the `memory-review` agent into a running Remnic daemon so every Claude Code session gets persistent long-term memory automatically.

## Install

Three discrete steps. None is automated for you end-to-end today; each writes to a different place.

1. **Mint a Remnic-side bearer token and record the connector.**

    ```bash
    remnic connectors install claude-code
    ```

    This writes `~/.remnic/connectors/claude-code.json` (Remnic's connector-state file) and stores a bearer token in Remnic's token store. It does NOT touch any Claude Code configuration — the Claude Code memory-extension publisher in `@remnic/core` is a stub (`isHostAvailable()` → false, `publish()` → no-op), so no hook/skill/agent files are written and no Claude MCP config is edited.

2. **Add Remnic as an MCP server in your Claude Code config.** Paste the `.mcp.json` block from the "MCP setup" section below into Claude Code's MCP config (commonly `~/.mcp.json` or `~/.claude.json`, per your Claude install), replacing `{{REMNIC_TOKEN}}` with the token minted in step 1. Without this step Claude Code has no way to talk to the Remnic daemon.

3. **Install this package and load it through Claude Code's plugin system** so the hook scripts, skills, and `memory-review` agent are actually active:

    ```bash
    npm install -g @remnic/plugin-claude-code
    ```

    Consult Claude Code's plugin docs for the exact load mechanism your install supports (plugin marketplace / symlink / etc.). Until this step runs, auto-recall and auto-observe don't fire even if step 2 is correct.

## What ships

The package is **data-only** (no JavaScript runtime) — it's a bundle of Claude Code configuration:

| File / dir | Purpose |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest |
| `hooks/hooks.json` | `SessionStart`, `PostToolUse` (Write/Edit/MultiEdit), and `UserPromptSubmit` hook wiring |
| `hooks/bin/*.sh` | Small shell scripts that call the local Remnic daemon |
| `skills/` | `remnic-recall`, `remnic-remember`, `remnic-search`, `remnic-status`, `remnic-entities`, `remnic-memory-workflow` |
| `agents/memory-review.md` | Subagent that audits + summarizes memory for long-running sessions |
| `.mcp.json` | MCP server config pointing Claude Code at `http://localhost:4318/mcp` |
| `settings.json` | Default Claude Code settings for the plugin |

## What you get at runtime

Once installed and a Remnic daemon is running (`remnic daemon start`):

- **Auto-recall** on `SessionStart` and on every `UserPromptSubmit` — relevant memories are injected into the session prompt before Claude Code's first turn and before each subsequent user turn.
- **Auto-observe** on `PostToolUse` for `Write`, `Edit`, and `MultiEdit` tools — new facts, decisions, and entities touched by file edits are buffered for extraction without the user lifting a finger.
- **Memory skills** — invoke `/remnic-recall`, `/remnic-search`, `/remnic-remember`, `/remnic-entities`, `/remnic-status` directly in Claude Code chats.
- **Cross-agent sharing** — the same memory store is shared with every other Remnic-connected agent (Codex, OpenClaw, Replit, Hermes, etc.), so what one agent learns is available to all.

## MCP setup

The plugin expects a Remnic daemon reachable at `http://localhost:4318/mcp` with a bearer token. `remnic connectors install claude-code` does NOT write this for you — the Claude Code publisher in `@remnic/core` is a stub, so no Claude MCP config is touched. You must paste the following `.mcp.json` block into Claude Code's MCP config by hand (step 2 of the Install flow above):

```json
{
  "mcpServers": {
    "remnic": {
      "type": "http",
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer {{REMNIC_TOKEN}}",
        "X-Engram-Client-Id": "claude-code"
      }
    }
  }
}
```

Replace `{{REMNIC_TOKEN}}` with a token minted via `remnic token generate <connector-id>`.

### Hook credentials

The hook runner resolves its own bearer token independently of the MCP block
above, in this order:

1. `~/.remnic/tokens.json`, then legacy `~/.engram/tokens.json` — the
   `claude-code` connector entry first, then `openclaw`.
2. `OPENCLAW_REMNIC_ACCESS_TOKEN`, then `REMNIC_AUTH_TOKEN`.
3. Legacy aliases: `OPENCLAW_ENGRAM_ACCESS_TOKEN`, then `ENGRAM_AUTH_TOKEN`.

Current names outrank legacy ones, so a leftover pre-rename value cannot
shadow the credential the daemon is actually running with. `REMNIC_AUTH_TOKEN`
covers the standalone-server setup, which authenticates the daemon with that
variable and never mints a connector token. Against an auth-gated daemon the
hook needs one of these: every route, including `/engram/v1/health`, returns
401 without a bearer, so an unauthenticated hook reports `daemon not running`
and silently skips auto-recall and auto-observe.

### Namespace targeting

`REMNIC_NAMESPACE`, then legacy `ENGRAM_NAMESPACE` — optional. When set, the
hook adds the namespace to the **request body** of recall and observe (the
REST surface reads it from the body, not a header). An explicit
`body.namespace` already on the request wins. Unset → the daemon resolves the
namespace for the `claude-code` client id, which on a namespaced daemon is the
adapter's own empty namespace, so recall returns nothing.

## Agent note

If you're an AI agent scaffolding a Claude Code integration: **do not** hand-edit hook scripts in a user's `~/.claude/` tree. The full setup has two components:

1. `remnic connectors install claude-code` mints the MCP token and writes Remnic-side connector config. This does NOT deploy hooks/skills/agents — Claude Code doesn't yet expose a file-based extension directory, so the corresponding publisher in `@remnic/core` is a stub.
2. Install this npm package and load it through Claude Code's plugin system so the hook/skill/agent tree is picked up. Until both steps run, auto-recall and auto-observe will not fire even though `remnic connectors doctor claude-code` reports green.

The plugin is intentionally data-only so Claude Code's plugin loader can manage upgrades atomically.

## Related

- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) — daemon lifecycle + installer
- [`@remnic/plugin-codex`](https://www.npmjs.com/package/@remnic/plugin-codex) — same idea, for OpenAI Codex CLI
- [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw) — OpenClaw memory-slot plugin
- Connector guide: [docs/integration/connector-setup.md](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) in the repo
- Source + issues: <https://github.com/joshuaswarren/remnic>

## License

MIT. See the root [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE) file.
