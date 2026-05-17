# @remnic/plugin-openclaw

OpenClaw plugin for Remnic memory and context. The package bundles the OpenClaw adapter plus the Remnic core runtime so it can run without a separate Remnic service; the adapter registers OpenClaw hooks/tools and delegates memory behavior to [`@remnic/core`](https://www.npmjs.com/package/@remnic/core).

Part of [Remnic](https://github.com/joshuaswarren/remnic), open-source memory and context for user-aware agents.

## Install

```bash
openclaw plugins install clawhub:@remnic/plugin-openclaw
```

Or ask your OpenClaw agent:

> Install the @remnic/plugin-openclaw ClawHub plugin and configure it as my memory system.

## Configure

Add the plugin to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-remnic"],
    "slots": { "memory": "openclaw-remnic" },
    "entries": {
      "openclaw-remnic": {
        "package": "@remnic/plugin-openclaw",
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

Then restart the gateway:

```bash
launchctl kickstart -k gui/501/ai.openclaw.gateway
```

## Benchmarking The OpenClaw Chain

The benchmark CLI can now exercise the real OpenClaw-backed answer path instead
of only the stripped retrieval harness. Use the `openclaw-chain` runtime
profile to load the Remnic plugin config from `openclaw.json`, route answer
generation through the configured gateway chain, and optionally attach a
provider-backed judge:

```bash
remnic bench run longmemeval \
  --runtime-profile openclaw-chain \
  --openclaw-config ~/.openclaw/openclaw.json \
  --gateway-agent-id memory-primary

remnic bench run longmemeval \
  --runtime-profile openclaw-chain \
  --openclaw-config ~/.openclaw/openclaw.json \
  --gateway-agent-id memory-primary \
  --judge-provider openai \
  --judge-model gpt-5.4-mini
```

To compare the stripped harness, direct Remnic runtime, and OpenClaw chain in a
single pass, run a profile matrix:

```bash
remnic bench run longmemeval \
  --matrix baseline,real,openclaw-chain \
  --openclaw-config ~/.openclaw/openclaw.json \
  --remnic-config ~/.config/remnic/config.json
```

Each stored result records its `runtimeProfile`, provider metadata, and the
resolved Remnic config so benchmark comparisons can distinguish retrieval-only
runs from real runtime and OpenClaw chain runs.

## What it does

This plugin hooks into the OpenClaw gateway lifecycle:

- **`gateway_start`** -- initializes the Remnic memory engine
- **`before_agent_start`** / **`before_prompt_build`** -- adds relevant memories to the agent context through OpenClaw's memory context builders
- **`agent_end`** -- buffers the conversation turn for extraction
- **`before_compaction`** / **`after_compaction`** -- saves checkpoints and triggers session reset on context compaction
- **`before_reset`** -- bounded flush of the in-flight buffer before OpenClaw discards a session
- **`api.registerCommand()`** -- exposes Remnic slash-command descriptors to the command palette
- **`session_start`** / **`session_end`** -- session lifecycle tracking
- **`before_tool_call`** / **`after_tool_call`** -- tool usage observation for analytics
- **`llm_output`** -- LLM token usage tracking
- **`subagent_spawning`** / **`subagent_ended`** -- subagent lifecycle observation
- **Tools** -- registers `memory_search`, `memory_get`, `memory_stats`, and other agent tools
- **Commands** -- provides CLI commands for memory management

All memory processing uses [`@remnic/core`](https://www.npmjs.com/package/@remnic/core). Memory files stay on your local filesystem as plain markdown files. When the plugin is configured to use OpenAI, an OpenAI-compatible endpoint, or provider credentials resolved from OpenClaw runtime auth, conversation and memory excerpts may be sent to that configured model provider for extraction, consolidation, summarization, embeddings, active recall, or benchmark judging. Use `modelSource: "gateway"` and route the gateway agent to local or otherwise approved models when those operations should stay on your own OpenClaw/local model path.

Credential and model-provider behavior is explicit:

- `modelSource: "gateway"` is the recommended OpenClaw mode and uses OpenClaw gateway agents instead of a Remnic-owned API key.
- Plugin/provider modes may read configured model credentials from the OpenClaw auth resolver, OpenClaw's materialized provider config at `~/.openclaw/agents/main/agent/models.json`, or provider-specific environment variables such as `<PROVIDER>_API_KEY` and `<PROVIDER>_TOKEN`.
- Do not set `openaiApiKey` or provider environment variables for Remnic if you want all LLM-backed memory work routed through the gateway.

The npm package also declares this surface in `package.json` under
`openclaw.environment` so ClawHub and other registries can show the optional
provider env vars, config path, and external-model routing behavior before
installation.

## Privacy Boundary

OpenClaw hook runtime metadata such as authorization headers, API keys, provider
credential objects, and bearer tokens is operational metadata. Remnic does not
persist those fields to transcripts, extraction buffers, recall audit entries,
logs, or memory content.

User-authored message text is different: Remnic is a memory plugin, so message
content can be stored, extracted, summarized, embedded, or recalled according to
the configured memory policy. Do not paste secrets into chat when you do not
want them treated as conversation content.

## Plugin Inspection

Run the OpenClaw plugin inspector with:

```bash
npm run plugin:inspect
npm run plugin:inspect:runtime
```

The inspector gate covers the static OpenClaw adapter manifest, hook, tool, and
service surfaces. Some registrations are intentionally casted or dynamically
guarded in the adapter, including `registerMemoryCapability`, `registerCli`,
and `registerCommand`; keep runtime capture coverage for those surfaces in a
separate adapter test slice.

Run the deterministic OpenClaw adapter scenario suite with:

```bash
npm run test:openclaw-scenarios
```

The suite covers the registered memory tools and lifecycle hooks without live
OpenClaw, LLM credentials, or network calls.

Run the OpenClaw hook privacy suite with:

```bash
npm run test:openclaw-privacy
```

The suite guards against runtime auth metadata leaking into persisted memory,
transcript, recall-audit, or debug-log surfaces.

## SDK Surface Drift Check

The adapter keeps a conservative OpenClaw SDK surface snapshot at
`openclaw-sdk-surface.expected.json`. Run
`npm run check:openclaw-sdk-surface` after changing OpenClaw dependencies or
with `-- --package-root <path>` to check a local OpenClaw checkout. When an
upstream SDK change is intentional, review the adapter impact first, then
refresh the snapshot with `npm run check:openclaw-sdk-surface -- --write`.
CI jobs that provision OpenClaw should use
`npm run check:openclaw-sdk-surface:required` or pass
`-- --require --package-root <path>` so a missing SDK fails instead of skipping.

Last compatibility sweep: May 16, 2026. The SDK surface check passed against
`openclaw@2026.5.3`, `openclaw@2026.5.3-1`, `openclaw@2026.5.4-beta.1`,
`openclaw@2026.5.4-beta.2`, `openclaw@2026.5.4-beta.3`,
`openclaw@2026.5.4`, `openclaw@2026.5.5`, `openclaw@2026.5.6`,
`openclaw@2026.5.16-beta.2`, `openclaw@2026.5.16-beta.3`, and
`openclaw@2026.5.16-beta.4`.
Keep the peer range broad unless an upstream release removes a runtime surface
Remnic actively uses.

OpenClaw 2026.5.16 package-entry discovery prefers explicit built runtime
entries for installed packages. The published Remnic adapter declares
`openclaw.runtimeExtensions: ["./dist/index.js"]` alongside the existing
extension entry, and its package install metadata advertises
`openclaw.install.clawhubSpec: "clawhub:@remnic/plugin-openclaw"`,
`openclaw.install.npmSpec: "@remnic/plugin-openclaw"`, and
`openclaw.install.defaultChoice: "clawhub"`. That keeps OpenClaw setup,
repair, and update flows ClawHub-first while preserving npm as the fallback
install surface and `>=2026.5.16-beta.1` as the minimum supported host range.
The manifest also declares `activation.onStartup: false`, leaves provider
ownership to the host, exposes the optional plugin-mode OpenAI key through
`providerAuthChoices`, and keeps `providerAuthEnvVars.openai` as compatibility
metadata for OpenClaw's pre-runtime env-var auth probes.

OpenClaw 2026.5.16-beta.3 keeps those install and auth ownership contracts
intact. The sweep confirmed that Remnic still relies on host-owned gateway
restart/reload behavior after plugin install changes, uses `gateway_stop`
instead of the deprecated `deactivate` cleanup alias, and should not claim
OpenAI `setup.providers` ownership because gateway/provider configuration
remains host-owned.

OpenClaw 2026.5.16-beta.4 treats `setup.providers[].id` as provider ownership
metadata with globally unique ids. Remnic does not own the `openai` provider,
so the canonical manifest keeps OpenAI API-key metadata on `providerAuthChoices`
and the compatibility `providerAuthEnvVars.openai` surface instead of declaring
`setup.providers`.

Native memory registrars are tracked separately in
[`docs/plugins/openclaw-native-memory-registrars.md`](../../docs/plugins/openclaw-native-memory-registrars.md).
That spike explains why Remnic currently uses `registerMemoryCapability()` as
the primary integration point instead of OpenClaw embedding, corpus supplement,
or compaction-provider registrars.

## Slot Selection

Remnic is an exclusive memory-slot plugin. When `plugins.slots.memory` points
to another plugin, Remnic now validates that mismatch and either errors or
loads passively depending on `slotBehavior`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "slotBehavior": {
            "requireExclusiveMemorySlot": true,
            "onSlotMismatch": "error"
          }
        }
      }
    }
  }
}
```

Passive mode keeps the tool/service surface available but skips context-building
and extraction hooks so two memory plugins do not race each other.

## Supported OpenClaw Memory Features

Remnic supports the following OpenClaw memory integration points:

### Memory Context Sections

| Feature | Status | Since |
|---------|--------|-------|
| `before_agent_start` hook (legacy) | Supported | 2025.x |
| `before_prompt_build` hook (new SDK) | Supported | 2026.3.22 |
| `registerMemoryPromptSection()` (structured builder) | Supported | 2026.3.22 |
| `registerMemoryCapability()` (unified capability) | Supported | 2026.4.5 |
| `registerMemoryRuntime()` (split runtime surface) | Supported | 2026.4.x |
| `registerMemoryFlushPlan()` (split flush-plan surface) | Supported | 2026.4.x |
| `registerMemoryCorpusSupplement()` (read-only corpus supplement) | Supported | 2026.4.x |

On current OpenClaw SDKs, Remnic registers both the unified memory capability
and the compatible split surfaces. That lets OpenClaw consume Remnic through
the active memory runtime, the explicit flush-plan resolver, and additive
corpus search/read APIs without changing Remnic's ownership of storage,
retrieval, extraction, and QMD behavior.

### Public Artifacts (memory-wiki bridge)

| Feature | Status | Since |
|---------|--------|-------|
| `publicArtifacts.listArtifacts()` | Supported | 2026.4.5 |

When `registerMemoryCapability` is available, Remnic registers a `publicArtifacts` provider that exposes wiki-safe memory files:

- **facts/** -- extracted knowledge (dated subdirectories)
- **entities/** -- entity knowledge graph
- **corrections/** -- fact corrections
- **artifacts/** -- structured artifacts
- **profile.md** -- agent identity summary

Private runtime state (state/, questions/, transcripts/, archive/, buffers) is never exposed.

With this feature, `openclaw wiki status` reports Remnic artifacts, and `memory-wiki` bridge mode can discover and ingest them.

The corpus supplement exposes read-only search/get access to Remnic memories as
the `remnic` corpus under a service-scoped supplement ID. It does not expose
private plugin state, transcript buffers, auth metadata, or artifact paths.

### Session Lifecycle

| Feature | Status | Since |
|---------|--------|-------|
| `session_start` / `session_end` hooks | Supported | 2026.3.22 |
| `before_compaction` / `after_compaction` hooks | Supported | 2026.3.22 |
| `before_reset` hook | Supported | 2026.4.10 |
| `api.registerCommand()` runtime discovery | Supported | 2026.5.16 |
| `api.resetSession()` (compaction reset) | Supported | 2026.3.22 |
| Checkpoint saves before compaction | Supported | 2026.3.22 |

Reset handling is configurable:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "flushOnResetEnabled": true,
          "beforeResetTimeoutMs": 2000,
          "initGateTimeoutMs": 30000
        }
      }
    }
  }
}
```

