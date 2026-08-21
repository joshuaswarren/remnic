# PR34: Required Check Rollout And Docs

## Goal

Finish the benchmark-gated release discipline wave by wiring the stored baseline
delta reporter into the required GitHub check that already guards pull requests.

## Why This Slice Exists

PR32 created named baseline snapshots.
PR33 created the typed delta reporter.
PR34 is the operational step that makes those capabilities matter: the required
`eval-benchmark-gate` workflow should now compare a PR candidate against a
stable named baseline snapshot from the base branch instead of only comparing
two ad hoc fixture stores.

## Scope

- keep the existing required workflow/job name: `eval-benchmark-gate`
- add a dedicated stored-baseline CI gate script
- add a committed fixture baseline snapshot for the required benchmark gate
- cover the stored-baseline gate with tests
- update README and evaluation docs to explain the required baseline contract

## Non-Goals

- no new memory subsystem
- no new plugin config flag
- no attempt to auto-update baseline snapshots in CI

## Implementation Notes

- use base-branch baseline snapshots and candidate-branch run artifacts
- allow a one-time bootstrap fallback to the candidate snapshot so the rollout PR can land before `main` contains `required-main`
- keep PR33's user-facing reporter behavior intact
- treat the committed fixture snapshot as an explicit contract:
  `tests/fixtures/eval-ci/store/baselines/required-main.json`

## Verification

- `npx tsx --test tests/evals-ci-gate.test.ts tests/eval-baseline-report.test.ts`
- `npm run check-types`
- `npm run check-config-contract`
- `npm test`
- `npm run build`
