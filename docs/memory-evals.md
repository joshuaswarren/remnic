# Memory Evals

Agent memory without evals is vibes with a database.

Remnic memory evals measure whether user-aware memory improves agent outcomes
without crossing boundaries. The first-class contract lives in `@remnic/bench`
as `MEMORY_EVAL_DIMENSIONS`; each dimension maps to quick-capable benchmark
surfaces so CI can catch regressions without a second eval harness.

## Questions

| Dimension | Eval question | Quick benchmark coverage |
| --- | --- | --- |
| `repeated_context_reduction` | Did memory reduce repeated context? | `assistant-synthesis`, `assistant-morning-brief`, `longmemeval` |
| `unnecessary_clarification_reduction` | Did memory reduce unnecessary clarification? | `assistant-next-best-action`, `buffer-surprise-trigger` |
| `retrieval_correctness` | Did the agent retrieve the right memory? | `retrieval-personalization`, `retrieval-direct-answer`, `coding-recall` |
| `stale_memory_harm` | Did stale memory harm the answer? | `retrieval-temporal`, `retention-aged-dataset`, `contradiction-detection` |
| `scope_respect` | Did the agent respect scope? | `coding-recall`, `retrieval-personalization`, `memoryagentbench` |
| `ask_when_needed` | Did the agent ask when it should have asked? | `assistant-next-best-action`, `buffer-surprise-trigger` |
| `act_when_enough_context` | Did the agent act when it had enough context? | `assistant-next-best-action`, `assistant-morning-brief` |
| `personalization_quality` | Did personalization improve the output? | `retrieval-personalization`, `assistant-synthesis`, `personamem` |

## Metrics

The contract includes metric names and directionality for each dimension:

- repeated context: `repeated_context_turns_saved` and `context_repetition_rate`
- clarification: `low_value_clarification_rate` and `clarification_precision`
- retrieval: `memory_recall_at_k` and `memory_precision_at_k`
- freshness: `stale_memory_harm_rate` and `freshness_filter_success`
- scope: `scope_violation_rate` and `allowed_scope_recall`
- ask when needed: `required_ask_recall` and `unsafe_action_rate`
- act when ready: `unnecessary_interruption_rate` and `sufficient_context_action_rate`
- personalization: `personalization_lift` and `preference_alignment`

Lower is better for the rate metrics that describe harm, violations, or
unnecessary interruptions. Higher is better for recall, precision, lift, and
turns saved.

## Running Quick Coverage

Use the exported list when building CI or release checks:

```ts
import { listMemoryEvalBenchmarkIds } from "@remnic/bench";

for (const benchmarkId of listMemoryEvalBenchmarkIds()) {
  console.log(`remnic bench run --quick ${benchmarkId}`);
}
```

Quick mode is for regression detection. Full mode should compare memory-enabled
and memory-disabled runs, preserve provenance/scope annotations, and use sealed
qrels or rubric prompts for publishable claims.

`retrieval-personalization` includes synthetic commerce cases for buyer profile
matching and ask-before-checkout boundary retrieval. These are the eval hooks
used by the [Agentic Commerce Demo](agentic-commerce-demo.md).

`coding-recall` includes synthetic developer workflow cases for repo
conventions, architecture boundaries, test expectations, release process,
common failure modes, past bugs, review preferences, ask-before-public-API
rules, and always-run-checks rules. These cases report `workflow_coverage` and
back the [Developer Workflow Demo](developer-workflow-demo.md).
