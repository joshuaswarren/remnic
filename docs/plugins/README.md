# Plugins

Per-host adapter docs: what each packaged Remnic plugin is, what it does, and how
it hooks into its agent platform. To return to the docs hub, see
[`docs/README.md`](../README.md).

**Plugins vs integration.** This directory (`docs/plugins/`) documents the
per-host *adapters* — the shipped packages (`@remnic/plugin-*`) that embed Remnic
in a specific agent runtime. The [`docs/integration/`](../integration/README.md)
directory holds the *wiring guides* for connecting any tool to a running Remnic
server. Reach for a plugin doc to understand an adapter; reach for an integration
guide to set one up. For MCP-only tools without a plugin system, the connector
lives here too (see Replit) but is wired via the connector setup guide.

Each adapter also ships a package `README.md` under `packages/plugin-*/`, which is
the single source of truth for install and options; these pages summarize and
point to it.

## Adapters

- [OpenClaw plugin](openclaw.md) — `@remnic/plugin-openclaw`, the OpenClaw memory-slot bridge (canonical id `openclaw-remnic`, legacy `openclaw-engram`). The deepest native integration.
- [Claude Code plugin](claude-code.md) — `@remnic/plugin-claude-code`: recall and observation hooks for Claude Code.
- [Codex CLI plugin](codex.md) — `@remnic/plugin-codex`: automatic recall, observation, and session-end learning for OpenAI Codex CLI.
- [Codex marketplace integration](codex-marketplace.md) — Discover and install the Remnic plugin through `codex marketplace`.
- [Hermes agent plugin](hermes.md) — Remnic MemoryProvider for Hermes Agent: recall on every LLM turn plus automatic capture.
- [Replit agent connector](replit.md) — MCP-based connector for Replit Agent (no plugin system, so MCP-only).

## Research and spikes

- [OpenClaw native memory registrars](openclaw-native-memory-registrars.md) — Spike checking OpenClaw's native memory-registrar surface against Remnic's model.
