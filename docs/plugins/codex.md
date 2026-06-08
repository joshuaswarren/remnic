# Codex CLI Plugin

Native Remnic plugin for OpenAI Codex CLI. Provides automatic memory recall, observation, and session-end learning capture.

## Installation

```bash
remnic connectors install codex-cli
```

This:
1. Starts the Remnic daemon if not running
2. Generates a dedicated auth token
3. Installs the plugin to `~/.codex/plugins/`
4. Enables hooks (`[features] codex_hooks = true` in `~/.codex/config.toml`)
5. Configures MCP server pointing to Remnic
6. Drops the Codex memory extension at `~/.codex/memories_extensions/remnic/instructions.md`
7. Runs a health check

## What It Does

### Automatic Memory (via hooks)

| Hook | When | What Happens |
|------|------|-------------|
| `SessionStart` | Session begins | Recalls project context + user preferences |
| `UserPromptSubmit` | Every user message | Recalls memories relevant to the prompt |
| `PostToolUse` | After Bash execution | Observes command results and file changes |
| `Stop` | Session ends | Flushes session learnings to EMO |

### Explicit Skills

Skills ship as `packages/plugin-codex/skills/<slug>/SKILL.md` folders and are
materialized into `~/.codex/memories/skills/<slug>/SKILL.md` by the Codex
materializer.

| Skill folder | Description |
|--------------|-------------|
| `remnic-memory-workflow/` | Umbrella workflow: recall, observe, remember. |
| `remnic-recall/` | Search memories by natural-language query. |
| `remnic-remember/` | Store a durable memory for cross-agent recall. |
| `remnic-search/` | Full-text search across all stored memories. |
| `remnic-entities/` | Browse entities in the Remnic knowledge graph. |
| `remnic-status/` | Check Remnic daemon and memory system health. |

### MCP Tools

All 44 Remnic MCP tools are available via the `.mcp.json` configuration. The legacy `engram.*` aliases remain available during v1.x.

## Memory Extension

Codex ships a phase-2 memory consolidation sub-agent that looks for
extensions under a folder that is a **sibling** of `<codex_home>/memories/`.
From Codex's `memories` module:

- `MEMORIES_SUBDIR = "memories"`
- `EXTENSIONS_SUBDIR = "memories_extensions"`
- `memory_extensions_root()` is computed via Rust's
  `Path::with_file_name("memories_extensions")`, so the extensions live at
  `<codex_home>/memories_extensions/` — NOT inside `<codex_home>/memories/`.

`remnic connectors install codex-cli` copies the contents of
`packages/plugin-codex/memories_extensions/remnic/` (notably
`instructions.md`) into that sibling location atomically. The write goes
to a temporary folder first and is then renamed into place, so a concurrent
Codex consolidation run never observes a half-written extension.

When Codex phase-2 runs, its sandboxed consolidation sub-agent reads
`instructions.md` via filesystem tools — no MCP, no network, no `remnic`
CLI invocation. The instructions teach the sub-agent how to locate Remnic
memory files on disk (`~/.remnic/memories/<namespace>/…`), how to resolve
the namespace from the session's cwd, when to consult Remnic and when to
skip it, and how to cite Remnic sources with `<oai-mem-citation />` blocks.

### Install location

| Env                       | Location                                          |
|---------------------------|---------------------------------------------------|
| default                   | `~/.codex/memories_extensions/remnic/`            |
| `$CODEX_HOME=/foo`        | `/foo/memories_extensions/remnic/`                |
| `codex.codexHome` config  | `<codexHome>/memories_extensions/remnic/`         |

The extension directory is scoped to `remnic/`. Adjacent extensions under
`memories_extensions/` (from other vendors) are never read, overwritten,
or removed by `remnic connectors install|remove codex-cli`.

### Opting out

Users who self-manage Codex memory extensions can disable this behavior
via the `codex.installExtension` config flag:

```jsonc
{
  "remnic": {
    "codex": {
      "installExtension": false,
      "codexHome": null
    }
  }
}
```

When `installExtension` is `false`, `remnic connectors install codex-cli`
still installs MCP and hooks but does not touch `memories_extensions/`.

## How It Differs from Claude Code Plugin

