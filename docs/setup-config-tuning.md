# Setup, configuration, and tuning

This is the operator runbook for tuning Remnic beyond its shipped defaults. Remnic works well out of the box, so reach for this guide when you are self-hosting, running multi-agent or namespaced deployments, or trading off recall budget, retention, cost, and latency. Every example targets the OpenClaw plugin surface (`openclaw.json`); standalone operators can set the same keys in `remnic.config.json` and use `remnic doctor` / `remnic config` in place of the `openclaw engram` commands shown here.

Start every tuning pass with the built-in diagnostics:
- Run `openclaw engram setup --json` after first install or after moving memory/workspace paths.
- Run `openclaw engram config-review --json` to compare your active config with shipped defaults and recommended settings.
- Run `openclaw engram doctor --json` to catch misconfigurations, missing dependencies, and runtime health problems before blaming recall quality on the model.

## 1) Enable Plugin + Core Config

In `openclaw.json` (the current plugin id is `openclaw-remnic`; installs created before the rename may still use the legacy `openclaw-engram` id, which Remnic continues to read):

```jsonc
{
  "plugins": {
    "allow": ["openclaw-remnic"],
    "slots": { "memory": "openclaw-remnic" },
    "entries": {
      "openclaw-remnic": {
        "enabled": true,
        "config": {
          "openaiApiKey": "${OPENAI_API_KEY}",
          "model": "gpt-5-mini",

          "localLlmEnabled": true,
          "localLlmUrl": "http://127.0.0.1:1234/v1",
          "localLlmModel": "qwen3-coder-30b-a3b-instruct-mlx@4bit",
          "localLlmApiKey": "${LOCAL_LLM_API_KEY}",
          "localLlmHeaders": { "X-Endpoint-Role": "engram" },
          "localLlmAuthHeader": true,
          "localLlmFallback": true,
          "localLlmHomeDir": "~",
          "localLmsCliPath": "~/.cache/lm-studio/bin/lms",
          "localLmsBinDir": "~/.cache/lm-studio/bin",
          "localLlmMaxContext": 4096,
          "qmdPath": "/opt/homebrew/bin/qmd",

          "recallBudgetChars": 64000,

          "rerankEnabled": true,
          "rerankProvider": "local",
          "rerankMaxCandidates": 20,
          "rerankTimeoutMs": 8000
        }
      }
    }
  }
}
```

Service env override (optional):
- `OPENCLAW_CONFIG_PATH=/absolute/path/to/openclaw.json` (legacy
  `OPENCLAW_ENGRAM_CONFIG_PATH` is honored as a fallback)

Third-party OpenAI-compatible extraction endpoints:
- Set `localLlmEnabled: true` and point `localLlmUrl` at the provider base URL.
- If auth is required, set `localLlmApiKey` (and optional `localLlmHeaders`).
- Keep `localLlmFallback: true` so extraction/consolidation/profile/identity flows fail over to the gateway model chain.

## 1b) File Hygiene (Avoid Silent Truncation)

If your workspace bootstrap files (commonly `USER.md`, `MEMORY.md`, `IDENTITY.md`) get large, OpenClaw can silently truncate them during prompt bootstrap.
Enable Remnic's optional file hygiene to warn early and (optionally) rotate oversized files into an archive directory:

```jsonc
{
  "fileHygiene": {
    "enabled": true,
    "lintEnabled": true,
    "lintPaths": ["USER.md", "MEMORY.md", "IDENTITY.md"],
    "lintBudgetBytes": 20000,
    "lintWarnRatio": 0.8,

    "rotateEnabled": true,
    "rotatePaths": ["IDENTITY.md"],
    "rotateMaxBytes": 18000,
    "rotateKeepTailChars": 2000,
    "archiveDir": ".engram-archive",

    "runMinIntervalMs": 600000,
    "warningsLogEnabled": true,
    "warningsLogPath": "hygiene/warnings.md"
  }
}
```

## 2) v2.4 Context Retention

Recommended starting config:

