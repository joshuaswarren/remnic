# remnic-hermes

Remnic MemoryProvider plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Automatically injects memories into every LLM call and observes every conversation turn — no agent code changes required.

The `remnic-hermes` PyPI package provides automatic MemoryProvider recall/observation, daemon-side LCM recall enrichment, session reset scoping, the full explicit Remnic tool parity surface, and legacy `engram_*` aliases for existing configs.

## Why MemoryProvider

MCP tools give an agent the ability to call memory functions, but only when the agent decides to. With the MemoryProvider protocol, recall happens structurally on every turn before the LLM is called, and observation happens after every response. The agent cannot forget to recall because the hook is not optional. A plain MCP integration requires the LLM to recognize that it should search for memories and then choose to call the tool; the MemoryProvider removes that dependency entirely.

| Aspect | MCP Only | MemoryProvider |
|--------|----------|---------------|
| Recall | Agent must call `remnic_recall` | Automatic on every turn |
| Observe | Agent must call `remnic_store` | Automatic after every response |
| Latency | Tool call overhead | Pre-fetched, non-blocking |
| Reliability | Agent may forget to call | Structural — cannot be skipped |

## Which Hermes plugin slot does Remnic use?

Remnic ships as a Hermes memory provider plugin (declared in `plugin.yaml` as `kind: exclusive`, the Hermes manifest kind used for provider plugins selected through `memory.provider`).

**Remnic does not use, and does not need to use, Hermes' `context_engine` slot.** That slot replaces the built-in `ContextCompressor` — it is for *compressing the agent's own outgoing conversation history*. Remnic delivers external memory recall (and, when enabled daemon-side, Lossless Context Management archive content) through the `memory_provider` hook (`pre_llm_call`), which is the correct slot for this concern.

If you have read documentation or third-party reviews suggesting Remnic must register as a `context_engine` to enable LCM in Hermes, that is incorrect. LCM runs on the Remnic daemon and arrives in Hermes through the recall envelope returned by the memory_provider — no `context_engine` registration is involved. The two slots are orthogonal: a future Remnic-backed `ContextEngine` plugin would be a separate, additive feature for replacing Hermes' local compressor, not a prerequisite for memory or LCM.

## Prerequisites