The reset path clears per-session context caches and workspace preference state.
If `flushOnResetEnabled` is true, Remnic also attempts a bounded extraction
flush before the reset completes.

`initGateTimeoutMs` controls Remnic's cold-start init wait during recall and is
registered as the `before_prompt_build` hook timeout on OpenClaw versions with
per-hook timeout support. Raise it if first-turn recall is timing out during
slow startup; older OpenClaw versions ignore the extra hook option safely.

Session-scoped recall controls are exposed through OpenClaw's
`api.registerCommand()` surface when it is available:

- `remnic off` / `remnic on`
- `remnic status`
- `remnic clear`
- `remnic stats`
- `remnic flush`

When verbose mode is enabled, Remnic prints its recall decision header inline
and can optionally persist JSONL recall transcripts under
`<memoryDir>/state/plugins/openclaw-remnic/transcripts/`.

### Observation Hooks

| Feature | Status | Since |
|---------|--------|-------|
| `before_tool_call` / `after_tool_call` | Supported | 2026.3.22 |
| `llm_output` (token tracking) | Supported | 2026.3.22 |
| `subagent_spawning` / `subagent_ended` | Supported | 2026.3.22 |

### Dreaming

OpenClaw's dreaming feature (background memory consolidation) is handled by OpenClaw's built-in `memory-core` extension. Remnic implements its own consolidation pipeline (extraction, deduplication, graph maintenance, hourly summaries) that runs independently of OpenClaw's dreaming system. The two systems are complementary -- Remnic's consolidation handles the heavy memory extraction, while OpenClaw's dreaming (if enabled alongside Remnic) can further organize knowledge.