```jsonc
{
  "hourlySummariesEnabled": true,
  "hourlySummaryCronAutoRegister": false,
  "hourlySummariesExtendedEnabled": true,
  "hourlySummariesIncludeToolStats": true,
  "hourlySummariesIncludeSystemMessages": false,
  "hourlySummariesMaxTurnsPerRun": 200,

  "conversationIndexEnabled": true,
  "conversationIndexBackend": "qmd",
  "conversationIndexQmdCollection": "openclaw-engram-conversations",
  "conversationIndexRetentionDays": 30,
  "conversationIndexMinUpdateIntervalMs": 900000,
  "conversationIndexEmbedOnUpdate": false,
  "conversationRecallTopK": 4,
  "conversationRecallMaxChars": 2000,
  "conversationRecallTimeoutMs": 800
}
```

FAISS alternative:

```jsonc
{
  "conversationIndexEnabled": true,
  "conversationIndexBackend": "faiss",
  "conversationIndexFaissPythonBin": "python3",
  "conversationIndexFaissModelId": "text-embedding-3-small",
  "conversationIndexFaissIndexDir": "state/conversation-index/faiss",
  "conversationIndexFaissUpsertTimeoutMs": 30000,
  "conversationIndexFaissSearchTimeoutMs": 5000,
  "conversationIndexFaissHealthTimeoutMs": 2000,
  "conversationIndexFaissMaxBatchSize": 512,
  "conversationIndexFaissMaxSearchK": 50,
  "conversationIndexRetentionDays": 30,
  "conversationIndexMinUpdateIntervalMs": 900000,
  "conversationRecallTopK": 4,
  "conversationRecallMaxChars": 2000,
  "conversationRecallTimeoutMs": 800
}
```

FAISS setup notes:
- Install the sidecar dependencies with `pip install -r scripts/faiss_requirements.txt`.
- Set `REMNIC_FAISS_ENABLE_ST=1` (legacy `ENGRAM_FAISS_ENABLE_ST=1` still works) if you want sentence-transformers embeddings. Without it, the sidecar uses deterministic hash embeddings.
- Expect local FAISS artifacts under `memoryDir/state/conversation-index/faiss/` (`index.faiss`, `metadata.jsonl`, `manifest.json`).
- Use `openclaw engram conversation-index-health` to confirm the backend is `faiss` and not degraded.
- Use `openclaw engram conversation-index-inspect` to diagnose missing artifacts, stale manifests, or empty indexes.
- Use `openclaw engram conversation-index-rebuild --hours 24` to force a deterministic rebuild from transcript history.
- If the sidecar is unavailable or the local artifacts are missing, Remnic fails open and simply skips semantic transcript recall.

## 2b) v8.0 Phase 1 (Experimental, Cost-Aware)

Start conservative and enable one flag at a time:

```jsonc
{
  "recallPlannerEnabled": true,
  "recallPlannerMaxQmdResultsMinimal": 4,

  "intentRoutingEnabled": false,
  "intentRoutingBoost": 0.12,

  "verbatimArtifactsEnabled": false,
  "verbatimArtifactsMinConfidence": 0.8,
  "verbatimArtifactsMaxRecall": 5,
  "verbatimArtifactCategories": ["decision", "correction", "principle", "commitment"]
}
```

Recommended rollout:
- Week 1: enable only `recallPlannerEnabled`.
- Week 2: enable `verbatimArtifactsEnabled` and watch token usage/quality.
- Week 3: enable `intentRoutingEnabled` and compare retrieval relevance before/after.

## 2c) v8.3 Lifecycle Policy Rollout

`lifecyclePolicyEnabled` is default-on since issue #686, so scoring and transitions already run on a fresh install. The config below makes the rollout explicit and keeps retrieval filtering off until you have measured outcomes; set `lifecyclePolicyEnabled: false` to opt out entirely.

