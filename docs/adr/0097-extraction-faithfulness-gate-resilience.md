# The extraction faithfulness gate fails open and is hard-bounded by a timeout race

Status: accepted

## Context
The faithfulness gate audits extracted facts against their source evidence with an LLM verifier before they persist. A wedged, slow, or broken verifier backend must never block or lose extraction writes, and must never hang the extraction flush past its configured budget.

## Decision
The gate fails open, never closed. checkFaithfulnessBatch is total: an LLM throw surfaces as ok:false and the fact is recorded as "unchecked"; a pipeline error tags each checkable fact backend_unavailable rather than returning null (which would be indistinguishable from gate-off and lose telemetry). The LLM call is raced against extractionFaithfulnessTimeoutMs: content landing within the budget is used, content landing after it fails open as timeout; a response that lands just as the timer fires is used since it carries real verdicts. Verdict-distribution counters are bumped only at the per-fact apply point (applyFaithfulnessVerdict), so console_state reflects facts that actually reached verdict application. The gate reads a loose structural fact type so the pure module does not depend on concrete extraction types. Config parsing rejects present-but-invalid gate values instead of silently disabling the gate; absent keys take defaults, preserving byte-identical pre-feature behavior.

## Consequences
Late or failing verifications produce "unchecked" records instead of verdicts, so enforcement is advisory under backend outage; the timeout budget caps how long a slow backend can contribute at all.

