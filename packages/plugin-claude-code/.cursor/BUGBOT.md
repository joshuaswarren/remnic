# Plugin Claude Code Review Context

Adapter between `@remnic/core` and the Claude Code CLI.

## Key Patterns
- Hooks in `hooks/` are shell scripts that invoke the core package — validate env var handling, never interpolate unsanitized values.
- Skills in `skills/` define MCP tool surfaces — check parameter validation matches core interfaces.
- Agents in `agents/` provide agent-facing context — verify no personal data leaks.

## Common Issues
- Gateway launchd env is isolated — API keys must be in plist EnvironmentVariables, not shell profile.
- SIGUSR1 doesn't fire `gateway_start` — that's expected, not a bug.
- Import from `@remnic/core`, not relative paths into `packages/remnic-core/src/`.
