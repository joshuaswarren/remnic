# @remnic/plugin-devin

Native [Devin CLI](https://devin.ai) plugin for [Remnic](https://github.com/joshuaswarren/remnic) memory. Wires Devin's lifecycle hooks, MCP server, skills, and the `memory-review` subagent into a running Remnic daemon so every Devin session gets persistent long-term memory automatically.

Website: <https://remnic.ai> - Source: <https://github.com/joshuaswarren/remnic> - Docs: <https://remnic.ai/guides/>

## Install

1. **Start a Remnic daemon** (`remnic daemon start`) and mint a bearer token:

    ```bash
    remnic token generate devin-cli
    ```

    The token is stored in `~/.remnic/tokens.json` and is picked up automatically by both the hook runner and the MCP proxy — no secrets are written into plugin files.

2. **Install the plugin** from this repository (Devin loads plugins from git
   URLs or local folders):

    ```bash
    devin plugins install --local /path/to/remnic/packages/plugin-devin
    ```

    or from the published package / a git source per `devin plugins install --help`.

3. **Optional — remote daemon.** To point hooks and MCP at a shared daemon
   instead of `localhost:4318`, export before launching Devin:

    ```bash
    export REMNIC_DAEMON_URL="https://remnic.example.com:4318"
    ```

    Plain `http://` is refused by the MCP proxy for non-loopback hosts because
    the bearer token travels with every request; use `https://` or a loopback
    address. The lifecycle hooks accept any `http(s)://` daemon URL (remote
    daemons on trusted LAN/Tailscale links are supported) but print a
    cleartext-token warning on stderr for non-loopback `http://` targets —
    prefer `https://` there too.

## What ships

| File / dir | Purpose |
|---|---|
| `.devin-plugin/plugin.json` | Plugin manifest |
| `hooks/hooks.json` | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `PostCompaction`, `SessionEnd` hook wiring |
| `hooks/bin/remnic-devin-hook.cjs` | Thin per-host config for the shared hook runner |
| `hooks/bin/remnic-hook-core.cjs` | Shared cross-platform hook runner (synced from `scripts/hook-runner/`) |
| `mcp-server-stdio/server.js` | stdio↔HTTP MCP proxy with token-store fallback |
| `.mcp.json` | MCP server registration (`remnic` → stdio proxy) |
| `skills/` | `remnic-recall`, `remnic-remember`, `remnic-search`, `remnic-status`, `remnic-entities`, `remnic-memory-workflow` |
| `agents/memory-review.md` | Subagent that audits and curates project memories |

## What you get at runtime

- **Auto-recall** on `SessionStart` and every `UserPromptSubmit` — relevant
  memories are injected into context before the first turn and each prompt.
- **Auto-observe** — the hook runner tails the session's ATIF transcript
  (`~/.local/share/devin/cli/transcripts/<session_id>.json`) and posts new
  user/agent/tool-activity deltas to `/engram/v1/observe`, so the shared
  memory corpus learns from Devin work, not just file edits. Observations
  are triggered on file-mutating tools (`write`, `edit`, `apply_patch`,
  `notebook_edit`), on every `Stop` (turn end), and drained at
  `PostCompaction`/`SessionEnd`.
- **LCM coordination** — `PostCompaction` drains any unobserved transcript
  tail, then calls `/engram/v1/lcm/compaction/flush` so long-term memory is
  flushed before context is lost.
- **Memory skills** — `/remnic:remnic-recall`, `/remnic:remnic-search`,
  `/remnic:remnic-remember`, `/remnic:remnic-entities`,
  `/remnic:remnic-status`, `/remnic:remnic-memory-workflow`.
- **MCP tools** — the full Remnic tool surface (`mcp__remnic__*`) for
  on-demand recall, store, search, and entity lookups.
- **Cross-agent sharing** — the same memory store is shared with every other
  Remnic-connected agent (Claude Code, Codex, omp, OpenClaw, etc.).

## Hook credentials

The hook runner resolves its bearer token independently of the MCP proxy, in
this order:

1. `~/.remnic/tokens.json`, then legacy `~/.engram/tokens.json` — the
   `devin-cli` connector entry first, then `devin`, then `openclaw`.
2. `OPENCLAW_REMNIC_ACCESS_TOKEN`, `REMNIC_AUTH_TOKEN`,
   `OPENCLAW_ENGRAM_ACCESS_TOKEN`, `ENGRAM_AUTH_TOKEN` env vars.
3. `REMNIC_DAEMON_URL`/`ENGRAM_DAEMON_URL` (or `REMNIC_HOST`/`REMNIC_PORT`)
   selects the daemon; default `http://127.0.0.1:4318`.

The MCP proxy resolves credentials the same way (env first, then the token
store), so one `remnic token generate devin-cli` covers both paths.

## Transcript resolution

Devin CLI does not pass `transcript_path` in hook payloads. The runner derives
it from `session_id`:

1. `$DEVIN_TRANSCRIPT_DIR/<session_id>.json`
2. `$XDG_DATA_HOME/devin/cli/transcripts/<session_id>.json`
   (default `~/.local/share/devin/cli/transcripts`)
3. `~/Library/Application Support/devin/cli/transcripts/<session_id>.json`
   (macOS)

Set `DEVIN_TRANSCRIPT_DIR` if your Devin data directory lives elsewhere.

## Notes and limitations

- Plugin hooks are best-effort and fail open — a Remnic outage never blocks a
  Devin session; recall/observe simply no-op until the daemon is back.
- `SessionEnd` does not fire in Devin Cloud sessions; compaction flush still
  runs via `PostCompaction`, and the daemon-side extraction pipeline picks up
  buffered observations on its own schedule.
- Observation covers user prompts, agent messages, and tool calls/results
  rendered from the ATIF transcript (bounded per message). It is not a
  verbatim transcript upload.