- **Stop hook:** Codex has a `Stop` event that fires when the agent completes its turn. The plugin uses this to flush any remaining observations and store session learnings — ensuring nothing is lost even if the session ends abruptly.
- **PostToolUse matcher:** Matches `Bash` (Codex's primary tool) instead of `Write|Edit|MultiEdit`.
- **Hooks feature flag:** Codex hooks require `[features] codex_hooks = true` — the installer sets this automatically.
- **Config format:** TOML (`~/.codex/config.toml`) instead of JSON.

## Configuration

Token is read from `~/.remnic/tokens.json`, with `~/.engram/tokens.json` still accepted as a migration fallback. Server defaults to `127.0.0.1:4318`.

## Troubleshooting

Same as Claude Code plugin — see [claude-code.md](./claude-code.md#troubleshooting).

Additional Codex-specific issue:

### Hooks not firing

Verify hooks are enabled:

```bash
grep codex_hooks ~/.codex/config.toml
# Should show: codex_hooks = true
```

## Native memory materialization

Codex CLI's phase-2 consolidation reads memories directly from files under
`<codex_home>/memories/` — `memory_summary.md` (always-loaded),
`MEMORY.md` (searchable handbook, task-group schema), `raw_memories.md`, and
per-session `rollout_summaries/*.md`. Remnic can mirror its hot memories into
this exact layout so Codex's native read path picks up Remnic content with
zero MCP calls.

### How it works

1. **Opt-in sentinel.** Remnic will only write into a memories directory that
   already contains a `.remnic-managed` sentinel file. If the sentinel is
   missing, the materializer **skips with a warning and never touches the
   directory** — this preserves any hand-edits the user has made. Use
   `remnic connectors install codex-cli` (or drop a `.remnic-managed` file
   yourself) to opt in.
2. **Atomic writes.** Every file is rendered under `<codex_home>/memories/.remnic-tmp/`
   first and then `rename()`-ed into place, so Codex never observes a
   half-written file.
3. **Schema validation.** `MEMORY.md` is validated against Codex's task-group
   schema before it is written. Invalid output throws — the materializer
   refuses to leave garbage on disk.
4. **Idempotent no-ops.** The sentinel stores a content hash of the last
   render. If the next run produces identical content, the materializer
   short-circuits with zero writes.
5. **Token budget.** `memory_summary.md` is capped at
   `codexMaterializeMaxSummaryTokens` whitespace tokens (default `4500`),
   leaving headroom under Codex's 5000-token summary limit.

### Triggers

| Trigger | Config flag | Notes |
|---|---|---|
| Semantic / causal consolidation complete | `codexMaterializeOnConsolidation` (default `true`) | Runs immediately after a consolidation pass finishes. |
| Codex `Stop` / session-end hook | `codexMaterializeOnSessionEnd` (default `true`) | The `session-end` event of the unified hook runner (`hooks/bin/remnic-codex-hook.cjs`) invokes the packaged `bin/materialize.cjs` (dev fallback: `scripts/codex-materialize.ts`). |
| Manual | — | `tsx scripts/codex-materialize.ts --reason manual` |

### Configuration

Every knob is exposed via plugin config so users have maximum control:

| Key | Default | Description |
|---|---|---|
| `codexMaterializeMemories` | `true` | Master switch — set `false` to disable all materialization. |
| `codexMaterializeNamespace` | `"auto"` | Namespace to materialize. `"auto"` derives it from the connector context. |
| `codexMaterializeMaxSummaryTokens` | `4500` | Whitespace-tokenized cap for `memory_summary.md`. |
| `codexMaterializeRolloutRetentionDays` | `30` | Prune rollout summaries older than this window. |
| `codexMaterializeOnConsolidation` | `true` | Run after semantic/causal consolidation completes. |
| `codexMaterializeOnSessionEnd` | `true` | Run from the plugin-codex session-end hook. |

### Opting out

Set `codexMaterializeMemories = false` in your Remnic plugin config. The
materializer becomes a no-op immediately. Alternatively, delete the
`.remnic-managed` sentinel — Remnic will start warning and will not touch the
directory again until the sentinel is restored.

## Uninstall

```bash
remnic connectors remove codex-cli
```
