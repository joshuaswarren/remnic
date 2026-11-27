# Extraction pipeline health is measured, degraded states are visible, and failure classification preserves the primary cause

Status: accepted

## Context
A daemon's implicit extraction can fail silently for months; separately, layered fallback paths can misattribute a primary failure to whichever layer observed it last.

## Decision
Liveness is a pure verdict: degraded when enabled AND the extraction watermark is unreadable, in the future (clock skew — treated as stale, never fresh), a buffer cannot be read (a fault, never an empty queue, and distinct from never-extracted), or the extraction LLM is unreachable. A meta-read failure takes precedence over staleness. Fractional or otherwise invalid config values are rejected at the parse boundary, never floored or silently defaulted; only an absent key defaults, and missing/partial config blocks degrade to sane statuses instead of crashing. Degraded episodes emit at most one aggregated WARN per staleness window, reset on recovery; extraction-LLM outages are visible on /health and doctor/stats without debug logs. Failure classification preserves the primary cause: when a local/direct extractor already failed before the gateway fallback, a gateway "no models" result does not reclassify the run as auth_config — the root cause is the primary (transient) failure. A drain run that deliberately retained its window (breaker open, backoff, scope skip) is a deferral, never a drain or a chunk failure — the content was not consumed. taskModelChain applies only under modelSource "gateway"; other modes warn rather than silently ignore it. Opik tracing emits llm_start only for paths that actually call an LLM (fallback-only deployments skip it), gateway-backed calls get a fresh trace, and subscriber errors cannot break the extraction path.

## Consequences
Strict config rejection surfaces typos early but means a hand-edited bad value must be fixed before the feature runs; degradation signals can be noisy for genuinely idle systems unless the watermark is present.

