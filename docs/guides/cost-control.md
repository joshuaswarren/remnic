# Cost control guide

Start with the preset that matches your appetite for latency and churn:

- `conservative`: smallest advanced surface, lowest ongoing spend
- `balanced`: recommended default for most installs
- `research-max`: broadest shipped experimental surface
- `local-llm-heavy`: biases expensive helper/extraction paths toward local inference

## Budget mapping

The original roadmap named budgets at a higher level than the current runtime surface. Use this mapping when tuning a live install:

| Roadmap knob | Live config surface |
|--------------|---------------------|
| `maxRecallTokens` | `maxMemoryTokens` and `recallBudgetChars` |
| `maxRecallMs` | Use stage-specific limits such as `recallPlannerTimeoutMs`, `conversationRecallTimeoutMs`, and `rerankTimeoutMs` |
| `maxCompressionTokensPerHour` | `maxCompressionTokensPerHour` |
| `maxGraphTraversalSteps` | `maxGraphTraversalSteps` |
| `maxArtifactsPerSession` | No dedicated per-session cap; use `verbatimArtifactsEnabled`, `verbatimArtifactsMaxRecall`, and artifact-category scoping |
| `maxProactiveQuestionsPerExtraction` | `maxProactiveQuestionsPerExtraction` |
| `maxProactiveExtractionMs` | `proactiveExtractionTimeoutMs` |
| `maxProactiveExtractionTokens` | `proactiveExtractionMaxTokens` |
| `indexRefreshBudgetMs` | Use `qmdUpdateMinIntervalMs`, `qmdUpdateTimeoutMs`, and `conversationIndexMinUpdateIntervalMs` |

## Lowest-risk rollout

1. Start with `memoryOsPreset: "conservative"` or `memoryOsPreset: "balanced"`.
2. Keep `maxCompressionTokensPerHour` and `maxProactiveQuestionsPerExtraction` at their defaults until baseline recall is stable.
3. Keep `proactiveExtractionTimeoutMs` and `proactiveExtractionMaxTokens` low until you trust the second-pass memory additions.
4. Raise `maxMemoryTokens` only after you know which sections are providing real value.
5. Enable graph traversal only after checking that standard recall already finds the right seeds.

## Practical levers

- If recall payloads are too large, lower `maxMemoryTokens` before changing per-section budgets.
- If ranking is too slow, lower `rerankTimeoutMs` and keep rerank fail-open.
- If transcript recall is too expensive, lower `conversationRecallTopK` or `conversationRecallMaxChars`.
- If compression-learning churn is too high, set `maxCompressionTokensPerHour: 0`.
- If proactive extraction is noisy, set `maxProactiveQuestionsPerExtraction: 0`.
- If proactive extraction is slow, lower `proactiveExtractionTimeoutMs` or `proactiveExtractionMaxTokens`, or set either to `0` to hard-disable the second pass.

## What Remnic does not currently expose

Two roadmap knobs remain intentionally unshipped as first-class fields:

- a single global `maxRecallMs`
- a dedicated `maxArtifactsPerSession`

Remnic uses stage-specific timeouts and artifact gating instead. That keeps the live runtime aligned with the actual retrieval paths rather than pretending everything can be bounded by one coarse timer.
