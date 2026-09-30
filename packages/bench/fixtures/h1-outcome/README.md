# H1 outcome-prior fixtures

These files freeze the arms, the pass rule, and a synthetic task family for
issue #1958. They are not experiment results. Nothing here claims H1
SUPPORTED.

- `decision-rule.json` — locked-test pass rule (5% relative recall gain, 95%
  interval strictly above 0, p < .05).
- `arms/h1-w0.json` — H1 path with the outcome blend weight at 0, and the
  competing boosts forced off. This is not the live production default.
- `arms/h1-w015.json`, `arms/h1-w030.json`, `arms/h1-w050.json` — pick-stage
  weights {0.15, 0.30, 0.50} with the same isolation flags and the same
  retrieval budget.
- `arms/memory-worth-base.json` — Memory Worth filter on, outcome blend off.
  Other boosts are left unset so they stay at production defaults.
- `tasks.jsonl` — mechanical tasks derived from drift-gen with
  `--users 5 --epochs 12 --seed 21` (at least 40 `successCheck` lines, type
  `regex` only). Gold ids resolve against that recipe. The 5×12 session tree
  is not committed.
- `corpus-ci/` — the committed CI snapshot: 2 users, 4 epochs, seed 21,
  12 tasks, and `warm-store.json`. This is a gate fixture, not the locked
  epoch split.

## Regeneration

From the repo root, after a drift-gen change:

```bash
pnpm exec tsx packages/bench/fixtures/h1-outcome/regenerate.ts
remnic bench drift-gen validate packages/bench/fixtures/h1-outcome/corpus-ci
```

The script writes `tasks.jsonl`, `corpus-ci/tasks.jsonl`, `corpus-ci/warm-store.json`,
and the 2×4 seed-21 drift-gen tree. Optional drift-gen flags are omitted so
the recipe uses the generator defaults (`factsPerEpoch` 8, `driftingRatio`
0.2, `contradictedRatio` 0.1).

The full session corpus stays local:

```bash
remnic bench drift-gen --users 5 --epochs 12 --seed 21 --out <local-dir>
```

Do not commit that tree or a warmed tarball. `tasks.jsonl` gold ids do not
resolve against `corpus-ci/`.

Every fourth task (0-based index `n % 4 === 3`) answers `unresolved` and
fails its check. The other tasks answer the gold values joined by ` | `.
The check value is the escaped literal of that answer. Matching is string
equality, not a constructed regular expression.

## What the CLI does

`remnic bench ablate outcome-prior` loads this directory and refuses
`--phase warm`, `--phase pilot`, and `--phase main`, including when `--gates`
is also present. Any other flag, a repeated flag, or a phase outside that
set is rejected and does not run the gates. The synchronous
`runOutcomePriorScaffoldCli` helper rejects `--gates`; the CLI calls
`runOutcomePriorGatesCli`. `--gates` runs the pre-main
checks on `corpus-ci/` only: drift-gen validation, warm verification
(per-fact counters must match the replay), a fake-model smoke twice (hashes
must match), arm-order invariance of each arm's rows, and an unchanged
warm-store hash. A snapshot that cannot be loaded is a structured gate
failure. It does not write a result JSONL and it does not decide H1.