```jsonc
{
  "lifecyclePolicyEnabled": true,
  "lifecycleMetricsEnabled": true,
  "lifecycleFilterStaleEnabled": false,
  "lifecyclePromoteHeatThreshold": 0.55,
  "lifecycleStaleDecayThreshold": 0.65,
  "lifecycleArchiveDecayThreshold": 0.85,
  "lifecycleProtectedCategories": ["decision", "principle", "commitment", "preference"]
}
```

Recommended staged rollout:
- Week 1 (shadow mode): enable `lifecyclePolicyEnabled` + `lifecycleMetricsEnabled`; keep `lifecycleFilterStaleEnabled=false`.
- Week 2 (ranking-only): keep stale filtering off, observe retrieval quality with lifecycle score adjustments.
- Week 3 (optional filtering): enable `lifecycleFilterStaleEnabled=true` only if stale/disputed recall metrics improve and no recall regressions are observed.

Validation checkpoints:
- Confirm metrics file is emitted: `memory/state/lifecycle-metrics.json`.
- Compare stale/disputed recall rates before/after each phase.
- If relevance drops, keep policy on but disable stale filtering and retune thresholds.

## 2d) v8.3 Proactive + Policy Learning Foundation

Start with all new policy-learning behavior disabled, then enable incrementally:

```jsonc
{
  "proactiveExtractionEnabled": false,
  "contextCompressionActionsEnabled": false,
  "compressionGuidelineLearningEnabled": false,
  "compressionGuidelineSemanticRefinementEnabled": false,
  "compressionGuidelineSemanticTimeoutMs": 2500,
  "maxProactiveQuestionsPerExtraction": 2,
  "proactiveExtractionTimeoutMs": 2500,
  "proactiveExtractionMaxTokens": 900,
  "maxCompressionTokensPerHour": 1500
}
```

Rollout suggestion:
- Enable `proactiveExtractionEnabled` first and validate extraction quality/latency.
- Keep `proactiveExtractionTimeoutMs` and `proactiveExtractionMaxTokens` conservative at first so the second pass stays bounded.
- Enable `contextCompressionActionsEnabled` after tool-level validation.
- Enable `compressionGuidelineLearningEnabled` last, once memory-action telemetry is stable.
- Keep `compressionGuidelineSemanticRefinementEnabled=false` during initial rollout; enable only after deterministic outputs are stable.
- If semantic refinement is enabled, keep `compressionGuidelineSemanticTimeoutMs` low (for example, 1500-3000ms) so failures always fail-open quickly.

Operational checks after enabling guideline learning:
- Confirm telemetry is append-only: `memory/state/memory-actions.jsonl`.
- Confirm guideline synthesis output exists: `memory/state/compression-guidelines.md`.
- If proactive extraction is enabled, confirm new second-pass memories write with `source: extraction-proactive` frontmatter.
- Verify fail-open behavior by temporarily making state unwritable and confirming consolidation still completes.
- If guidance quality regresses, keep telemetry enabled and disable only `compressionGuidelineLearningEnabled`.

v8.13 action-policy rollout presets:
- Canonical preset JSON lives in `docs/config-reference.md` under `v8.13 Action-Policy Rollout Presets`.
- Use `conservative` for baseline-equivalent mode, `balanced` for default production rollout, `research-max` for the broadest shipped experimental surface, and `local-llm-heavy` when you want local endpoints carrying most advanced work.
- For the cross-feature preset entry point, set `memoryOsPreset` first and then override only the specific knobs your environment needs.

Operator hardening checklist before promotion:
- Keep `contextCompressionActionsEnabled=true` only after tool traces stay stable and review-clean for one full daily cycle.
- Treat `proactiveExtractionTimeoutMs=0` or `proactiveExtractionMaxTokens=0` as intentional hard disables for the proactive second pass.
- Treat `maxCompressionTokensPerHour=0` as an intentional hard disable for policy defers.
- If regressions appear, first disable `compressionGuidelineSemanticRefinementEnabled`, then disable `compressionGuidelineLearningEnabled`.
- Confirm disabled-path behavior by toggling all action-policy features off and verifying recall outputs remain baseline-equivalent.

## 2e) v8.15 Behavior-Loop Auto-Tuning Rollout

