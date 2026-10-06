# H2 write-vs-read fixtures

Scaffolding only. No warm, pilot, or main runs. No results.

These files freeze the four arms, the key allow-list, and the pass rule for
issue #1959. They are not experiment results. Nothing here claims H2
SUPPORTED.

- `decision-rule.json` — machine-readable pass rule. SUPPORTED only when W+
  beats R+ by at least 5% relative on both main datasets after Holm
  correction. One dataset passing is `REGIME-DEPENDENT`.
- `write-read-key-allowlist.json` — write keys, read keys, and the values
  held constant (Memory Worth, TrustScore, and the other recall boosts).
- `arms/baseline.json` — write profile and read profile both at the explicit
  low settings below.
- `arms/write-plus.json` — write profile raised, read profile unchanged.
- `arms/read-plus.json` — read profile raised, write profile unchanged.
- `arms/write-read-plus.json` — both profiles raised. `armCall` is
  `all test flags on`. `matchesReleaseConfig` is false. This is not a
  release preset.

No corpus, calibration set, exclusion list, or result file lives in this
directory.

## Explicit arm values

Write profile, low then raised:

| Key | Low | Raised |
| --- | ---: | ---: |
| `extractionJudgeEnabled` | false | true |
| `semanticDedupEnabled` | false | true |
| `semanticDedupCandidates` | 0 | 5 |
| `consolidateEveryN` | 1000000 | 2 |
| `entityAliasesEnabled` | false | true |
| `semanticMerge` | `{ "enabled": false }` | `{ "enabled": true }` |

`semanticMerge` is stored as the nested block `parseConfig` reads.
`parseSemanticMergeConfig` ignores a dotted `semanticMerge.enabled` key, so
the arm files do not use that spelling. Other fields in the block stay at
the parser defaults on every arm.

Read profile, low then raised:

| Key | Low | Raised |
| --- | ---: | ---: |
| `qmdSearchStrategy` | `lex` | `hybrid` |
| `rerankEnabled` | false | true |
| `recallMmrEnabled` | false | true |
| `queryExpansionEnabled` | false | true |
| `queryExpansionMaxQueries` | 0 | 4 |
| `qmdMaxResults` | 8 | 16 |
| `recallPlannerMaxQmdResultsFull` | 8 | 16 |

`semanticDedupCandidates: 0` is the documented disable for that lookup.
`consolidateEveryN: 1000000` is a cadence, not an off switch. See the gaps
below.

## Known config-key gaps

These knobs are named in the study design and have no existing config key.
They are left out. No new feature is added to stand in for them.

- Consolidation has no boolean disable. `consolidateEveryN: 0` does not turn
  the scheduler off (`count < 0` is never true). The low write profile uses
  cadence `1000000`.
- Query rewrite in `recall-query-policy.ts` has no general on/off key.
  `cronRecallPolicyEnabled` applies only to cron session keys and is not used
  here. The read profile toggles `queryExpansionEnabled`, which is the
  existing expansion gate.
- There is no headroom multiplier. The read profile changes the result caps
  `qmdMaxResults` and `recallPlannerMaxQmdResultsFull` (8 and 16). Fetch
  headroom stays the code path's own constant.
- There is no entity-consolidation boolean. `semanticConsolidationEnabled` is
  derived from the dreams rem cadence and is not an arm key.
  `entityAliasesEnabled` and the nested `semanticMerge.enabled` field are the
  existing alias and merge gates.

## What the CLI does

`remnic bench ablate write-vs-read` loads this directory, prints the arms,
the allow-list, and the decision rule, and exits 0 with `runsExecuted: 0`.
`WRITE_VS_READ_RUNS_ENABLED` is false. `--phase warm`, `--phase pilot`,
`--phase main`, `--seeds`, and `--corpus` are refused and run nothing. A
phase outside that set is rejected. The command writes no result file.
