# Plugin Codex Review Context

Adapter between `@remnic/core` and Codex.

## Key Patterns
- Memory extensions in `memories_extensions/` define Codex-native tools — verify schema alignment with core types.
- Skills in `skills/` mirror the Claude Code plugin — keep in sync but respect Codex conventions.
- Import from `@remnic/core`, not relative paths.
- Citation blocks (`<oai-mem-citation>`) must be Codex-compatible.