Keep behavior-loop learning disabled by default, then enable in stages:

```jsonc
{
  "behaviorLoopAutoTuneEnabled": false,
  "behaviorLoopLearningWindowDays": 14,
  "behaviorLoopMinSignalCount": 10,
  "behaviorLoopMaxDeltaPerCycle": 0.1,
  "behaviorLoopProtectedParams": [
    "qmdMaxResults",
    "maxMemoryTokens",
    "verbatimArtifactsMaxRecall",
    "cronRecallInstructionHeavyTokenCap"
  ]
}
```

Recommended rollout:
- Stage 1 (observe only): keep `behaviorLoopAutoTuneEnabled=false` and monitor `policy-status`/`policy-diff` outputs.
- Stage 2 (canary namespace): enable auto-tune for a low-risk namespace and monitor policy stability for at least one full cycle.
- Stage 3 (broader rollout): expand only after policy changes are bounded, stable, and rollback rate stays low.

Operational guardrails:
- Treat `behaviorLoopAutoTuneEnabled=false` as a hard disable.
- Treat numeric `0` limits as intentional hard caps/disables; do not rely on implicit coercion.
- Preserve planner mode behavior (`no_recall`, `minimal`, `full`, `graph_mode`) during rollout verification.
- If recall quality regresses, run `openclaw engram policy-rollback` and disable auto-tune before further changes.

Policy observability commands:

```bash
openclaw engram policy-status
openclaw engram policy-diff --since 7d
openclaw engram policy-rollback
```

Conversation index health check command:

```bash
openclaw engram conversation-index-health
openclaw engram conversation-index-inspect
openclaw engram conversation-index-rebuild --hours 24
```

QMD collection (`~/.config/qmd/index.yml`):

```yaml
collections:
  openclaw-engram-conversations:
    path: ~/.openclaw/workspace/memory/local/conversation-index/chunks
    pattern: "**/*.md"
```

## 3) v3.0 Namespaces

Recommended starter policy:

```jsonc
{
  "namespacesEnabled": true,
  "defaultNamespace": "generalist",
  "sharedNamespace": "shared",
  "principalFromSessionKeyMode": "prefix",
  "principalFromSessionKeyRules": [
    { "match": "agent:<agent-id-1>:", "principal": "<agent-id-1>" },
    { "match": "agent:<agent-id-2>:", "principal": "<agent-id-2>" }
  ],
  "namespacePolicies": [
    {
      "name": "<agent-id-1>",
      "readPrincipals": ["<agent-id-1>", "<agent-id-2>"],
      "writePrincipals": ["<agent-id-1>"],
      "includeInRecallByDefault": true
    },
    {
      "name": "<agent-id-2>",
      "readPrincipals": ["<agent-id-2>"],
      "writePrincipals": ["<agent-id-2>"],
      "includeInRecallByDefault": true
    },
    {
      "name": "shared",
      "readPrincipals": ["*"],
      "writePrincipals": ["<agent-id-1>", "<agent-id-2>"],
      "includeInRecallByDefault": true
    }
  ],
  "defaultRecallNamespaces": ["self", "shared"]
}
```

Operational note:
- The default namespace continues using the legacy `memoryDir` root unless `memoryDir/namespaces/<defaultNamespace>` exists.

### Cron Recall Query Policy (QMD Stability)

Use this when cron prompts are large/instruction-heavy and cause QMD query instability:

```jsonc
{
  "cronRecallPolicyEnabled": true,
  "cronRecallNormalizedQueryMaxChars": 480,
  "cronRecallInstructionHeavyTokenCap": 36,
  "cronConversationRecallMode": "auto"
}
```

Behavior:
- For instruction-heavy cron prompts, Remnic builds a compact retrieval query and applies minimal recall budget.
- In `cronConversationRecallMode: "auto"`, conversation semantic recall is skipped only for instruction-heavy cron prompts.
- Set `cronConversationRecallMode: "always"` to force conversation semantic recall for cron jobs that need it.
- Set `cronConversationRecallMode: "never"` to disable conversation semantic recall for all cron jobs.

