# Devin CLI Plugin

Native Remnic plugin for [Devin CLI](https://devin.ai). Provides automatic memory recall, observation, LCM compaction coordination, and session-end learning capture — the same lifecycle coverage the Codex and Claude Code plugins provide.

The package README is the single source of truth for install and configuration details:

- [`packages/plugin-devin/README.md`](https://github.com/joshuaswarren/remnic/blob/main/packages/plugin-devin/README.md)

## What It Does

### Automatic Memory (via hooks)

| Hook | When | What Happens |
|------|------|-------------|
| `SessionStart` | Session begins or resumes | Recalls project context + user preferences |
| `UserPromptSubmit` | Every user message | Recalls memories relevant to the prompt |
| `PostToolUse` | After `write`/`edit`/`apply_patch`/`notebook_edit` | Schedules a background observe of the transcript delta |
| `Stop` | Every completed turn | Schedules a background observe so turn-level work is captured even without file edits |
| `PostCompaction` | After context compaction | Drains the unobserved transcript tail, then flushes the observe buffer to long-term memory |
| `SessionEnd` | Session ends (local CLI/Desktop only) | Final observe flush + cursor cleanup |

### Transcript handling

Devin CLI does not pass `transcript_path` in hook payloads and writes session
transcripts as a single ATIF JSON document rather than the JSONL format used
by Claude Code and Codex. The shared hook runner (`scripts/hook-runner/`)
supports both formats: `config.transcriptFormat: "atif"` selects the ATIF
parser, and `config.resolveTranscriptPath` locates
`<data>/devin/cli/transcripts/<session_id>.json` (override with
`DEVIN_TRANSCRIPT_DIR`).

### Explicit Skills and MCP

- Skills: `remnic-recall`, `remnic-remember`, `remnic-search`,
  `remnic-entities`, `remnic-status`, `remnic-memory-workflow`
- MCP: a stdio↔HTTP proxy (`mcp-server-stdio/server.js`) exposes the daemon's
  full tool surface as `mcp__remnic__*`. Credentials resolve from
  `REMNIC_DAEMON_URL`/`REMNIC_DAEMON_TOKEN` env vars or the shared
  `~/.remnic/tokens.json` store (`remnic token generate devin-cli`).

## Installation

```bash
remnic token generate devin-cli
devin plugins install --local /path/to/remnic/packages/plugin-devin
# or from a git source: devin plugins install <owner/repo>#packages/plugin-devin
```

See the package README for remote-daemon configuration (`REMNIC_DAEMON_URL`)
and credential precedence.
