# Shared Memory Architecture

## How It Works

All agents connect to a single EMO instance. EMO is the sole owner of the memory store on disk. Every agent reads from and writes to the same files.

```
                    ┌──────────────────────────┐
                    │     EMO daemon (:4318)    │
                    │                           │
                    │  ┌─────────────────────┐  │
                    │  │   Memory Store      │  │
                    │  │   (files on disk)    │  │
                    │  └─────────────────────┘  │
                    │                           │
                    │  Orchestrator · Search    │
                    │  Extraction · Governance  │
                    └──────┬───────────────────┘
                           │
          ┌────────┬───────┼────────┬──────────┐
          ▼        ▼       ▼        ▼          ▼
      OpenClaw  Claude   Codex   Hermes    Replit
       (OEO)    Code     CLI    Agent      Agent
```

## Memory Store Location

| Mode | Path | Why |
|------|------|-----|
| Standalone (no OpenClaw) | `~/.remnic/memory/` | Clean default for new users (a legacy `~/.engram/memory/` is read if present) |
| OpenClaw embedded/delegate | `~/.openclaw/workspace/memory/local/` | Backward compat; OpenClaw features (Ops Dashboard, Conductor, cron jobs) read from this path |

The path is resolved at startup:
1. Explicit `memoryDir` in config → use it
2. `REMNIC_MEMORY_DIR` env var (legacy `ENGRAM_MEMORY_DIR`) → use it
3. OpenClaw detected (`~/.openclaw/` exists and plugin mode) → use OpenClaw path
4. Fallback → `~/.remnic/memory/` (or an existing `~/.engram/memory/`)

## Identity Resolution

Each connecting agent is identified by an adapter that resolves three fields:

| Field | Purpose | Example |
|-------|---------|---------|
| `namespace` | Scopes memory queries | `"my-project"`, `"default"` |
| `principal` | Who is acting | `"claude-code"`, `"codex"`, `"hermes-agent"` |
| `sessionKey` | Session continuity | MCP session ID, Hermes session ID |

Adapters detect the connecting platform automatically:

| Platform | Detection signal |
|----------|-----------------|
| Claude Code | `clientInfo.name = "claude-code"` or `User-Agent: claude-code/…` |
| Codex CLI | `clientInfo.name = "codex-mcp-client"` |
| Hermes Agent | `X-Hermes-Session-Id` header |
| Replit Agent | `X-Engram-Client-Id: replit` (user-configured) |
| OpenClaw | In-process (no HTTP needed in embedded mode) |

## Namespace Isolation

By default, all agents share the default namespace — this is what enables cross-agent knowledge. Users can optionally scope agents to different namespaces via `X-Engram-Namespace` headers for isolation when needed.

## Conflict Resolution

When two agents write simultaneously:
- EMO uses file-level locking for storage writes
- Extraction deduplicates memories via content hashing
- Consolidation merges semantically similar memories during governance passes
- Each write is attributed to the originating platform via the auth token

## The User Experience

1. User tells Codex: "I prefer TypeScript over JavaScript for new projects"
2. Codex's `Stop` hook fires → observes this preference → EMO extracts and stores it
3. User opens Claude Code on a different project
4. Claude Code's `SessionStart` hook fires → recalls from EMO → finds the TypeScript preference
5. Claude Code scaffolds the project in TypeScript without asking

The user never configures memory sharing. It just works because all agents talk to the same EMO.
