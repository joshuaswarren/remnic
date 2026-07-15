# EMO/OEO Architecture Split

> Decision record (historical) — 2026-04-05. The split that made the engine host-agnostic; the standalone-daemon architecture it describes is current. "EMO/OEO" and `openclaw-engram` are the decision-era component and package names.

> **Status:** Accepted  
> **Date:** 2026-04-05  
> **Author:** Joshua Warren

## Summary

Remnic is restructured from a monolithic OpenClaw plugin into two components:

- **EMO (Engram Memory Orchestrator)** — standalone daemon process. The product.
- **OEO (OpenClaw Engram Orchestrator)** — thin OpenClaw plugin that bridges to EMO.

## Problem

Remnic's value is universal memory for AI agents, but its architecture couples it to OpenClaw. Users of Claude Code, Codex CLI, Hermes Agent, and Replit Agent must run OpenClaw just to get Remnic. This limits adoption and prevents the core value proposition: **all your agents sharing one memory**.

## Decision

### EMO is the product

EMO runs as a standalone daemon on `:4318`, exposing HTTP + MCP endpoints. It owns:

- Memory store (files on disk)
- Orchestrator (extraction, search, consolidation, governance)
- All 44+ MCP tools
- HTTP REST API
- Adapter registry (identity resolution per connecting client)
- Auth token validation

EMO starts on boot via `launchd` (macOS) or `systemd` (Linux). Users never think about it.

### OEO is a thin bridge

OEO is an OpenClaw memory-slot plugin that delegates to EMO. It publishes as `openclaw-engram` on npm for backward compatibility. Two modes:

| Mode | How it works | When to use |
|------|-------------|-------------|
| **Embedded** (default) | OEO creates an Orchestrator in-process AND starts the HTTP server on `:4318` | Backward compat for existing users |
| **Delegate** | OEO connects to a running EMO daemon via HTTP | Recommended for multi-agent setups |

**Critical:** Even in embedded mode, `:4318` is always exposed so Claude Code, Codex, and other agents can connect to the same memory store OpenClaw is using.

### All agents share one memory

```
EMO daemon (:4318) — single process, single memory store
├── ← OpenClaw (OEO, in-process or delegate)
├── ← Claude Code (plugin hooks + MCP)
├── ← Codex CLI (plugin hooks + MCP)
├── ← Hermes Agent (MemoryProvider + HTTP)
└── ← Replit Agent (MCP)
```

When a user tells OpenClaw "I prefer TypeScript", Claude Code knows this on the next session. When Codex learns a project uses a specific testing pattern, Hermes Agent can recall it. All agents read from and write to the same store.

## Consequences

### Positive

- Remnic becomes usable without OpenClaw
- Multi-agent memory sharing works out of the box
- Clear separation of concerns (engine vs integration)
- Each platform gets a native plugin, not just MCP
- Independent versioning and release cycles

### Negative

- Monorepo complexity (build orchestration, cross-package testing)
- Two operational modes to support (embedded vs daemon)
- OpenClaw users must upgrade carefully (backward compat via `openclaw-engram` package name)

### Risks

- Embedded mode must reliably start HTTP server without conflicting with an existing daemon
- Memory store location must be configurable (standalone: `~/.engram/memory/`, OpenClaw: `~/.openclaw/workspace/memory/local/`)

## Alternatives Considered

1. **Keep monolithic plugin, add MCP-only connectors** — rejected because MCP alone can't provide automatic per-turn memory injection (no hooks)
2. **Fork Remnic for standalone** — rejected because it creates maintenance burden of two codebases
3. **Make OpenClaw optional peer dep** — rejected because the split must be clean; the engine should have zero OpenClaw imports
