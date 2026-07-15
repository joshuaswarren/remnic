# Guides

Task-focused walkthroughs for installing, running, tuning, and migrating Remnic.
New here? Start with the [quickstart](quickstart.md). To return to the docs hub,
see [`docs/README.md`](../README.md).

## Getting started

- [Quickstart: install Remnic in 5 minutes](quickstart.md) — Install the CLI, start the daemon, connect one tool, and confirm your first recall.
- [Standalone multi-tenant server](standalone-server.md) — Run Remnic as an HTTP server that serves persistent memory to many agent harnesses at once.

## Running and tuning

- [Daemon management](daemon-management.md) — Start, stop, and supervise the background daemon that owns the memory store.
- [Cost control](cost-control.md) — Budget presets, latency/churn tradeoffs, and disciplined rollout.
- [Local LLM guide](local-llm.md) — Keep extraction, reranking, and helper flows on an OpenAI-compatible endpoint you control.
- [Offline mode](offline-mode.md) — Keep working when the home daemon is unreachable, then sync changes back.
- [Daily context briefing](daily-briefing.md) — Produce a focused "what matters right now" view across your memory store.
- [Lossless context management (LCM)](lossless-context-management.md) — How Remnic preserves context that runtime compaction would otherwise discard.

## Tool-specific setup

- [Using Remnic with Codex CLI](codex-cli.md) — Wire Remnic memory into OpenAI's terminal coding agent.

## Migrating

- [OpenClaw Engram to Remnic](openclaw-engram-to-remnic.md) — Move from the legacy `@joshuaswarren/openclaw-engram` package to `@remnic/plugin-openclaw`.
- [Platform migration guide](platform-migration.md) — Migrate from the single-package Engram plugin to the multi-package Remnic platform.
- [Migrations guide](migrations.md) — Move from manual tuning and historical roadmap docs to the current config surface.

For migrating off lossless-claw specifically, see [`docs/lcm-to-remnic-migration.md`](../lcm-to-remnic-migration.md).
