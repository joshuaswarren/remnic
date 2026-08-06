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

What the marketplace install does **not** do: it does not fill in the MCP server credential. Claude Code auto-discovers the plugin's bundled `.mcp.json` on install, so immediately after `claude plugin install` you have a registered `remnic` MCP server whose header is the literal `Authorization: Bearer {{REMNIC_TOKEN}}` placeholder pointed at `http://localhost:4318/mcp`. **That MCP server will fail to authenticate (401) until you replace the placeholder** — the hooks/skills still work (they resolve the token from the token store / env), but the MCP tools do not until you do one of:

- **Fill it in:** edit the installed plugin's `.mcp.json` and replace `{{REMNIC_TOKEN}}` with a token from `remnic token generate claude-code` (the `<connector-id>` argument is required; run `remnic connectors install claude-code` first if that connector has not been registered), and, for a remote daemon, set the `url` — per the package README's "MCP setup". Note a plugin reinstall/update overwrites this edited copy.
- **Or register the MCP server yourself and ignore the bundled one:** `claude mcp add remnic --transport http <url> --header "Authorization: Bearer <token>"`, using your own daemon URL + token.

In other words, the marketplace replaces the *plugin load* step; the token/MCP-config step is still manual, and the bundled placeholder means the `remnic` MCP server is inert until you complete it. Both the marketplace install and the manual / npm install ship the same bundled `.mcp.json` — they share that contract deliberately. (A cleaner long-term fix — registering the MCP server via Claude Code plugin `userConfig` and `lifecycle` hooks instead of asking the user to fill the placeholder — is tracked as #2314.)

> **Security — use HTTPS for a remote daemon.** The MCP config sends `Authorization: Bearer <your token>` to whatever `url` you set. Plain `http://` is acceptable **only** for loopback endpoints (`http://localhost:4318/mcp`, `http://127.0.0.1:…`). For any non-loopback / remote daemon the URL **must** be `https://` so the bearer token is never transmitted in cleartext. (If you reach a remote daemon over an already-encrypted overlay such as a VPN/WireGuard tunnel, terminate TLS or keep the daemon bound to loopback on the far side rather than exposing plain HTTP.)

## Reality vs. older docs

Earlier versions of this page claimed `remnic connectors install claude-code` "installs the plugin / configures MCP / runs a health check." That is no longer true:

- The Claude Code memory-extension publisher in `@remnic/core` (`packages/remnic-core/src/memory-extension/claude-code-publisher.ts`) is an intentional all-no-op stub: `isHostAvailable()` returns `false`, `publish()` writes nothing, and all `PublisherCapabilities` flags are `false`.
- `remnic connectors install claude-code` only writes Remnic-side connector state and mints a bearer token. It does **not** touch Claude Code's plugin tree or MCP config.
- Claude Code has no file-based memory extension directory, so there is nothing for the publisher to write to today.

Follow the package README. The legacy `docs/guides/claude-code-integration.md` and the `scripts/hooks/claude-code/` + `scripts/hooks/codex/` engram-branded hook trees were deleted in #1527 PR1 (this change) because they described a flow that no longer exists; do not recreate them.


## Troubleshooting

The `remnic connectors install claude-code` step only writes Remnic-side state; the plugin still has to be loaded, and the MCP credential still has to be supplied. How those two happen depends on the install path:

- **Marketplace path** (see "Install from the Claude Code marketplace" above): `claude plugin install remnic@remnic` loads the plugin, and Claude Code auto-discovers the plugin's bundled `.mcp.json` — you do **not** paste an MCP block, you fill the `{{REMNIC_TOKEN}}` placeholder in the installed copy (or register your own server with `claude mcp add`).
- **Manual / npm path** (package README): you `npm install -g @remnic/plugin-claude-code`, load it through Claude Code's plugin loader, **and** paste the README's `.mcp.json` block into your MCP config by hand with the bearer token.

Either way the three things to verify are: Remnic-side token + connector state, the MCP config (token present, URL correct), and that the plugin is actually loaded. The package README's `Troubleshooting` section lists the specific failure modes for each step.

If `remnic connectors doctor claude-code` reports green but auto-recall/auto-observe do not fire in a Claude Code session, the most common cause is step 3 (plugin load) being skipped — the Remnic-side state is fine, but Claude Code has no hook/skill/agent tree to invoke until the plugin is loaded through Claude Code's own loader.
## Related

- [`@remnic/plugin-codex`](../plugins/codex.md) — same pattern for OpenAI Codex CLI
- [Connector setup guide](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) — how `remnic connectors` tracks per-host state