## 4) v4.0 Shared Context

```jsonc
{
  "sharedContextEnabled": true,
  "sharedContextDir": "~/.openclaw/workspace/shared-context",
  "sharedContextMaxInjectChars": 6000,
  "crossSignalsSemanticEnabled": false,
  "crossSignalsSemanticTimeoutMs": 4000
}
```

Keep semantic cross-signals off until deterministic shared-context behavior is stable and load-tested.

**Budget interaction:** Shared context is assembled at position 1 in the recall pipeline (before profile). With the default 8,000 char budget, 6,000 chars of shared context leaves very little room for profile and memories. If you use shared context, ensure `recallBudgetChars` is set high enough to accommodate all sections. A budget of 64,000+ is recommended when shared context is enabled alongside a full profile.

## 5) v5.0 Compounding

```jsonc
{
  "compoundingEnabled": true,
  "compoundingWeeklyCronEnabled": true,
  "compoundingSemanticEnabled": false,
  "compoundingSynthesisTimeoutMs": 15000,
  "compoundingInjectEnabled": true
}
```

Start with deterministic compounding. Enable semantic compounding only after weekly outputs are reliable.

## 6) Recommended Cron Jobs

Use isolated `agentTurn` jobs and `delivery.mode: "none"`:

1. Hourly summaries:
- schedule: `17 * * * *`
- action: call tool `memory_summarize_hourly`

2. Conversation index refresh:
- schedule: `23 * * * *`
- action: call tool `conversation_index_update` with `{"hours":48}`
- optional one-off deep refresh: `{"hours":48,"embed":true}`

3. Shared-context daily curation:
- schedule: `5 21 * * *`
- action: call tool `shared_context_curate_daily`

4. Weekly compounding synthesis:
- schedule: `35 21 * * 0`
- action: call tool `compounding_weekly_synthesize`

## 7) Tuning Checklist

Recall budget (most important):
- **Set `recallBudgetChars` explicitly.** The default (8,000 chars) is too small for most deployments. With a profile (~7,500 chars) and shared context (~4,000 chars), the default budget silently drops all actual memories.
- For 200K+ context models (Claude, GPT-5): use `64000`–`128000`.
- For smaller context models (32K–128K): use `32000`–`64000`.
- Diagnose via `last_recall.json`: if `memoryIds` is non-empty but `finalContextChars` is close to `recallBudgetChars`, the budget was exhausted and the `memories` section (which is protected) was truncated to heading-only.

Reliability / load:
- Keep extraction guardrails enabled (defaults are safe):
  - `extractionDedupeEnabled: true`
  - `extractionDedupeWindowMs: 300000`
  - `extractionMinChars: 40`
  - `extractionMinUserTurns: 1`
  - `extractionMaxTurnChars: 4000`
  - `extractionMaxFactsPerRun: 12`
  - `extractionMaxEntitiesPerRun: 6`
  - `extractionMaxQuestionsPerRun: 3`
  - `extractionMaxProfileUpdatesPerRun: 4`
- Consolidation throttling:
  - `consolidationRequireNonZeroExtraction: true`
  - `consolidationMinIntervalMs: 600000`
- QMD maintenance off the hot path:
  - `qmdPath: "/absolute/path/to/qmd"` (set explicitly when PATH/bun shims are unstable)
  - `qmdMaintenanceEnabled: true`
  - `qmdMaintenanceDebounceMs: 30000`
  - `qmdUpdateTimeoutMs: 90000`
  - `qmdUpdateMinIntervalMs: 900000` (15 min gate; prevents frequent global `qmd update` churn)
  - `qmdAutoEmbedEnabled: false` (enable only when you need frequent embed refresh)
  - `qmdEmbedMinIntervalMs: 3600000`
- Cron recall load control:
  - `cronRecallMode: "allowlist"` to default cron sessions to no recall.
  - Populate `cronRecallAllowlist` with only context-heavy cron job ids/patterns (`*:cron:<job-id>:*`).
  - Keep ingestion/integration script crons out of the allowlist unless they genuinely need memory context.