- **Remnic daemon** running and accessible on port `4318` (default). See the [Remnic repository](https://github.com/joshuaswarren/remnic) for installation instructions.
- **Hermes Agent v0.7.0 or later** — the MemoryProvider protocol was added in v0.7.0.
- **Python 3.10 or later**.

## Quick start

1. Install the plugin:
   ```bash
   pip install --upgrade remnic-hermes
   ```

2. Wire Hermes to Remnic (generates an auth token, writes the Hermes config entry, and checks daemon health):
   ```bash
   remnic connectors install hermes
   ```

3. Restart Hermes so it picks up the new config entry.

4. Verify the connection:
   ```bash
   hermes --version && pip show remnic-hermes
   ```
Your agent should now have structural memory on every turn plus explicit tools such as `remnic_recall`, `remnic_lcm_search`, `remnic_recall_xray`, `remnic_memory_store`, `remnic_context_checkpoint`, and `remnic_profiling_report`. Call `remnic_recall` with any query to confirm memories are returned.

## Manual configuration

If you prefer not to use `remnic connectors install`, add the following to your Hermes `config.yaml` directly:

```yaml
plugins:
  - remnic_hermes

remnic:
  host: "127.0.0.1"      # Remnic daemon host. Default: 127.0.0.1
  port: 4318             # Remnic daemon port. Default: 4318
  token: ""              # Auth token. Leave empty to auto-load from ~/.remnic/tokens.json.
  session_key: ""        # Session identifier. Auto-generated as hermes-<12hex> if not set.
  timeout: 30.0          # HTTP request timeout in seconds. Default: 30.0
```

A legacy `engram:` config block is also accepted during the Engram to Remnic transition. The plugin reads `remnic:` first and falls back to `engram:` when the `remnic:` key is absent, so existing configs continue working without edits.

### Environment variable overrides

| Variable | Overrides | Description |
|----------|-----------|-------------|
| `REMNIC_HOST` | `remnic.host` | Daemon hostname or IP |
| `REMNIC_PORT` | `remnic.port` | Daemon port number |
| `ENGRAM_HOST` | `remnic.host` | Legacy fallback for `REMNIC_HOST` |
| `ENGRAM_PORT` | `remnic.port` | Legacy fallback for `REMNIC_PORT` |

Environment variables are only consulted when the corresponding field is absent from the config block. Inline config values take precedence over environment variables.

The auth token is not read from an environment variable. It is either set inline (`token: "..."`) or auto-loaded from the Remnic token store at `~/.remnic/tokens.json` (falling back to `~/.engram/tokens.json` during the compat window).

### Token bootstrap

`remnic connectors install hermes` is the recommended way to get a token into place. It:

1. Validates the Hermes profile directory and config structure.
2. Generates a dedicated per-connector auth token scoped to Hermes.
3. Adds the `remnic:` block to your Hermes `config.yaml` (with rollback on failure).
4. Commits the token to `~/.remnic/tokens.json`.
5. Writes the connector config file.
6. Runs a health check against the daemon (does not start it — prints `remnic daemon start` if unreachable).

If you provision tokens manually, write a JSON file at `~/.remnic/tokens.json` in the format:

```json
{
  "tokens": [
    { "connector": "hermes", "token": "remnic_hm_...", "createdAt": "2026-01-01T00:00:00Z" }
  ]
}
```

The plugin searches for a `connector: "hermes"` entry first, then falls back to `connector: "openclaw"`.

## What it does

| Method | Trigger | Behavior |
|--------|---------|----------|
| `initialize` | Plugin loads | Opens an HTTP client to the Remnic daemon and pings `/health`. A failed health check is non-fatal — the daemon may start later. |
| `pre_llm_call` | Before every LLM call | Recalls up to 8 memories using the last user message as the query. Skipped if the user message is fewer than 3 words. Injects a `<remnic-memory>` block into the system prompt when results are found. |
| `sync_turn` | After every response | Sends the last 2 messages (user + assistant) to the Remnic daemon for real-time observation. |
| `extract_memories` | Session ends | Sends the full session transcript to the daemon for deep structured extraction. |
| `on_session_switch` / `on_session_reset` | Hermes session boundary | Keeps generated session keys aligned with the active Hermes session while preserving configured stable keys. |
| `shutdown` | Plugin unloads | Closes the HTTP client. |

## Tools it registers

| Tool name | Description |
|-----------|-------------|
| `remnic_recall` | Recall memories matching a natural language query |
| `remnic_store` | Store a memory explicitly |
| `remnic_search` | Full-text search across all stored memories |
| `remnic_lcm_search` | Search the daemon-side LCM conversation archive |
| `remnic_recall_explain` | Inspect the last recall snapshot |
| `remnic_recall_tier_explain` | Inspect tier attribution for the last direct-answer recall |
| `remnic_recall_xray` | Run recall with X-ray attribution capture |
| `remnic_memory_last_recall` | Fetch the memory IDs injected in the last recall |
| `remnic_memory_intent_debug` | Inspect the latest intent/planner snapshot |
| `remnic_memory_qmd_debug` | Inspect the latest QMD recall snapshot |
| `remnic_memory_graph_explain` | Inspect graph recall expansion from the last recall |
| `remnic_memory_feedback_last_recall` | Record relevance feedback for a recalled memory |
| `remnic_set_coding_context` | Attach coding project context to a session |
| `remnic_memory_get` | Fetch one stored memory by id |
| `remnic_memory_store` | Store a memory with the daemon's richer memory-store schema |
| `remnic_memory_timeline` | Fetch the timeline for one stored memory |
| `remnic_memory_profile` | Read the user profile surface |
| `remnic_memory_entities` | List tracked entities |
| `remnic_memory_questions` | List open memory questions |
| `remnic_memory_identity` | Read identity memory state |
| `remnic_memory_promote` | Promote a memory candidate or stored memory |
| `remnic_memory_outcome` | Record or inspect a memory outcome |
| `remnic_entity_get` | Fetch one tracked entity by name |
| `remnic_memory_capture` | Capture an explicit memory note |
| `remnic_memory_action_apply` | Apply a memory action |
| `remnic_continuity_audit_generate` | Generate a continuity audit report |
| `remnic_continuity_incident_open` | Open a continuity incident |
| `remnic_continuity_incident_close` | Close a continuity incident with verification |
| `remnic_continuity_incident_list` | List continuity incidents by state |
| `remnic_continuity_loop_add_or_update` | Add or update a continuity improvement loop |
| `remnic_continuity_loop_review` | Review an existing continuity improvement loop |
| `remnic_identity_anchor_get` | Read the identity continuity anchor |
| `remnic_identity_anchor_update` | Conservatively merge identity anchor sections |
| `remnic_review_queue_list` | Fetch the latest review queue artifact bundle |
| `remnic_review_list` | List contradiction review items |
| `remnic_review_resolve` | Resolve a contradiction review pair |
| `remnic_suggestion_submit` | Queue a suggested memory for review |
| `remnic_work_task` | Manage work-layer tasks |
| `remnic_work_project` | Manage work-layer projects |
| `remnic_work_board` | Export or import work-layer board snapshots and markdown |
| `remnic_shared_context_write_output` | Write agent work product into shared context |
| `remnic_shared_feedback_record` | Record shared feedback for peer modeling |
| `remnic_shared_priorities_append` | Append priorities notes for curator merge |
| `remnic_shared_context_cross_signals_run` | Generate shared-context cross-signal artifacts |
| `remnic_shared_context_curate_daily` | Generate the daily shared-context roundtable |
| `remnic_compounding_weekly_synthesize` | Generate weekly compounding outputs |
| `remnic_compounding_promote_candidate` | Promote a compounding candidate into durable memory |
| `remnic_compression_guidelines_optimize` | Run compression-guideline policy optimization |
| `remnic_compression_guidelines_activate` | Activate a staged compression-guideline draft |
| `remnic_memory_governance_run` | Run memory governance in shadow or apply mode |
| `remnic_procedure_mining_run` | Run procedural memory mining |
| `remnic_procedural_stats` | Read procedural memory stats |
| `remnic_contradiction_scan_run` | Run an on-demand contradiction scan |
| `remnic_memory_summarize_hourly` | Generate hourly conversation summaries |
| `remnic_conversation_index_update` | Update the conversation index |
| `remnic_day_summary` | Generate a structured end-of-day summary |
| `remnic_briefing` | Generate a daily context briefing |
| `remnic_context_checkpoint` | Save a structured context checkpoint for a session |

During the Engram to Remnic compat window, legacy `engram_*` aliases are also registered for each tool. These route to the same handlers. Their schema descriptions intentionally say "Engram" (not "Remnic") so that tool names and descriptions agree when a language model surfaces the legacy names. The `engram_*` aliases will be removed in a future major release. New integrations should use the `remnic_*` names.

The existing simple `remnic_store` / `engram_store` compatibility tools remain available. Use `remnic_memory_store` / `engram_memory_store` when the caller needs the richer daemon schema.

In practice:

- Automatic recall/observation is always handled by the MemoryProvider hooks.
- Use explicit tools when Hermes needs to search a different query, write a specific fact, inspect recall attribution, search LCM directly, curate memory, manage continuity/work-board state, create a checkpoint, or generate reports.
- Lossless Context Management does not require Hermes `context_engine`; LCM results arrive through the daemon recall envelope when enabled in Remnic.

## Profiles and namespaces

Hermes isolates agent state per profile under `~/.hermes/profiles/<name>/`. Each profile loads its own `config.yaml`, so you can run separate `remnic:` blocks with different `session_key` values to keep memory contexts distinct. See [docs/plugins/hermes.md](../../docs/plugins/hermes.md) for a worked example.

## Verify it is working

```bash
hermes --version && pip show remnic-hermes
```

Then start a session and call `remnic_recall` with a short phrase. If the daemon is healthy you will get a JSON response; if memories exist for that query they will appear in the `context` field. You can also check `<remnic-memory>` blocks in the Hermes debug log to confirm automatic recall is firing on each turn.

## Troubleshooting

**Daemon not running**

```bash
remnic daemon status
remnic daemon install    # installs and starts the launchd/systemd service
```

**Token missing — calls return 401**

Check that `~/.remnic/tokens.json` exists and contains a `hermes` connector entry. Re-running `remnic connectors install hermes` regenerates the token and re-writes the file.

```bash
cat ~/.remnic/tokens.json
```

**Import error — `ModuleNotFoundError: No module named 'remnic_hermes'`**

The package must be installed in the same Python environment Hermes uses:

```bash
which python && pip show remnic-hermes
hermes --version
```

If they differ, install into the correct environment: `<path-to-hermes-python> -m pip install --upgrade remnic-hermes`.

**Memories not appearing in context**

Memories are only injected when the last user message is 3 or more words and the daemon is reachable. Check daemon health first, then verify the query length. You can force a manual recall via the tool to confirm the round-trip works:

```bash
remnic daemon status
```

## Uninstall

```bash
pip uninstall remnic-hermes
remnic connectors remove hermes
```

`remnic connectors remove hermes` revokes the token and removes the config entry from Hermes `config.yaml`.

## LCM in Hermes

`remnic_lcm_search` searches the Remnic daemon's Lossless Context Management archive on demand. The legacy `engram_lcm_search` alias is registered for existing Engram-era Hermes configurations.

LCM runs daemon-side and reaches Hermes through the `memory_provider` recall path. Remnic does not register, and does not need, a Hermes `context_engine` slot for this feature.

## Further reading

- [Full reference: docs/plugins/hermes.md](../../docs/plugins/hermes.md) — complete config schema, recall/observe/extract internals, profile isolation examples, and migration notes from the Engram era.
- [Remnic repository](https://github.com/joshuaswarren/remnic) — daemon installation and overall architecture.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — the agent framework this plugin extends.

## License

MIT
