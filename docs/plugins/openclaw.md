# OpenClaw Plugin

`@remnic/plugin-openclaw` is the OpenClaw bridge for Remnic. It is the
canonical memory-slot plugin id `openclaw-remnic`; the older
`openclaw-engram` id is now a compatibility shim.

The OpenClaw plugin is Remnic's OpenClaw-specific adapter. It should stay thin: Remnic core owns memory behavior, while this package translates that behavior into OpenClaw's current plugin SDK and runtime contracts.

Canonical upstream references for this adapter:

- OpenClaw repository: <https://github.com/openclaw/openclaw>
- OpenClaw plugin docs: <https://github.com/openclaw/openclaw/tree/main/docs/plugins>
- OpenClaw SDK overview: <https://github.com/openclaw/openclaw/blob/main/docs/plugins/sdk-overview.md>
- OpenClaw SDK entrypoints: <https://github.com/openclaw/openclaw/blob/main/docs/plugins/sdk-entrypoints.md>
- OpenClaw SDK runtime guide: <https://github.com/openclaw/openclaw/blob/main/docs/plugins/sdk-runtime.md>

## Install

```bash
openclaw plugins install clawhub:@remnic/plugin-openclaw
```

OpenClaw 2026.5.30-beta.1 changed the launch-cutover behavior so bare plugin
package names are npm-first in some install paths. Remnic is published on
ClawHub as `@remnic/plugin-openclaw` under the `remnic` publisher, so the
explicit `clawhub:` prefix keeps fresh installs deterministic. For npm-only
fallback or rollback versions, use the explicit `npm:` source prefix, such as
`npm:@remnic/plugin-openclaw@<version>`.

Or use the Remnic installer:

```bash
remnic openclaw install
```

If you are migrating from the legacy `@joshuaswarren/openclaw-engram` package,
use the dedicated migration guide and command:

```bash
remnic openclaw migrate-engram --yes
```

See [OpenClaw Engram to Remnic migration](../guides/openclaw-engram-to-remnic.md)
for config-key behavior, backup behavior, and local patch preservation notes.

## Publish to ClawHub

Publish ClawHub releases from the built npm/ClawPack tarball, not from the raw
GitHub source folder. Source-folder publishing does not run the package build,
so ClawHub can scan an incomplete three-file artifact with no `dist/index.js`.
The ClawHub listing is `@remnic/plugin-openclaw` and is owned by the
`remnic` publisher. Publish it with an authenticated account that can publish
to the `remnic` publisher, and pass `--owner remnic` when publishing manually.

```bash
pnpm --filter @remnic/plugin-openclaw build
pnpm run verify:openclaw-clawpack
clawhub package pack packages/plugin-openclaw --pack-destination /tmp/remnic-clawpack
clawhub package publish /tmp/remnic-clawpack/remnic-plugin-openclaw-<version>.tgz \
  --family code-plugin \
  --name @remnic/plugin-openclaw \
  --owner remnic \
  --display-name "Remnic OpenClaw Plugin" \
  --version <version> \
  --source-repo joshuaswarren/remnic \
  --source-ref v<release-version> \
  --source-commit <release-commit> \
  --source-path packages/plugin-openclaw
```

## Configure

Minimal configuration:

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

The plugin only runs actively when `plugins.slots.memory` points at its own
plugin id.

## Compatibility Policy

Remnic supports OpenClaw releases from at least the previous 60 days. As of
May 31, 2026, that window starts on April 1, 2026. The OpenClaw installer
floor remains the single supported `>=2026.4.1` shape, while the peer and
plugin-API compatibility ranges explicitly include reviewed prerelease hosts in
that window. The adapter records `2026.5.31-beta.2` as the latest reviewed
build target.

When OpenClaw adds a new manifest or setup surface, Remnic should add that new
surface without dropping older metadata that still helps hosts inside the
60-day window. Only raise the compatibility floor when an upstream breaking
change makes the older host impossible to support, and document the exception
in this file and the agent-facing notes.

## Architecture Rule

Do not move OpenClaw-specific contracts into `@remnic/core`. The OpenClaw adapter should consume core contracts and map them onto OpenClaw. When OpenClaw already has a native command surface, tool registration path, memory lifecycle hook, or plugin manifest feature, use that upstream primitive instead of inventing a duplicate Remnic abstraction.

## Slot Selection

Remnic now validates the OpenClaw memory-slot selection at registration time.
The behavior is controlled by `slotBehavior`:

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

- `onSlotMismatch: "error"` throws an actionable startup error.
- `onSlotMismatch: "warn"` loads passively and logs one warning.
- `onSlotMismatch: "silent"` loads passively with no warning.

