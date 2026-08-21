# Assistant Rubric — Sealing & Rotation Policy

The Assistant/Personalization bench tier uses a sealed LLM-judge rubric to
score agent outputs. This document records the rubric dimensions, the sealing
contract, and the rotation policy.

## Rubric dimensions

Each task is scored on four dimensions, integer scale `0`–`5`:

- **identity_accuracy** — does the output correctly represent facts about the
  user (role, relationships, preferences, timeline)? Hallucinated identity
  claims are penalized.
- **stance_coherence** — when the brain has prior expressed opinions or
  decisions on a topic, does the output reflect them consistently?
  Contradictions are penalized.
- **novelty** — does the output synthesize across memory items, or does it
  regurgitate the single top-k chunk? Pure regurgitation is scored low.
- **calibration** — did the agent abstain when evidence was insufficient?
  Over-confident wrong claims are penalized more than honest abstentions.

The per-dimension scores are surfaced individually in the bench result's
`aggregates` block. The `overall` key is the arithmetic mean across the four
dimensions and is provided as a single-number convenience metric — dashboards
should always show the four dimensions with CI error bars rather than just
`overall`.

## Sealing contract

The rubric prompt text is authoritative in exactly two places:

1. **TypeScript registry**: `packages/bench/src/judges/sealed-prompts/`.
   The `.ts` file is the source the runtime loads. Its entries are exported
   from `SEALED_PROMPT_REGISTRY`.
2. **Human-readable mirror**: a matching `.md` file in the same directory.
   This mirror exists for reviewers and must stay byte-identical to the
   registry text.

Every benchmark result embeds the loaded rubric's id and SHA-256 digest in
`config.remnicConfig`:

```json
{
  "config": {
    "remnicConfig": {
      "assistantRubricId": "assistant-rubric-v1",
      "assistantRubricSha256": "<hex-digest>",
      "assistantRunId": "assistant-morning-brief-<iso>"
    }
  }
}
```

This lets consumers of the bench feed detect rubric drift between runs.

### Do not expose the rubric to the system under test

The sealed prompt text is sent **only** to the structured judge. The agent
being benchmarked sees the scenario prompt and a rendered memory view. The
runner deliberately keeps the rubric on the judge-side channel
(`runSealedJudge` in `sealed-rubric.ts`) to prevent Goodharting.

## Rotation policy

Rubrics are versioned by filename (`assistant-rubric-v1.md`,
`assistant-rubric-v2.md`, ...). The policy:

- **Additive rotations only.** Never edit an existing entry in place — even
  small wording changes would invalidate historical results that embed the
  older digest.
- **Write a new entry.** Add both a `.ts` registry entry and a matching
  `.md` mirror. Bump the default in
  `sealed-prompts/index.ts::DEFAULT_ASSISTANT_RUBRIC_ID` when the new rubric
  is ready to replace the default.
- **Keep old entries available.** Historical benchmark results remain
  reproducible because the loader is keyed by id.
- **Rotation cadence.** Plan a rubric review at least once per quarter, or
  whenever the team observes judge Goodharting (e.g. agent outputs drifting
  toward rubric-pleasing phrasing rather than genuine quality).
- **Rotation announcement.** Every rotation lands as its own PR with a
  changelog entry that lists the old + new rubric ids and their digests.

## Spot-check log

For every run, the runner writes a JSONL log of sampled judge decisions to
`<spot-check-dir>/<run-id>.jsonl`. Each entry has:

- `taskId` — includes the seed suffix (e.g. `morning-brief.monday-priorities#seed-3`)
- `rubricId`, `rubricSha256`
- `scores` (four dimensions)
- `notes` (the judge's free-form justification)
- `parseOk`
- `scenarioPreview` and `outputPreview` (240-char previews)

The default sample rate is 35% with a cap of 5 entries per run. Tests use a
deterministic logger that always samples the first N entries.

## Statistical reporting

Assistant-tier benchmarks require more than a bare mean because LLM-judge
scoring is inherently noisier than exact-match scoring.

- **Per-task**: 5 seeded runs (`runCount >= 5` in full mode, 2 in quick
  mode). Seeds are passed through `meta.seeds` so runs can be reproduced.
- **Per-dimension**: bootstrap 95% CI on the per-task means, via
  `bootstrapMeanConfidenceInterval` in `packages/bench/src/stats/bootstrap.ts`.
  CIs are written into `results.statistics.confidenceIntervals`.
- **Dashboard**: the Assistant section of `@remnic/bench-ui` renders one
  bar per dimension with CI error bars and shows a spot-check viewer that
  loads the JSONL log for the selected run.

## Wiring — real runs

Real benchmark runs must inject a provider-backed agent and a structured
judge through the `remnicConfig` hook. Example:

```ts
import {
  runBenchmark,
  type AssistantAgent,
  type StructuredJudge,
} from "@remnic/bench";

const agent: AssistantAgent = {
  async respond({ prompt, memoryView }) {
    // provider call that receives prompt + memoryView and returns text
  },
};

const judge: StructuredJudge = {
  async evaluate({ system, user }) {
    // provider call that sends `system` as system message and `user` as
    // user message, then returns the raw JSON response text for parsing.
  },
};

await runBenchmark("assistant-morning-brief", {
  mode: "full",
  system: memoryAdapter,
  remnicConfig: {
    assistantAgent: agent,
    assistantJudge: judge,
    assistantSeeds: [100, 101, 102, 103, 104],
    assistantSpotCheckDir: "benchmarks/results/spot-checks",
  },
});
```

See `packages/bench/src/benchmarks/remnic/_assistant-common/default-agent.ts`
for the full list of `remnicConfig` keys the Assistant tier reads.
