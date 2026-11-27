# LLM recall planning routes through provider-qualified models, gates once on the resolved capability, and falls back silently-but-warned to the heuristic

Status: accepted

## Context
Recall planning can use an LLM to classify a prompt into a recall plan, but the LLM is optional: plugin mode may have no routable model, the legacy default model name is bare (unresolvable by the fallback client), config toggles can disagree with the resolved capability set, and an outer recall may already be aborted. Naive handling either spams warnings per call, starts network calls that can never succeed, or ignores an operator's explicit model override.

## Decision
Route the planner through FallbackLlmClient with these rules: a `recallPlannerModel` override is usable only when provider-qualified (`provider/model`); a bare legacy default is unresolvable and drops so routing falls through to the gateway chain — with no chain there is nothing routable and the planner short-circuits to the heuristic. taskModelChain wins over the agent persona. The capability gate is resolved ONCE at the recall-operation entry (issue #1523): the planner reads the resolved capability and never re-derives it from raw config, so a resolution that says disabled stops the LLM even when raw config says enabled. The planner participates in the recall cancellation contract: if the outer recall is already aborted it falls back to the heuristic immediately, and it forwards the abort signal so an aborted/timed-out recall cancels an in-flight planner call. Availability checks use the same routing options so plugin-mode/empty chains short-circuit without a network attempt; an opted-in operator with nothing routable gets ONE warning per distinct routing signature (not per call), then the heuristic runs; cancellation by the outer recall is expected and not warned. Empty prompts never need an LLM round-trip. Planner tests exercise the real output schema so malformed scripted output is caught too. The per-script closed-class cue tables keep English membership identical to the previous regex alternation, and prompt-filler recall verbs in other languages do not count as content discriminators in the direct-answer gate.

## Consequences
Operators with a bare or unroutable model silently get heuristic planning (warned once). A session-level capability toggle off cannot be overridden by config alone. Heuristic fallback output differs from LLM-planned output.

## Origin comments
(42 records)
- `packages/remnic-core/src/recall-planner-i18n.ts:1` — "/** * Per-script closed-class cue tables and script-agnostic signal helpers * shared by the recall planner heuristics..."
- `packages/remnic-core/src/recall-planner-i18n.ts:48` — "// English (membership identical to the previous regex alternation)"
- `packages/remnic-core/src/recall-planner-i18n.ts:173` — "// Prompt-filler words (recall verbs in other languages) that must not count"
- `packages/remnic-core/src/recall-planner-i18n.ts:174` — "// as content discriminators in the direct-answer gate."
- `packages/remnic-core/src/recall-planner-llm.test.ts:32` — "// Exercise the real schema so malformed scripted output is caught too."
- `packages/remnic-core/src/recall-planner-llm.test.ts:87` — "// taskModelChain wins over the agent persona (gotcha #22)."
- `packages/remnic-core/src/recall-planner-llm.test.ts:135` — "// The legacy default recallPlannerModel "gpt-5.5" is bare (no provider/),"
- `packages/remnic-core/src/recall-planner-llm.test.ts:136` — "// which FallbackLlmClient cannot resolve — so with no gateway chain there is"
- `packages/remnic-core/src/recall-planner-llm.test.ts:137` — "// nothing routable and the planner must short-circuit to the heuristic"
- `packages/remnic-core/src/recall-planner-llm.test.ts:138` — "// (issue #1367 review on PR #1428), not log an invalid-model warning per call."
- `packages/remnic-core/src/recall-planner-llm.test.ts:152` — "// A qualified `provider/model` override is genuinely routable, so we attempt"
- `packages/remnic-core/src/recall-planner-llm.test.ts:153` — "// it even when the chain probe reports unavailable, then fall back on a null"
- `packages/remnic-core/src/recall-planner-llm.test.ts:154` — "// response."
- `packages/remnic-core/src/recall-planner-llm.test.ts:215` — "// Bare "gpt-5.5" is unresolvable by FallbackLlmClient → dropped (routing falls"
- `packages/remnic-core/src/recall-planner-llm.test.ts:216` — "// through to the chain); a qualified value is forwarded as the override."
- `packages/remnic-core/src/recall-planner-llm.test.ts:228` — "// Issue #1523 contract: the capability resolved at the operation entry is"
- `packages/remnic-core/src/recall-planner-llm.test.ts:229` — "// THE gate. Construct a deliberate mismatch: config says enabled, but the"
- `packages/remnic-core/src/recall-planner-llm.test.ts:230` — "// resolved CapabilitySet says disabled. The function must NOT call the LLM."
- `packages/remnic-core/src/recall-planner-llm.test.ts:235` — "// Manually construct caps with recallPlannerLlm: false (simulating a"
- `packages/remnic-core/src/recall-planner-llm.test.ts:236` — "// resolution that disagrees with the raw config — e.g. session toggle off)."
- `packages/remnic-core/src/recall-planner-llm.ts:14` — "/** * LLM-based recall planning (issue #1367, Option C). * * Classifies an incoming prompt into a {@link RecallPlanMo..."
- `packages/remnic-core/src/recall-planner-llm.ts:117` — "/** * Resolve the FallbackLlmClient routing options for the recall planner. * * - The dedicated `recallPlannerModel` ..."
- `packages/remnic-core/src/recall-planner-llm.ts:129` — "/** * A `recallPlannerModel` value is only usable as a FallbackLlmClient `model` * override when it is provider-quali..."
- `packages/remnic-core/src/recall-planner-llm.ts:163` — "// One-time warning per distinct routing signature so an opted-in operator with"
- `packages/remnic-core/src/recall-planner-llm.ts:164` — "// no usable model learns why planning silently uses the heuristic, without"
- `packages/remnic-core/src/recall-planner-llm.ts:165` — "// spamming a line on every recall."
- `packages/remnic-core/src/recall-planner-llm.ts:197` — "// The recall-operation entry resolved this gate once (issue #1523); read the"
- `packages/remnic-core/src/recall-planner-llm.ts:198` — "// capability, never re-derive it from raw config here."
- `packages/remnic-core/src/recall-planner-llm.ts:204` — "// Participate in the recall cancellation contract: if the outer recall is"
- `packages/remnic-core/src/recall-planner-llm.ts:205` — "// already aborted (outer timeout / reset / session abort), don't start an LLM"
- `packages/remnic-core/src/recall-planner-llm.ts:206` — "// round-trip — fall back to the heuristic immediately (#1428 review)."
- `packages/remnic-core/src/recall-planner-llm.ts:213` — "// Empty prompts never need an LLM round-trip."
- `packages/remnic-core/src/recall-planner-llm.ts:224` — "// Forward the recall abort signal so an aborted/timed-out outer recall can"
- `packages/remnic-core/src/recall-planner-llm.ts:225` — "// cancel an in-flight planner call (FallbackLlmClient honors `signal`)."
- `packages/remnic-core/src/recall-planner-llm.ts:228` — "// Availability check uses the same routing options so plugin-mode / empty"
- `packages/remnic-core/src/recall-planner-llm.ts:229` — "// chains short-circuit to the heuristic without a network attempt. `model`"
- `packages/remnic-core/src/recall-planner-llm.ts:230` — "// here is already provider-qualified (bare names were dropped), so a present"
- `packages/remnic-core/src/recall-planner-llm.ts:231` — "// model means the override is genuinely routable."
- `packages/remnic-core/src/recall-planner-llm.ts:237` — "// Opted-in but nothing routable resolves (e.g. plugin mode with the bare"
- `packages/remnic-core/src/recall-planner-llm.ts:238` — "// default `recallPlannerModel` and no gateway chain). Warn once so it's not"
- `packages/remnic-core/src/recall-planner-llm.ts:239` — "// a silent no-op, then fall back to the heuristic."
- `packages/remnic-core/src/recall-planner-llm.ts:281` — "// Cancelled by the outer recall — expected, not an error worth warning on."