Passive mode still registers tools and the service surface, but it skips
prompt-injection and extraction hooks so Remnic does not compete with the
selected memory plugin.

Memory files stay on your local filesystem as plain markdown files. If Remnic
is configured to use OpenAI or an OpenAI-compatible endpoint, conversation and
memory excerpts may be sent to that provider for extraction, consolidation,
summarization, and embeddings. Use `modelSource: "gateway"` or local LLM
settings when those operations should stay on your own OpenClaw/local model
path.

## Runtime Surfaces

OpenClaw runtime surfaces currently wired by the plugin:

- `before_prompt_build` / `before_agent_start` for memory injection
- `agent_end` for buffered extraction
- `before_compaction` / `after_compaction` for checkpoint and reset flows
- `before_reset` for reset-time bounded buffer flush and session cleanup
- `api.registerCommand()` for slash-command discovery metadata
- `session_start` / `session_end`
- `before_tool_call` / `after_tool_call`
- `llm_output`
- `subagent_spawning` / `subagent_ended`

The plugin manifest advertises compatibility on current and older OpenClaw
surfaces:

- `kind: "memory"` declares Remnic as an exclusive memory-slot plugin.
- `supports` remains as compatibility metadata for OpenClaw 2026.4 and early
  2026.5 slot/lifecycle routing. Current OpenClaw ignores it for contract
  promotion, but older hosts can still use it to discover the memory-slot,
  active-memory, heartbeat, command, and reset surfaces.
- `contracts.tools` declares every Remnic-owned tool name for OpenClaw 2026.5+
  descriptor planning and tool ownership validation.
- `setup.requiresRuntime: false` is explicit so setup/onboarding can use
  descriptor metadata without executing Remnic runtime code.
- `setup.providers[].envVars` mirrors the optional plugin-mode `OPENAI_API_KEY`
  signal for OpenClaw's current generic auth/status lookup path.
- `activation.onStartup: false` is explicit so startup activation remains
  intentional.
- `providerAuthChoices` advertises the optional plugin-mode OpenAI API key
  for onboarding and CLI surfaces.
- `providerAuthEnvVars.openai` remains as compatibility metadata for older
  OpenClaw pre-runtime auth probes. It is mirrored by
  `setup.providers[].envVars`, which suppresses the current deprecation
  diagnostic while preserving older host behavior.
- `securityDisclosure` is intentionally documented here instead of shipped as a
  manifest field; current OpenClaw native manifests do not list it.
- OpenClaw 2026.5.20-beta.2 through 2026.5.31-beta.2 keep Remnic's SDK hook,
  tool-contract, memory-slot, ClawHub install, gateway model, and security-scan
  surfaces compatible. Remnic stays on the full `definePluginEntry` SDK path
  instead of the simple `defineToolPlugin` helper because the adapter combines
  memory-slot hooks, lifecycle handlers, command metadata, public artifacts,
  and runtime tools. The package metadata records `2026.5.31-beta.2` as the
  reviewed OpenClaw build target while keeping the broad stable and prerelease
  peer/plugin-API range required by Remnic's rolling 60-day support policy.
  `openclaw.install.minHostVersion` remains the single `>=2026.4.1` floor that
  OpenClaw setup expects.

Keep `contracts.tools` complete. OpenClaw 2026.5 rejects plugin tool
registration when a runtime tool is missing from the manifest contract.

### 2026.5.31 Compatibility Sweep

Issues #1203 through #1237 and follow-up release issues #1241 and #1242 were
reviewed as one compatibility window. The merged offline-sync and QMD issues in
that range are already present on `main`; the remaining OpenClaw sentinel issues
converge on the latest upstream contract:

- SDK surface: `npm run check:openclaw-sdk-surface -- --package-root
  /tmp/openclaw-2026.5.31-beta.2` passes with the existing snapshot
  (`14 registrars, 22 hooks, 2 manifest contracts`).
- Plugin scanner: OpenClaw `2026.5.31-beta.2`'s packaged scanner passes with
  `scanned=20 critical=0 warn=0` for `packages/plugin-openclaw`.
- New host features: OpenClaw beta.2 adds `configSignals.overlayMapPath`, SMS
  channel docs, native Codex first-party marketplace docs, and provider usage /
  no-auth media provider clarifications. Remnic does not need new runtime code
  for those host features, and keeps its existing config signals and gateway
  provider delegation intact.
- Install/source resolution: document explicit
  `openclaw plugins install clawhub:@remnic/plugin-openclaw` because bare names
  can be npm-first during the OpenClaw launch cutover.