- QMD version:
  - **QMD 2.5.3 is the current supported target.** Remnic detects the installed version with `qmd --version` and gates 2.5 features such as `qmd doctor`, version-matched skills, scoped embed behavior, named index selection, model/GPU env controls, absolute snippet line numbers, and QMD 2.5.3's preferred `--format json` output selector for `qmd query`/`qmd search`.
  - **QMD 2.0+ is the minimum practical baseline.** All 1.x patches (PRs #166, #112, #117) are resolved natively in 2.0. QMD 1.x still works but requires manual patches.
  - Set `qmdAutoUpgradeEnabled: true` to let Remnic upgrade PATH/fallback installs to `qmdSupportedVersion`; explicit `qmdPath` installs must be upgraded manually.
  - The QMD daemon keeps models warm — queries drop from ~13s to ~30ms after the first call.
  - See [Getting Started](getting-started.md#upgrading-qmd) for upgrade steps.
- Local LLM failure damping:
  - `localLlmRetry5xxCount: 1`
  - `localLlmRetryBackoffMs: 400`
  - `localLlm400TripThreshold: 5`
  - `localLlm400CooldownMs: 120000`
- Extraction failure damping (retry backoff + circuit breaker):
  - `extractionRetryEnabled: true` — master gate. Set `false` to fully restore pre-change behavior (extractor called on every triggered observe, no gate); this is the config-only rollback.
  - `extractionRetryScheduleMs: [60000, 300000, 1800000, 7200000]` — per-fingerprint exponential backoff (1m, 5m, 30m, 2h). A single transient 429 parks that fingerprint for only 1 minute.
  - `extractionRetryMaxBackoffMs: 21600000` — 6h cap on any backoff interval.
  - `extractionRetryJitterRatio: 0.2` — ±20% jitter so retries don't synchronize.
  - `extractionParseEmptyMaxAttempts: 3` — after 3 unparseable responses a fingerprint is long-parked (never marked processed).
  - `extractionBreakerFailureThreshold: 5` — consecutive provider failures before the process-level breaker opens and short-circuits extraction for all sessions. A 401/403/"no models configured" opens it immediately.
  - `extractionBreakerCooldownMs: 300000` / `extractionBreakerAuthCooldownMs: 1800000` — breaker open cooldown for transient (5m) vs auth/config (30m) failures. After cooldown a half-open probe closes the breaker on one success and clears retry state. Watch `openclaw remnic doctor` (the `extraction-resilience` check) for a breaker stuck `open` or `auth_config` errors.

Latency:
- Increase `conversationRecallTimeoutMs` only if your QMD host is consistently fast.
- Keep `rerankTimeoutMs` conservative (5-10s) and fail-open.

Recall quality:
- Increase `conversationRecallTopK` gradually (3 -> 4 -> 6) and watch prompt bloat.
- Keep `conversationRecallMaxChars` bounded (1500-3000) to avoid drowning current context.
- For v8.12 graph assist evaluation in `full` mode, set `graphAssistShadowEvalEnabled: true` first to capture overlap/delta telemetry without changing injected recall output.

Storage growth:
- Keep `conversationIndexRetentionDays` finite.
- Keep `conversationIndexMinUpdateIntervalMs` >= 10m unless you are actively debugging.
- Keep transcript retention finite (`transcriptRetentionDays`).

Safety:
- Leave `hourlySummariesIncludeSystemMessages=false` unless specifically debugging.
- Use `delivery.mode: "none"` for maintenance crons so they never spam Discord.

## 8) Post-Restart Validation

After your next gateway restart:

1. Confirm plugin startup in logs.
2. Run `memory_summarize_hourly` once manually.
3. Run `conversation_index_update` once manually.
4. Confirm files appear:
- `memory/local/summaries/hourly/...`
- `memory/local/conversation-index/chunks/...`
- `workspace/shared-context/...`
- `memory/local/compounding/...` (after weekly run)
