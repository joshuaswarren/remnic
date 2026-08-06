# Claude Code Plugin

The Claude Code integration ships as `@remnic/plugin-claude-code`. The package README is the single source of truth for what it does and how to install it:

- [`packages/plugin-claude-code/README.md`](https://github.com/joshuaswarren/remnic/blob/main/packages/plugin-claude-code/README.md)

What the package README covers, in order:

1. The three discrete manual install steps (none is automated end-to-end today).
2. What ships in the package (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/bin/*.sh`, `skills/`, `agents/memory-review.md`, `.mcp.json`, `settings.json`).
3. The runtime behavior you get once both a Remnic daemon and the plugin are loaded.
4. The `.mcp.json` block you must paste into Claude Code's MCP config yourself.
5. The agent note explaining why hook/skill/agent files are not auto-published.

## Install from the Claude Code marketplace

The repo ships a Claude Code marketplace manifest (`.claude-plugin/marketplace.json`), so the plugin can be installed with two commands instead of the manual `npm install -g` + plugin-loader step:

```bash
claude plugin marketplace add https://github.com/joshuaswarren/remnic.git
claude plugin install remnic@remnic
# in an already-open Claude Code session, activate it without restarting:
/reload-plugins
```

The explicit HTTPS URL avoids the SSH-clone default that the bare `owner/repo` shorthand triggers for users without GitHub SSH keys set up (the marketplace would fail to clone before `claude plugin install` runs). If you previously added the marketplace under the SSH form, remove it (`claude plugin marketplace remove remnic`) and re-add with the HTTPS form.

This loads the hooks, skills, and the `memory-review` agent through Claude Code's own plugin system. `claude plugin install` registers the plugin but does not activate it inside a session that is already open — run `/reload-plugins` (or start a new session) so the SessionStart / UserPromptSubmit / PostToolUse hooks are live before you rely on auto-recall / auto-observe. The hooks resolve the daemon bearer token from the Remnic token store (`~/.remnic/tokens.json`) or the `REMNIC_AUTH_TOKEN` / `OPENCLAW_REMNIC_ACCESS_TOKEN` env vars, so auto-recall / auto-observe work against a local daemon out of the box.

The marketplace install does **not** register a working MCP server. Claude Code auto-discovers the plugin's bundled `.mcp.json` on install, but the bundled file is a deliberately inert placeholder — server key `remnic-placeholder`, URL `http://127.0.0.1:0/mcp` (port 0 is invalid, so the connection fails closed at startup) — so it never registers as a real `remnic` server bound to a placeholder token that quietly 401s. Before the MCP tools work, register the real `remnic` server yourself:

- **Register the real one with `claude mcp add`:** `claude mcp add remnic --transport http http://localhost:4318/mcp --header "Authorization: Bearer <token>" --header "X-Engram-Client-Id: claude-code"`. The token comes from `remnic token generate claude-code` (the `<connector-id>` argument is required; run `remnic connectors install claude-code` first if that connector has not been registered). For a remote daemon, swap the URL — see the HTTPS note below.
- *(Editing the bundled `.mcp.json` to fill the placeholder is **not** a supported fix: reinstalling the plugin overwrites the edit, and the bundled server key is `remnic-placeholder` on purpose so it is obvious that the bundled server is not a usable `remnic` registration.)*

The manual / npm path is unchanged: the package README's `.mcp.json` block still uses the canonical `remnic` key + `http://localhost:4318/mcp` URL because the manual paste replaces the placeholder deliberately. The marketplace install cannot tell whether the user has decided yet, so it ships `remnic-placeholder` instead and leaves the real `remnic` server unregistered on purpose — the user picks the URL and the token via `claude mcp add`. (A cleaner long-term fix — registering the MCP server via Claude Code plugin `userConfig` and `lifecycle` hooks instead of asking the user to `claude mcp add` it — is tracked as #2314.)

> **Security — use HTTPS for a remote daemon.** The MCP config sends `Authorization: Bearer <your token>` to whatever `url` you set. Plain `http://` is acceptable **only** for loopback endpoints (`http://localhost:4318/mcp`, `http://127.0.0.1:…`). For any non-loopback / remote daemon the URL **must** be `https://` so the bearer token is never transmitted in cleartext. (If you reach a remote daemon over an already-encrypted overlay such as a VPN/WireGuard tunnel, terminate TLS or keep the daemon bound to loopback on the far side rather than exposing plain HTTP.)

## Reality vs. older docs

Earlier versions of this page claimed `remnic connectors install claude-code` "installs the plugin / configures MCP / runs a health check." That is no longer true:

- The Claude Code memory-extension publisher in `@remnic/core` (`packages/remnic-core/src/memory-extension/claude-code-publisher.ts`) is an intentional all-no-op stub: `isHostAvailable()` returns `false`, `publish()` writes nothing, and all `PublisherCapabilities` flags are `false`.
- `remnic connectors install claude-code` only writes Remnic-side connector state and mints a bearer token. It does **not** touch Claude Code's plugin tree or MCP config.
- Claude Code has no file-based memory extension directory, so there is nothing for the publisher to write to today.

Follow the package README. The legacy `docs/guides/claude-code-integration.md` and the `scripts/hooks/claude-code/` + `scripts/hooks/codex/` engram-branded hook trees were deleted in #1527 PR1 (this change) because they described a flow that no longer exists; do not recreate them.


## Troubleshooting

The `remnic connectors install claude-code` step only writes Remnic-side state; the plugin still has to be loaded, and the MCP credential still has to be supplied. How those two happen depends on the install path:

- **Marketplace path** (see "Install from the Claude Code marketplace" above): `claude plugin install remnic@remnic` loads the plugin, and Claude Code auto-discovers the plugin's bundled `.mcp.json`. The bundled server is `remnic-placeholder` pointing at `http://127.0.0.1:0/mcp`, so it fails to connect — it is intentionally not a working `remnic` server. Run `claude mcp add remnic --transport http http://localhost:4318/mcp --header "Authorization: Bearer <token>" --header "X-Engram-Client-Id: claude-code"` to register the real one (token from `remnic token generate claude-code`).
- **Manual / npm path** (package README): you `npm install -g @remnic/plugin-claude-code`, load it through Claude Code's plugin loader, **and** paste the README's `.mcp.json` block into your MCP config by hand with the bearer token.

Either way the three things to verify are: Remnic-side token + connector state, the MCP config (token present, URL correct), and that the plugin is actually loaded. The package README's `Troubleshooting` section lists the specific failure modes for each step.

If `remnic connectors doctor claude-code` reports green but auto-recall/auto-observe do not fire in a Claude Code session, the most common cause is step 3 (plugin load) being skipped — the Remnic-side state is fine, but Claude Code has no hook/skill/agent tree to invoke until the plugin is loaded through Claude Code's own loader.
## Related

- [`@remnic/plugin-codex`](../plugins/codex.md) — same pattern for OpenAI Codex CLI
- [Connector setup guide](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) — how `remnic connectors` tracks per-host state