- Auth metadata: use `setup.providers[].envVars` plus
  `providerAuthChoices`, and keep `providerAuthEnvVars` mirrored for older
  OpenClaw auth probes.
- Manifest shape: keep `kind: "memory"`, `contracts.tools`, `commandAliases`,
  `activation`, and the legacy `supports` compatibility block; do not restore
  unsupported top-level `securityDisclosure`.
- Compatibility window: keep package ranges at or below the active 60-day
  floor and explicitly list reviewed prerelease hosts in peer/plugin-API ranges
  because default npm semver range checks exclude prereleases. Keep installer
  `minHostVersion` as a single floor. On May 31, 2026 that floor is OpenClaw
  `2026.4.1`.
- Runtime behavior: Remnic core semantics remain in `@remnic/core`; the
  OpenClaw adapter only translates hooks, commands, memory-slot behavior, and
  gateway/provider metadata.

## Reset Flush Contract

When OpenClaw resets a session (`/new`, `/reset`, or programmatic reset),
Remnic attempts to flush that session's buffered turns before the runtime
discards them.

Relevant settings:

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

- `flushOnResetEnabled=false` skips extraction flush but still clears
  session-scoped caches.
- `beforeResetTimeoutMs` bounds how long Remnic will wait before returning
  control to OpenClaw. Timeout is fail-open: reset continues even if the flush
  path is slow.
- `initGateTimeoutMs` bounds Remnic's cold-start init wait during recall and is
  also registered as the `before_prompt_build` hook timeout on OpenClaw versions
  that support per-hook options. Increase it for slow first-turn startup on
  OpenClaw 2026.5.2+; older OpenClaw builds ignore the hook option safely.

Reset cleanup currently clears:

- precomputed prompt-section recall cache for the session
- per-session recall workspace override state

## Command Discovery

Remnic registers the current command descriptor group through OpenClaw's
`api.registerCommand()` surface:

- `remnic off`
- `remnic on`
- `remnic status`
- `remnic clear`
- `remnic stats`
- `remnic flush`

This is discovery metadata for the command palette and help surfaces. When
`registerCommand` is unavailable, Remnic logs the missing surface instead of
registering `commands.list` as a typed hook. The handlers are live:

- `remnic off` / `remnic on` write the session toggle store
- `remnic status` reports current toggle source and the last recall summary
- `remnic clear` removes the session override so global config wins again
- `remnic stats` reports planner mode, latency, and memory count for the last recall
- `remnic flush` forces a bounded session flush through Remnic's extraction buffer

## Dreaming and Heartbeat

OpenClaw v2026.4.10 introduced slot-aware dreaming and heartbeat routing for
memory plugins. Remnic now accepts the `dreaming` config block in its manifest
schema, reads `DREAMS.md` diary entries through the shared surface parser, and
injects the most recent entries as a distinct `## Recent Dreams (Remnic)` block
ahead of the main memory context when dreaming is enabled. The OpenClaw adapter
also round-trips those entries into Remnic storage as `memoryKind: "dream"` and
preserves provenance metadata so a Remnic-written dream is re-read idempotently
instead of being re-indexed as a fresh memory on the next watch cycle.

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
            "narrativeModel": "gpt-5.5",
            "narrativePromptStyle": "reflective",
            "watchFile": true
          }
        }
      }
    }
  }
}
```

When consolidation produces a cross-session reflective summary and the
`minIntervalMinutes` gate is satisfied, Remnic now appends a new `DREAMS.md`
entry through the shared surface writer using the OpenAI Responses API. This is
adapter-only behavior; standalone/core still has no dependency on OpenClaw's
journal files.

Heartbeat support is also advertised in the manifest and now does more than
schema validation. The shared `packages/remnic-core/src/surfaces/heartbeat.ts`
parser reads `HEARTBEAT.md` task files and upstream-style `tasks:` sections,
then the OpenClaw adapter imports them into storage as
`memoryKind: "procedural"` with `source: "heartbeat.md"`. During heartbeat
runs, Remnic gates normal recall, injects the active heartbeat entry, and adds a
`## Previous Runs` block from memories tagged with the same
`relatedHeartbeatSlug`. By default it also skips episodic buffering and active
recall transcript writes for heartbeat-triggered turns.

Detection mode is configurable:

- `runtime-signal`: only trust explicit OpenClaw heartbeat routing metadata
- `heuristic`: treat `Read HEARTBEAT.md ...` prompts as v1 heartbeat runs even
  when the runtime does not expose a signal yet
- `auto`: prefer runtime signals and fall back to the heuristic path