## Origin comments
- `packages/remnic-core/src/extraction-liveness.test.ts:66` — "// Fractional values must be REJECTED, not floored: "0.5"→0 would make every"
- `packages/remnic-core/src/extraction-liveness.test.ts:67` — "// backlog instantly stale and 1.9→1 is a silent reinterpretation."
- `packages/remnic-core/src/extraction-liveness.test.ts:78` — "// An explicit `null` is invalid input, not "use the default" — mirrors"
- `packages/remnic-core/src/extraction-liveness.test.ts:79` — "// config.ts parseIntegerInClosedRange. Only an absent key (undefined) defaults."
- `packages/remnic-core/src/extraction-liveness.test.ts:251` — "// A meta-read failure takes precedence over staleness when both would degrade."
- `packages/remnic-core/src/extraction-liveness.test.ts:499` — "// A present-but-invalid window (0/fractional) falls back rather than making every backlog instantly stale."
- `packages/remnic-core/src/extraction-liveness.test.ts:504` — "// enabled is coerced like parseExtractionLivenessConfig: string opt-outs read as falsy (#2155 review)."
- `packages/remnic-core/src/extraction-liveness.test.ts:511` — "// A PluginConfig built directly (host adapter / older persisted config) can omit"
- `packages/remnic-core/src/extraction-liveness.test.ts:512` — "// the block or leave it partial; every liveness surface must return a sane status"
- `packages/remnic-core/src/extraction-liveness.test.ts:513` — "// rather than crash (#2155 review)."
- `packages/remnic-core/src/extraction-liveness.ts:1` — "/** * Extraction-pipeline liveness (issue #2151). * * A daemon's implicit extraction can fail continuously for mont"
- `packages/remnic-core/src/extraction-liveness.ts:194` — "/** * Parse `extractionLiveness.staleWindowMs`. Absent (`undefined`) → the 24h * default; any PRESENT value (includ"
- `packages/remnic-core/src/extraction-liveness.ts:237` — "/** * Pure liveness verdict. Degraded when the feature is enabled AND any of: the * last-extraction watermark could"
- `packages/remnic-core/src/extraction-liveness.ts:273` — "// A future watermark (negative age) is clock-skewed or corrupt data, not a"
- `packages/remnic-core/src/extraction-liveness.ts:274` — "// fresh extraction: treat it as stale so a real backlog stall is not hidden."
- `packages/remnic-core/src/extraction-liveness.ts:277` — "// A watermark or buffer that cannot be READ is a fault, not an empty queue"
- `packages/remnic-core/src/extraction-liveness.ts:278` — "// (§22): a storage/pipeline outage must not read as healthy, and must stay"
- `packages/remnic-core/src/extraction-liveness.ts:279` — "// distinct from a pipeline that has genuinely never extracted."
- `packages/remnic-core/src/extraction-liveness.ts:340` — "/** * Read a buffer snapshot without throwing. An ABSENT buffer degrades to an empty * (healthy) snapshot — some se"
- `packages/remnic-core/src/extraction-liveness.ts:385` — "// #3442: the claimed-backlog reason names the last failure while the"
- `packages/remnic-core/src/extraction-liveness.ts:386` — "// extractor is unreachable, matching the /health llm block."
- `packages/remnic-core/src/extraction-liveness.ts:391` — "/** * Aggregated-WARN throttle (issue #2151): emit at most ONE warning per * staleness window while degraded — not "
- `packages/remnic-core/src/extraction-liveness.ts:403` — "// Recovered (or never degraded): reset so a fresh episode warns at once."
- `packages/remnic-core/src/extraction-liveness.ts:416` — "/** * Normalize the `extractionLiveness` block at the read boundary. `parseConfig` * always populates it, but a hos"
- `packages/remnic-core/src/extraction-liveness.ts:476` — "// Extraction-LLM availability (#3140): a silent no_models / LLM-unreachable"
- `packages/remnic-core/src/extraction-liveness.ts:477` — "// outage must be visible on /health (and doctor/stats) without debug logs."
- `packages/remnic-core/src/extraction-llm-health.ts:1` — "/** * Extraction-LLM availability tracking surfaced on `/health` (issue #3140). * * A failing extraction LLM (unrea"
- `packages/remnic-core/src/extraction-local-failure-class.test.ts:8` — "// Follow-up to #3266: the trigger drain drops a chunk after N failures, but not for an outage. Whether a local-mod"
- `packages/remnic-core/src/extraction-local-failure-class.test.ts:9` — "// is the chunk's fault is decided here, by what the local endpoint did."
- `packages/remnic-core/src/extraction-window-drain.ts:47` — "/** * Run results that deliberately RETAIN the buffer (provider breaker open, * per-fingerprint backoff, a sco"
- `packages/remnic-core/src/extraction-window-drain.ts:62` — "// A run that kept its window for retry did NOT consume the content: it is a"
- `packages/remnic-core/src/extraction-window-drain.ts:63` — "// chunk failure, never a drain — even when the window was retained."
- `packages/remnic-core/src/extraction.ts:186` — "// taskModelChain resolves through gateway providers, so it only applies"
- `packages/remnic-core/src/extraction.ts:187` — "// under modelSource: "gateway". Warn rather than silently ignore it so a"
- `packages/remnic-core/src/extraction.ts:188` — "// misconfigured plugin-mode setup is visible. Issue #1365 / PR #1370."
- `packages/remnic-core/src/extraction.ts:229` — "// Shared resolution (taskModelChain > gatewayAgentId) so every background"
- `packages/remnic-core/src/extraction.ts:230` — "// task routes identically (gotcha #22). Issue #1365."
- `packages/remnic-core/src/extraction.ts:1163` — "// Only emit llm_start for the direct path when a client or local LLM is configured."
- `packages/remnic-core/src/extraction.ts:1164` — "// Fallback-only deployments skip this to avoid fake spans in Opik."
- `packages/remnic-core/src/extraction.ts:1178` — "// True when a local or direct extractor was attempted before the gateway"
- `packages/remnic-core/src/extraction.ts:1179` — "// fallback, so a gateway "no models" result doesn't re-classify a real"
- `packages/remnic-core/src/extraction.ts:1180` — "// primary failure as auth_config (codex review: preserve direct/local failures)."
- `packages/remnic-core/src/extraction.ts:1259` — "// Emit error event so Opik sees the direct client failure before fallback."
- `packages/remnic-core/src/extraction.ts:1260` — "// Wrapped in try/catch so a subscriber error doesn't break the fallback path."
- `packages/remnic-core/src/extraction.ts:1294` — "// In gateway mode this is the primary extraction path. In plugin mode it is the"
- `packages/remnic-core/src/extraction.ts:1295` — "// final fallback after local/direct attempts fail. Emit a fresh llm_start so the"
- `packages/remnic-core/src/extraction.ts:1296` — "// gateway-backed call gets its own trace rather than being orphaned under the"
- `packages/remnic-core/src/extraction.ts:1297` — "// direct-client traceId."
- `packages/remnic-core/src/extraction.ts:1381` — "// Gateway had no models, but a local/direct extractor already failed —"
- `packages/remnic-core/src/extraction.ts:1382` — "// the root cause is the primary (transient), not gateway auth/config."