## Origin comments
- `packages/remnic-core/src/extraction-evidence-class.test.ts:202` — "// agent prose. This is the self-reinforcing loop the rules must break."
- `packages/remnic-core/src/extraction-evidence-class.test.ts:343` — "// Findings order is canonical (rule id order), not input-order dependent."
- `packages/remnic-core/src/extraction-faithfulness.test.ts:106` — "/** * Create a stub FallbackLlmClient that IGNORES the abort signal and returns * valid content after a delay longer t"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:436` — "// The batch races the LLM call against extractionFaithfulnessTimeoutMs so a"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:437` — "// wedged/slow backend cannot hold the extraction flush past the budget"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:438` — "// (codex review PRRT_kwDORJXyws6ObgMJ). Content that lands WITHIN the budget"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:439` — "// is used; content that lands AFTER the budget fails open as timeout."
- `packages/remnic-core/src/extraction-faithfulness.test.ts:716` — "// checkFaithfulnessBatch is total: it catches an LLM throw and surfaces it"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:717` — "// as an ok:false result rather than propagating. So the gate records the"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:718` — "// failure as "unchecked" and proceeds — a backend outage never blocks writes."
- `packages/remnic-core/src/extraction-faithfulness.test.ts:1018` — "// LocalLlmClient.chatCompletion does not read options.signal — it uses its"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:1019` — "// own per-attempt AbortController keyed on timeoutMs. The gate must forward"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:1020` — "// timeoutMs (so each local attempt is bounded by the faithfulness budget)"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:1021` — "// and must NOT forward the batch signal (dead code the local client drops)."
- `packages/remnic-core/src/extraction-faithfulness.test.ts:1096` — "// LocalLlmClient ignores options.signal and aborts each attempt via its own"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:1097` — "// controller. A wedged local verifier that never resolves within the budget"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:1098` — "// must NOT hold the batch past extractionFaithfulnessTimeoutMs — the race"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:1099` — "// returns timeout promptly so the extraction flush is not blocked"
- `packages/remnic-core/src/extraction-faithfulness.test.ts:1100` — "// (codex review PRRT_kwDORJXyws6ObgMJ)."
- `packages/remnic-core/src/extraction-faithfulness.ts:561` — "// Race the LLM call against the budget so the batch fails open at"
- `packages/remnic-core/src/extraction-faithfulness.ts:562` — "// `timeoutMs` regardless of which backend is in flight. The local backend"
- `packages/remnic-core/src/extraction-faithfulness.ts:563` — "// ignores the batch AbortSignal (it aborts each attempt via its own"
- `packages/remnic-core/src/extraction-faithfulness.ts:564` — "// controller keyed on `timeoutMs`), so awaiting callFaithfulnessLlm directly"
- `packages/remnic-core/src/extraction-faithfulness.ts:565` — "// could block past the budget on a slow/retrying local verifier. The timer"
- `packages/remnic-core/src/extraction-faithfulness.ts:566` — "// both aborts the fallback (which honors the signal) and resolves the race"
- `packages/remnic-core/src/extraction-faithfulness.ts:567` — "// so the batch returns promptly; the in-flight local call aborts on its own"
- `packages/remnic-core/src/extraction-faithfulness.ts:568` — "// per-attempt timeoutMs. (codex review PRRT_kwDORJXyws6ObgMJ.)"
- `packages/remnic-core/src/extraction-faithfulness.ts:597` — "// An unexpected throw is treated as "no content" (backend_unavailable)"
- `packages/remnic-core/src/extraction-faithfulness.ts:598` — "// so the race never rejects and the outer catch is the final safety net."
- `packages/remnic-core/src/extraction-faithfulness.ts:606` — "// The budget elapsed before any backend returned content. Fail open as"
- `packages/remnic-core/src/extraction-faithfulness.ts:607` — "// timeout; the orphaned callPromise resolves/rejects harmlessly (the"
- `packages/remnic-core/src/extraction-faithfulness.ts:608` — "// fallback was aborted; the local client aborts on its own timeoutMs)."
- `packages/remnic-core/src/extraction-faithfulness.ts:617` — "// Cursor review: if the LLM returned usable content, use it even when"
- `packages/remnic-core/src/extraction-faithfulness.ts:618` — "// the abort timer raced — a response that lands just as the timer fires"
- `packages/remnic-core/src/extraction-faithfulness.ts:619` — "// has real verdicts. Only fall back to timeout errors when there is no"
- `packages/remnic-core/src/extraction-faithfulness.ts:620` — "// content to parse (the call genuinely did not complete in time)."
- `packages/remnic-core/src/extraction-faithfulness.ts:721` — "/** * Structural slice of an extracted fact that the gate reads. Kept loose so * this pure module does not depend on the"
- `packages/remnic-core/src/extraction-faithfulness.ts:1113` — "// Verdict-distribution counters are bumped in applyFaithfulnessVerdict"
- `packages/remnic-core/src/extraction-faithfulness.ts:1114` — "// (at the per-fact apply point), NOT here, so console_state reflects"
- `packages/remnic-core/src/extraction-faithfulness.ts:1115` — "// facts that actually reached verdict application — not facts later"
- `packages/remnic-core/src/extraction-faithfulness.ts:1116` — "// dropped by dedup, importance, or judge gates (cursor review)."
- `packages/remnic-core/src/extraction-faithfulness.ts:1121` — "// Fail-open: a pipeline error never blocks writes (checklist §4). Tag each"
- `packages/remnic-core/src/extraction-faithfulness.ts:1122` — "// checkable fact as backend_unavailable so applyFaithfulnessVerdict records"
- `packages/remnic-core/src/extraction-faithfulness.ts:1123` — "// "unchecked" (issue spec: backend failure → unchecked). Returning null"
- `packages/remnic-core/src/extraction-faithfulness.ts:1124` — "// here would make a shadow/enforce batch failure indistinguishable from"
- `packages/remnic-core/src/extraction-faithfulness.ts:1125` — "// gate-off, losing the telemetry signal (cursor review). Facts with no"
- `packages/remnic-core/src/extraction-faithfulness.ts:1126` — "// located span stay absent → skipped_no_span at apply time."
- `packages/remnic-core/src/faithfulness-config.ts:1` — "/** * Faithfulness-gate + correction-intent config parsing (issue #1576 / #1585). * * Extracted verbatim from "
- `packages/remnic-core/src/faithfulness-config.ts:22` — "/** * Parse a value as a strict integer >= `min`, throwing on anything else. * * Mirrors `parseIntegerAtLeast`"
- `packages/remnic-core/src/faithfulness-config.ts:77` — "// Present-but-invalid (true/1/{}) must reject, not silently disable the gate (Ob4RQ)."
