# Claude Code Plugin

The Claude Code integration ships as `@remnic/plugin-claude-code`. The package README is the single source of truth for what it does and how to install it:

- [`packages/plugin-claude-code/README.md`](https://github.com/joshuaswarren/remnic/blob/main/packages/plugin-claude-code/README.md)

What the package README covers, in order:

1. The three discrete manual install steps (none is automated end-to-end today).
2. What ships in the package (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/bin/*.sh`, `skills/`, `agents/memory-review.md`, `.mcp.json`, `settings.json`).
3. The runtime behavior you get once both a Remnic daemon and the plugin are loaded.
4. The `.mcp.json` block you must paste into Claude Code's MCP config yourself.
5. The agent note explaining why hook/skill/agent files are not auto-published.

## Reality vs. older docs

Earlier versions of this page claimed `remnic connectors install claude-code` "installs the plugin / configures MCP / runs a health check." That is no longer true:

- The Claude Code memory-extension publisher in `@remnic/core` (`packages/remnic-core/src/memory-extension/claude-code-publisher.ts`) is an intentional all-no-op stub: `isHostAvailable()` returns `false`, `publish()` writes nothing, and all `PublisherCapabilities` flags are `false`.
- `remnic connectors install claude-code` only writes Remnic-side connector state and mints a bearer token. It does **not** touch Claude Code's plugin tree or MCP config.
- Claude Code has no file-based memory extension directory, so there is nothing for the publisher to write to today.

Follow the package README. The legacy `docs/guides/claude-code-integration.md` and the `scripts/hooks/claude-code/` + `scripts/hooks/codex/` engram-branded hook trees were deleted in #1527 PR1 (this change) because they described a flow that no longer exists; do not recreate them.

## Related

- [`@remnic/plugin-codex`](../plugins/codex.md) — same pattern for OpenAI Codex CLI
- [Connector setup guide](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) — how `remnic connectors` tracks per-host state