The heuristic path is intentionally adapter-only and documented as a bridge for
current OpenClaw runtime behavior, not a new core contract.

Recent-dream injection respects session toggles and the new active-recall
surface. When the OpenClaw runtime uses `registerMemoryPromptSection`, Remnic
returns the dreams/verbose/active-recall context through `before_prompt_build`
and keeps the structured memory section itself isolated in the prompt-section
builder, so the gateway does not double-inject memory text.

## Active Recall

Remnic ships its own active-recall sub-agent surface for OpenClaw. This is
separate from the bundled `active-memory` plugin and should be treated as the
default active-recall path when you want Remnic to own both retrieval and the
summary block injected into the prompt.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "activeRecallEnabled": true,
          "activeRecallAllowChainedActiveMemory": false
        }
      }
    }
  }
}
```

Behavior contract:

- `activeRecallEnabled=true` enables the Remnic-native active-recall summary
  block.
- `activeRecallAllowChainedActiveMemory=false` does **not** disable Remnic
  active recall. It only means Remnic should not layer itself on top of the
  bundled `active-memory` surface.
- When the bundled `active-memory` plugin is enabled for the same agent and
  chaining is disabled, Remnic suppresses its own active-recall block and logs
  a warning instead of double-injecting competing active-memory summaries.
- Set `activeRecallAllowChainedActiveMemory=true` only when you intentionally
  want Remnic active recall to chain through the bundled `active-memory`
  surface as well.
- Planner `no_recall` mode still suppresses the auxiliary active-recall block
  regardless of chaining settings.

Practical guidance:

- Use Remnic active recall by itself when `openclaw-remnic` owns the memory
  slot and you want one memory system to control recall behavior end to end.
- Keep the bundled `active-memory` plugin disabled for the same agent unless
  you have a deliberate compatibility reason to layer both systems.
- If you do layer them, make that explicit with
  `activeRecallAllowChainedActiveMemory=true` so the behavior is intentional
  and reviewable.

## Codex Compatibility

The plugin now exposes a dedicated `codexCompat` config block:

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

`codexCompat.enabled` is opt-in and defaults to `false`, so the compatibility
path only activates for deployments that explicitly enable bundled Codex
thread handling. The intent of this block is to make Remnic's extraction
buffering safe under Codex-managed threads and compaction without changing
non-Codex provider behavior.

Behavior contract:

- `enabled=true` turns on the bundled Codex compatibility path only for Codex
  provider sessions. Claude, GPT, local, and other providers keep the
  pre-existing session-keyed behavior.
- `threadIdBufferKeying=true` collapses multiple OpenClaw `sessionKey`s that
  share the same Codex provider thread into one logical buffer key
  (`codex-thread:<providerThreadId>`). This prevents per-session buffer
  divergence for one Codex-managed conversation.
- `compactionFlushMode=signal` flushes the pending logical-thread buffer in
  `before_compaction`, before Codex-managed history replacement lands.
- `compactionFlushMode=heuristic` is a v1 fallback: if the runtime does not
  expose an explicit compaction signal, Remnic treats a sudden drop in Codex
  thread message count as compaction and forces a flush on the next
  `before_prompt_build`.
- `compactionFlushMode=auto` prefers the explicit compaction signal path and
  only falls back to the heuristic path when needed.
- `fingerprintDedup=true` persists processed Codex extraction fingerprints in
  Remnic state so the same logical turn set is not re-extracted when it is
  replayed through a second OpenClaw session for the same Codex thread.
- Reset and compaction cleanup clear both the raw per-session prompt cache and
  the Codex thread alias cache so precomputed recall text cannot leak across
  compaction boundaries.

Important clarification: Remnic's extraction pipeline still uses its own
Responses API auth path. Bundled Codex provider auth in OpenClaw does not
replace or proxy Remnic's extraction credentials.

## Public Artifacts

When `registerMemoryCapability()` is available, Remnic publishes a
`publicArtifacts` provider so OpenClaw and memory-wiki surfaces can enumerate
safe memory files such as:

- `facts/`
- `entities/`
- `corrections/`
- `artifacts/`
- `profile.md`

Private runtime state is excluded.

## Troubleshooting

If hooks are not firing:

1. Confirm the plugin is installed under `openclaw-remnic`.
2. Confirm `plugins.slots.memory` points to `openclaw-remnic`.
3. Check the gateway log for a slot-selection error or passive-mode warning.

```bash
grep -i remnic ~/.openclaw/logs/gateway.log | tail -50
```

If you are migrating from the older `openclaw-engram` id, install the
canonical package and keep the shim only as a temporary compatibility layer.
