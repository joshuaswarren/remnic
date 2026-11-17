# Remnic memory rules for Antigravity workspaces

When this file is present (workspace `.agents/` or project root), agy agents
working here share one Remnic memory with every other connected agent.

- Before starting non-trivial work, recall: ask Remnic for prior context
  (`mcp__remnic__remnic_recall` or the `remnic-recall` skill). Session start
  already injects a recall summary when the plugin hook runs.
- After durable decisions, discoveries, or fixes, store them
  (`mcp__remnic__remnic_memory_store` or the `remnic-remember` skill).
- What one agent learns is available to all: Claude Code, Codex, omp,
  OpenClaw, Hermes, and Antigravity share the same store.
- Plugin hooks are best-effort and fail open: a Remnic outage never blocks
  the session; recall/observe simply no-op until the daemon is back.

Token: run `remnic token generate agy-cli` once; the hook runner and MCP
proxy pick it up from `~/.remnic/tokens.json` with no secrets in files.
