# Procedural recall benchmark

The **procedural-recall** benchmark scores how well Remnic injects a stored
procedure into the recall context when the user's prompt looks like
task initiation. It is the source of the lift number that justifies
flipping `procedural.enabled` to `true` by default (issue #567).

> **Do not commit real user prompts.** The repository is public. The
> fixture under `packages/bench/src/benchmarks/remnic/procedural-recall/real-scenarios.ts`
> is synthetic and hand-authored. If you add scenarios, keep them
> synthetic.

## How the number is produced

1. The fixture in `real-scenarios.ts` carries **20 synthetic scenarios**
   grouped across four categories:
   - `exact-re-run` (5) — prompt matches a stored procedure near-verbatim.
   - `parameter-variation` (5) — same verb + goal, different nouns (service
     name, environment, ticket id).
   - `decomposition` (5) — prompt kicks off a multi-step runbook.
   - `distractor-rejection` (5) — prompt looks task-shaped but should NOT
     recall (past tense, summary request, unrelated domain, courtesy).
2. The ablation harness from
   [#586](https://github.com/joshuaswarren/remnic/pull/586) seeds a temp
   `StorageManager` per scenario with the scenario's procedure, then runs
   `buildProcedureRecallSection` twice: once with `procedural.enabled=true`
   and once with `procedural.enabled=false`.
3. Binary correctness (did recall produce a non-null section when
   `expectMatch=true` and stay null when `expectMatch=false`) is averaged
   across scenarios. `lift = onScore - offScore`.
4. A seeded mulberry32 RNG drives the bootstrap confidence interval, so
   regenerated artifacts are byte-stable on the same fixture.

## Current published numbers

The committed baseline lives at
[`packages/bench/baselines/procedural-recall-baseline.json`](../../packages/bench/baselines/procedural-recall-baseline.json).

| Metric   | Value |
| -------- | ----- |
| Scenarios | 20    |
| `onScore` | 0.75 |
| `offScore` | 0.25 |
| `lift`    | 0.50 (50 points) |
| Seed      | `0x72656d6e` |

Interpretation: with procedural recall ON, Remnic correctly labels 15 of
the 20 scenarios (all 5 distractors + 10 of the 15 task-initiation rows).
With procedural recall OFF, only the 5 distractor rows score — the gate
returns null for everything else, which is the correct behavior on
distractors and the wrong behavior on the task rows. The difference is the
published lift.

The 5 task-initiation rows that ON still misses are
parameter-variation / decomposition cases where the synthetic procedure's
vocabulary diverges enough from the prompt that the current token-overlap +
intent-classifier composite does not clear the 0.04 threshold. They are
the upside an LLM-scored procedure matcher would capture; we keep them in
the fixture so a future scoring improvement shows up as lift.

## Regenerating the baseline

The baseline is deterministic:

```bash
pnpm --filter @remnic/bench run build
tsx packages/bench/scripts/generate-procedural-recall-baseline.ts
git add packages/bench/baselines/procedural-recall-baseline.json
git commit -m "bench(procedural): refresh baseline"
```

The `procedural-recall-baseline.json matches a fresh deterministic run`
unit test asserts that a live ablation run reproduces every field in the
committed baseline. If scenarios change, update the baseline in the same
commit.

## Running the ablation against your own fixture

Use the CLI from PR 1 (#586):

```bash
remnic bench procedural-ablation \
  --fixture ./my-fixture.json \
  --out /tmp/my-ablation.json \
  --seed 42
```

`my-fixture.json` must be either a bare array of scenarios or
`{ "scenarios": [...] }`. Each scenario requires `id`, `prompt`,
`procedurePreamble`, `procedureSteps`, `procedureTags`, and `expectMatch`.

## Human runbook: gpt-4o-mini oracle

The committed number is produced by the deterministic, LLM-free
composite scorer (`buildProcedureRecallSection`). For a human to validate
the fixture's `expectMatch` labels with a real model:

1. Install `openai` and export `OPENAI_API_KEY` in your shell.
2. For each scenario with `expectMatch: true`, hand-pipe the prompt + the
   stored procedure body into gpt-4o-mini (via the OpenAI Responses API,
   per CLAUDE.md) with an instruction like:
   > "Given this procedure and this user turn, answer yes/no: should the
   > assistant start executing the procedure right now?"
3. For `expectMatch: false` scenarios, the model should answer "no".
4. A fixture is accepted once gpt-4o-mini agrees with the `expectMatch`
   label on ≥ 90% of rows. Record disagreements in your PR description.

This step is **not automated** and **must not be run in CI** — costs and
rate limits would creep into every green build. Keep the deterministic
path as the canonical baseline; the LLM oracle is a manual audit only.

## Acceptance criteria (issue #567 PR 2/5)

- [x] ≥ 20 synthetic scenarios spanning all four categories.
- [x] Committed `procedural-recall-baseline.json` with a recorded lift.
- [x] Unit test asserts `lift >= 3 points` on a fresh deterministic run.
- [x] Unit test asserts baseline JSON matches a fresh run (anti-drift).
- [x] Deterministic seed — no LLM calls in the test path.

Downstream slices:

- **PR 3/5** — only raises floor thresholds; does not flip the default.
- **PR 4/5** — flips `procedural.enabled` default to `true` across both
  plugin manifests and `parseConfig`.
- **PR 5/5** — adds `remnic procedural stats` CLI + HTTP + MCP surface.
