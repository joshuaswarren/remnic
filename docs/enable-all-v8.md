# Enable all features (full-feature profile)

This is the full-feature profile: a single config block that explicitly turns on every major Remnic feature family at once, so you can validate the whole surface in one pass and then trim back to what you need. The `v8` in the file name is a historical label; these features shipped across many releases through v9.6.22, so treat this as the current maximal profile, not a version-specific one.

Apply it under the OpenClaw plugin entry. The current plugin id is `openclaw-remnic`; installs created before the rename may still use the legacy `openclaw-engram` id, which Remnic continues to read.

- `plugins.entries.openclaw-remnic.enabled = true`
- `plugins.entries.openclaw-remnic.config = { ... }`

## Full config profile

```jsonc
{
  "openaiApiKey": "${OPENAI_API_KEY}",
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram-hot-facts",
  "qmdColdTierEnabled": true,
  "qmdColdCollection": "openclaw-engram-cold",
  "conversationIndexEnabled": true,
  "conversationIndexBackend": "faiss",
  "conversationIndexFaissPythonBin": "python3",
  "conversationIndexFaissModelId": "text-embedding-3-small",
  "conversationIndexFaissIndexDir": "state/conversation-index/faiss",

  "recallPlannerEnabled": true,
  "memoryBoxesEnabled": true,
  "traceWeaverEnabled": true,
  "episodeNoteModeEnabled": true,
  "queryAwareIndexingEnabled": true,
  "multiGraphMemoryEnabled": true,
  "graphRecallEnabled": true,
  "graphAssistShadowEvalEnabled": true,
  "temporalMemoryTreeEnabled": true,

  "lifecyclePolicyEnabled": true,
  "lifecycleFilterStaleEnabled": true,
  "lifecycleMetricsEnabled": true,

  "procedural": {
    "enabled": true,
    "proceduralMiningCronAutoRegister": false
  },

  "proactiveExtractionEnabled": true,
  "contextCompressionActionsEnabled": true,
  "compressionGuidelineLearningEnabled": true,
  "compressionGuidelineSemanticRefinementEnabled": true,

  "identityEnabled": true,
  "identityContinuityEnabled": true,
  "continuityAuditEnabled": true,
  "continuityIncidentLoggingEnabled": true,

  "routingRulesEnabled": true,
  "sessionObserverEnabled": true,

  "sharedContextEnabled": true,
  "sharedCrossSignalSemanticEnabled": true,
  "compoundingEnabled": true,
  "compoundingInjectEnabled": true,
  "compoundingSemanticEnabled": true,
  "compoundingWeeklyCronEnabled": true,

  "qmdTierMigrationEnabled": true,
  "qmdTierAutoBackfillEnabled": true,

  "behaviorLoopAutoTuneEnabled": true,

  "debug": true
}
```

## Safety Notes

- Keep secrets in environment variables (`${OPENAI_API_KEY}`), not hardcoded keys.
- If you run many features at once, expect higher extraction/consolidation activity.
- `debug: true` is recommended while validating; disable later for quieter logs.
- If you use `conversationIndexBackend: "faiss"`, install `scripts/faiss_requirements.txt` first and optionally set `REMNIC_FAISS_ENABLE_ST=1` (legacy `ENGRAM_FAISS_ENABLE_ST=1` still works) for sentence-transformers embeddings.
- If you prefer QMD for transcript recall, swap the FAISS fields for `conversationIndexBackend: "qmd"` plus `conversationIndexQmdCollection`.
- **`procedural.enabled`** controls procedural memory (writes under `procedures/`, recall injection, mining). It is default-on since issue #567, so setting `"enabled": true` here is explicit rather than required; remove the `procedural` object or set `"enabled": false` to run this profile without procedural behavior. See [procedural-memory.md](procedural-memory.md).

## Required Restart

After config changes:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

## Verification Checklist

Run all commands:

```bash
openclaw engram compat --strict
openclaw engram stats
openclaw engram conversation-index-health
openclaw engram conversation-index-inspect
openclaw engram graph-health
openclaw engram tier-status
openclaw engram policy-status
```

Expected:

- `compat --strict`: exits `0`
- `stats`: `QMD: available`
- `conversation-index-health`: `status: "ok"` when backend is `qmd`
- `conversation-index-inspect`: returns backend metadata and artifact state without mutating the index
- `graph-health`: JSON report without runtime command failure
- `tier-status`: returns migration telemetry JSON
- `policy-status`: returns runtime policy snapshot JSON

## Search Backend (v9.0)

The config above uses QMD (default). To use an alternative backend, add:

```jsonc
{
  "searchBackend": "orama"   // or "lancedb", "meilisearch", "remote", "noop"
}
```

See [Search Backends](search-backends.md) for full options.

## Related Docs

- [Getting Started](getting-started.md)
- [Search Backends](search-backends.md)
- [Config Reference](config-reference.md)
- [Operations](operations.md)
- [Identity Continuity](identity-continuity.md)
- [Shared Context](shared-context.md)
