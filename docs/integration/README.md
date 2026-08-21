# Integration

Wiring guides for connecting Remnic memory to specific tools, hosts, and network
topologies. Each Remnic HTTP/MCP server speaks the same protocol, so most tools
connect the same way, you just point them at the server. To return to the docs
hub, see [`docs/README.md`](../README.md).

For per-host plugin adapters (the packaged extensions themselves), see the
[plugins index](../plugins/README.md). This directory is the *how to wire it up*
layer; `docs/plugins/` is the *what each adapter is* layer.

## Connect a tool

- [Connector setup guide](connector-setup.md) — Point Claude Code, Codex, Cursor, Copilot, Cline, Roo Code, Windsurf, Amp, Replit, Hermes, or any generic MCP client at Remnic.
- [ChatGPT (developer mode)](chatgpt.md) — Give ChatGPT persistent, governed memory on your own infrastructure via MCP and OAuth 2.1.
- [Pi coding agent](pi.md) — Native Pi extension (`@remnic/plugin-pi`) using Pi's hooks, slash commands, and compaction coordination.
- [Oh My Pi (omp)](omp.md) — omp rules, MCP server config, and the native omp extension.
- [Prime Agent](prime-agent.md) — Pi-fork coding agent; `remnic connectors install prime-agent` installs the shared Pi-family extension under `~/.prime/agent`.
- [Hermes setup](hermes-setup.md) — Hermes Agent via the `remnic-hermes` Python package or `X-Hermes-Session-Id` auto-detection.

## Deploy and scope

- [Deployment topologies](deployment-topologies.md) — Localhost, LAN, remote, containerized, and standalone server layouts.
- [Plugin ID and memory namespaces](plugin-id-and-memory-namespaces.md) — The OpenClaw plugin id split (`openclaw-remnic`), the `plugins.slots.memory` gate, and namespace isolation.
