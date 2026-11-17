---
"@remnic/plugin-agy": patch
---

Init `@remnic/plugin-agy`: Antigravity CLI (agy) plugin. agy-native bundle (`plugin.json`, `hooks.json` at the root, `mcp_config.json`, `rules/AGENTS.md`, skills, agents, stdio MCP proxy) mirroring the Devin/Codex plugin structure: SessionStart recall, PreInvocation prompt recall, PostToolUse observe, Stop end-of-turn flush. agy passes `transcriptPath` in hook payloads; the hook resolves `AGY_TRANSCRIPT_DIR` override and `transcriptFormat` stays `atif` with the JSONL fallback.

Stability: stable
