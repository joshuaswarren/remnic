# H1 outcome-prior fixtures

These files are scaffolding for issue #1958. They freeze the arms and the
pass rule from the build plan. They are not a warmed store and they are not
experiment results.

- `decision-rule.json` — locked-test pass rule (5% relative recall gain, 95%
  interval strictly above 0, p < .05).
- `arms/h1-w0.json` — H1 path with the outcome blend weight at 0, and the
  competing boosts forced off. This is not the live production default.
- `arms/h1-w015.json`, `arms/h1-w030.json`, `arms/h1-w050.json` — pick-stage
  weights {0.15, 0.30, 0.50} with the same isolation flags and the same
  retrieval budget.
- `arms/memory-worth-base.json` — Memory Worth filter on, outcome blend off.
  Other boosts are left unset so they stay at production defaults.

`remnic bench ablate outcome-prior` loads this directory and refuses
`--phase warm`, `--phase pilot`, and `--phase main`. It does not write a
result JSONL.
