# Monorepo Structure

The monorepo is organized around a host-agnostic core. `@remnic/core`, `@remnic/server`, and `@remnic/cli` are the product center. OpenClaw, Hermes, Claude Code, Codex, and other integrations are adapters over that shared runtime and should not own core memory semantics.

## Package Map

```
remnic/
├── packages/
│   ├── remnic-core/          @remnic/core                  Memory engine (0 host deps)
│   ├── remnic-server/        @remnic/server                HTTP + MCP server
│   ├── remnic-cli/           @remnic/cli                   CLI binary (daemon, connectors, tokens)
│   ├── plugin-openclaw/      @remnic/plugin-openclaw       OpenClaw adapter
│   ├── plugin-claude-code/   @remnic/plugin-claude-code    Claude Code native plugin
│   ├── plugin-codex/         @remnic/plugin-codex          Codex CLI native plugin
│   ├── plugin-hermes/        remnic-hermes (PyPI)          Hermes MemoryProvider (Python)
│   ├── connector-replit/     @remnic/replit                Replit MCP connector
│   └── bench/                @remnic/bench                 Benchmarks
├── src/                      OpenClaw runtime compatibility wiring and shims
├── tests/                    Cross-package integration tests
├── docs/                     All documentation
└── evals/                    Evaluation harness
```

## Dependency Graph

```
@remnic/core ← no internal deps, no OpenClaw imports
│
├── @remnic/server ← depends on core
├── @remnic/cli ← depends on core, server
├── @remnic/bench ← depends on core
├── @remnic/plugin-openclaw ← depends on core
├── @remnic/plugin-claude-code ← depends on core (installer only)
├── @remnic/plugin-codex ← depends on core (installer only)
└── @remnic/replit ← depends on core (installer only)

@remnic/hermes-provider ← standalone TS HTTP client (0 internal deps)
remnic-hermes (Python) ← standalone, HTTP to Remnic server (0 internal deps)
```

## Build Order

Turborepo handles this automatically via `turbo.json`:

1. `@remnic/core` (foundation — everything depends on this)
2. `@remnic/server`, `@remnic/plugin-openclaw`, `@remnic/bench` (depend on core)
3. `@remnic/cli` (depends on core + server)
4. `@remnic/plugin-claude-code`, `@remnic/plugin-codex`, `@remnic/replit` (depend on core for installers)
5. `remnic-hermes` (Python — separate build pipeline)

## Package Details

### @remnic/core

The memory engine. Contains the Orchestrator, StorageManager, ExtractionEngine, all search backends, trust zones, namespace isolation, LCM, entity graph, compounding, shared context, work layer, and all supporting modules.

**Zero OpenClaw or Hermes imports.** Can be used by any host.

### @remnic/server

Standalone HTTP + MCP server. Wraps `@remnic/core` with the shared access service and adapter registry for client identity resolution.

### @remnic/cli

CLI binary providing:
- `remnic daemon install|uninstall|start|stop|status` — daemon lifecycle
- `remnic connectors install|remove|doctor|list` — connector management
- `remnic token generate|list|revoke` — auth token management
- `remnic init|status|query|doctor|config` — setup and diagnostics
- `remnic onboard|curate|review|sync|dedup` — memory operations
- `remnic space|tree|bench` — workspace and benchmarking

### @remnic/plugin-openclaw

OpenClaw adapter. Depends on `@remnic/core` and maps Remnic behavior onto OpenClaw's current plugin SDK and runtime surfaces. Keep host-specific logic here or in the root `src/` compatibility wiring when the OpenClaw loader still requires it.

### @remnic/plugin-claude-code

Native Claude Code plugin. Contains:
- `.claude-plugin/plugin.json` — plugin manifest
- `hooks/` — SessionStart, PostToolUse, UserPromptSubmit hooks
- `skills/` — `/engram:remember`, `/engram:recall`, etc.
- `agents/` — memory review agent
- `.mcp.json` — MCP server pointing to the Remnic daemon

### @remnic/plugin-codex

Native Codex CLI plugin. Contains:
- `.codex-plugin/plugin.json` — plugin manifest
- `hooks/` — SessionStart, PostToolUse, UserPromptSubmit, Stop hooks
- `skills/` — memory workflow instructions
- `.mcp.json` — MCP server pointing to the Remnic daemon

### remnic-hermes (Python)

Hermes MemoryProvider plugin. Distributed via PyPI. Implements the Hermes v0.7.0+ MemoryProvider protocol:
- `pre_llm_call` — inject recalled memories every turn
- `sync_turn` — observe conversation every turn
- `extract_memories` — structured extraction on session end
- Also registers explicit tools (recall, store, search)

### @remnic/replit

Replit MCP connector. Minimal package — setup instructions, config template, and installer that generates a token.

### @remnic/bench

Retrieval latency benchmarks and CI regression gates.

## Workspace Configuration

**pnpm-workspace.yaml:**
```yaml
packages:
  - "packages/*"
```

**turbo.json:**
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "check-types": {}
  }
}
```

## Compatibility Shims

Root `src/` currently exists for compatibility shims and OpenClaw runtime entrypoints that have not yet fully moved into `packages/plugin-openclaw`:

```typescript
// src/orchestrator.ts
export * from "@remnic/core/orchestrator";
```

These ensure:
- Existing tests in root `tests/` keep working during migration
- The root `tsup.config.ts` build still produces a valid `dist/index.js`
- Any external code importing from the root package isn't broken

Do not move new cross-platform semantics into root `src/`; put them in core and let adapters consume them.