The plugin manifest now accepts the OpenClaw `dreaming` config block directly
so newer runtimes do not reject the config at validation time, and the OpenClaw
adapter now adds recent diary entries as `## Recent Dreams (Remnic)` when
the journal contains entries. The adapter also imports `DREAMS.md` entries into
Remnic storage as `memoryKind: "dream"` with stable provenance so file-watch
replays stay idempotent:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "dreaming": {
            "enabled": false,
            "journalPath": "DREAMS.md",
            "maxEntries": 500,
            "injectRecentCount": 3,
            "minIntervalMinutes": 120,
            "narrativeModel": "gpt-5.2",
            "narrativePromptStyle": "reflective",
            "watchFile": true
          }
        }
      }
    }
  }
}
```

When Remnic's consolidation pass produces a reflective multi-session summary and
the interval gate is satisfied, the OpenClaw adapter appends a new dream entry
back to `DREAMS.md` through the shared writer using the OpenAI Responses API.

The shared `@remnic/core` surface parsers also understand `HEARTBEAT.md`. The
OpenClaw adapter imports those entries as `memoryKind: "procedural"`, gates
normal recall during heartbeat-triggered runs, adds the active heartbeat plus
`## Previous Runs`, and skips episodic buffering for heartbeat turns by default.
Detection can use explicit runtime metadata, a documented heuristic fallback, or
`auto` to prefer runtime metadata and fall back when needed. All of that logic
stays in the OpenClaw adapter; standalone/core remains host-agnostic.

## Codex Compatibility

Remnic now advertises and parses a dedicated `codexCompat` block for bundled
Codex-provider safety work:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "codexCompat": {
            "enabled": false,
            "threadIdBufferKeying": true,
            "compactionFlushMode": "auto",
            "fingerprintDedup": true
          }
        }
      }
    }
  }
}
```

`codexCompat.enabled` defaults to `false`, so operators only opt into bundled
Codex thread buffering and compaction behavior when they explicitly enable it.

This governs Remnic's own buffering and extraction behavior only. Remnic still
uses its own extraction auth path; OpenClaw's bundled Codex provider auth does
not replace Remnic's extraction credentials.

### Bridge Mode

| Feature | Status |
|---------|--------|
| Embedded mode (in-process EMO + HTTP :4318) | Supported |
| Delegate mode (connects to running daemon) | Supported |
| Auto-detection (daemon running = delegate) | Supported |

## Standalone usage

If you're not using OpenClaw, use [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) or [`@remnic/server`](https://www.npmjs.com/package/@remnic/server) instead.

## License

MIT
