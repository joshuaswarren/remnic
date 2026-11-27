# Correction planning and classify calls fail closed, time out on ref'd timers, and degrade to a deterministic plan

Status: accepted

## Context
The correction planner depends on a single LLM response whose output drives mutations, and on search over the memory corpus to locate correction targets. The LLM can time out, return malformed or ambiguous output, or be unavailable; the search path historically used an exact-prefix match that missed paraphrased content. Plan state can also be left `applying` by a crash.

## Decision
parseClassifyResponse accepts an empty action list but treats an all-malformed list as unusable; malformed siblings are dropped after selection so one bad action cannot discard the whole plan, and distinct eligible responses stay ambiguous and fail closed. Attempt-level aborts belong to the attempt's own budget: an attempt-signal timeout is a finished miss (empty plan), not a caller disconnect — only the caller's own signal skips the empty-plan path. Classify waits use a ref'd timer, not AbortSignal.timeout, so a short-lived caller stays alive until the budget elapses. When the planner LLM is unavailable the plan degrades to a deterministic fallback plan rather than failing the correction flow. Candidate location delegates to a tokenized, keyword-overlap search (the planner passes the full correction text), replacing the old 32-char exact-prefix substring. A plan still `applying` at exactly its expiry is recovered immediately, with no extra TTL wait. Correction-contract config is parsed in one extracted module with strict precedence and validation; the executor's LOCATE phase requires a non-empty candidate set even for actions that need no candidates.

## Consequences
Ambiguous LLM output costs a failed attempt rather than a guessed plan; callers that cancel mid-attempt still observe the empty-plan outcome. The deterministic fallback is weaker than LLM planning by design. Tokenized search can surface keyword-overlap matches an exact match would not, so candidates must still be validated downstream.

## Origin comments
- `packages/remnic-core/src/correction/correction-access-wiring.ts:1057` — "// (an empty list is fine, an all-malformed list is unusable). Malformed"
- `packages/remnic-core/src/correction/correction-access-wiring.ts:1058` — "// siblings are dropped after selection, so one bad action cannot discard"
- `packages/remnic-core/src/correction/correction-access-wiring.ts:1059` — "// the whole plan; distinct eligible responses stay ambiguous (fail closed)."
- `packages/remnic-core/src/correction/correction-classify-parse.test.ts:1` — "/** * parseClassifyResponse regression tests (issue #3134). * * Proves the correction planner's single LLM-response pars"
- `packages/remnic-core/src/correction/correction-classify.ts:77` — "// A timeout abort belongs to this attempt. Fall through unless the"
- `packages/remnic-core/src/correction/correction-classify.ts:78` — "// operator turned the gateway path off."
- `packages/remnic-core/src/correction/correction-classify.ts:110` — "// The attempt signal aborts on its own budget. That is a finished miss"
- `packages/remnic-core/src/correction/correction-classify.ts:111` — "// (empty plan), not a caller disconnect — only the caller signal skips"
- `packages/remnic-core/src/correction/correction-classify.ts:112` — "// the empty-plan path."
- `packages/remnic-core/src/correction/correction-classify.ts:140` — "// A ref'd timer, not AbortSignal.timeout: that helper's timer is unref'd,"
- `packages/remnic-core/src/correction/correction-classify.ts:141` — "// so a classify wait would not keep a short-lived caller alive until the"
- `packages/remnic-core/src/correction/correction-classify.ts:142` — "// budget elapses."
- `packages/remnic-core/src/correction/correction-config.ts:1` — "/** * Correction-contract config (issue #1580 plus classify timeout). * * Extracted from config.ts so the gran"
- `packages/remnic-core/src/correction/correction-contract.ts:488` — "/** * Deterministic fallback plan (rule 13): when the planner's LLM is * unavailable, the plan degrades to a s"
- `packages/remnic-core/src/correction/correction-executor.test.ts:844` — "// No candidates needed for a redaction_rule, but the planner still needs a"
- `packages/remnic-core/src/correction/correction-executor.test.ts:845` — "// non-empty candidate set to proceed past LOCATE. Use a placeholder."
- `packages/remnic-core/src/correction/correction-planner.test.ts:476` — "// The wiring's searchMemories tokenizes the correction text and matches by"
- `packages/remnic-core/src/correction/correction-planner.test.ts:477` — "// keyword overlap, so "we migrated from Postgres to MySQL" finds a memory"
- `packages/remnic-core/src/correction/correction-planner.test.ts:478` — "// that says "Postgres is the database" — the old 32-char exact-prefix"
- `packages/remnic-core/src/correction/correction-planner.test.ts:479` — "// substring missed this. The planner delegates to deps.searchCorpus, so we"
- `packages/remnic-core/src/correction/correction-planner.test.ts:480` — "// verify the planner passes the FULL text and the tokenized search dep"
- `packages/remnic-core/src/correction/correction-planner.test.ts:481` — "// (mirroring the wiring logic) locates the memory."
- `packages/remnic-core/src/correction/correction-planner.test.ts:790` — "// Recovery at exactly expiresAt: plan is already expired -> recover now"
- `packages/remnic-core/src/correction/correction-planner.test.ts:791` — "// (review thread ff034716: no extra TTL wait for pre-fix plans)"
