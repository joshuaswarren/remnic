---
"@remnic/core": major
"@remnic/server": major
"@remnic/cli": major
"@remnic/hermes-provider": major
"@remnic/plugin-openclaw": patch
---

Initial 1.0.0 release of Remnic workspace packages as standalone npm packages.

- `@remnic/core` 1.0.0: Framework-agnostic memory engine with multi-token auth, cached token loading
- `@remnic/server` 1.0.0: Standalone HTTP/MCP server with daemon lifecycle support
- `@remnic/cli` 1.0.0: CLI with daemon management (launchd/systemd), connector install, token management
- `@remnic/hermes-provider` 1.0.0: TypeScript HTTP client for the Remnic API
- `@remnic/plugin-openclaw`: Bridge mode (embedded/delegate), ENGRAM_CONFIG_PATH support
- `remnic-hermes` on PyPI: Python MemoryProvider for Hermes Agent
- Native plugins for Claude Code and Codex CLI (installed via `remnic connectors install`)
