# Benchmark integrity

The Remnic benchmark suite is designed to be published externally
(the `remnic.ai` leaderboard is the primary consumer). Public leaderboards
are attractive targets for exploitation: Berkeley RDI's 2026 analysis
showed that every major agent benchmark it surveyed could be pushed to
near-perfect scores without actually solving the underlying tasks. This
document specifies the integrity safeguards Remnic applies end-to-end.

## Threat model

The benchmark pipeline spans three roles:

1. **Runner.** Drives the System Under Test (SUT) through a set of tasks.
   The runner must never see ground-truth answers.
2. **Judge/Scorer.** Consumes SUT responses plus sealed qrels and emits
   scores. The judge is trusted with qrels; the runner is not.
3. **Publisher.** Takes result payloads and forwards them to the
   `remnic.ai` leaderboard. The publisher verifies provenance and rejects
   malformed or contaminated results.

Adversary capabilities we defend against:

| # | Exploit class              | Defence                                                                 |
|---|----------------------------|-------------------------------------------------------------------------|
| 1 | Ground-truth-in-prompt      | Qrels live only in sealed artifacts decrypted inside the judge process. |
| 2 | Regex-gameable scoring      | Scorers reject answers that match only the format regex.                |
| 3 | Judge sycophancy            | Deterministic canary run + sycophancy-injection test in CI.             |
| 4 | Eval contamination          | Per-result `datasetHash` checked against a contamination manifest.      |

Adversary capabilities we do **not** defend against:

- Targeted model-training-data poisoning (out of scope for a memory benchmark).
- Insider access to the KMS backing the seal key.

## Sealed artifacts

### Qrels

Ground-truth answers are stored as a `SealedQrelsArtifact`:

```json
{
  "benchmark": "<benchmark-id>",
  "version": 1,
  "sealHash": "<sha256 of canonical envelope JSON>",
  "envelope": {
    "version": 1,
    "algorithm": "aes-256-gcm",
    "iv": "<base64 96-bit IV>",
    "tag": "<base64 128-bit GCM tag>",
    "ciphertext": "<base64 AES-256-GCM ciphertext>",
    "plaintextHash": "<sha256 of decrypted plaintext>"
  }
}
```

Invariants:

- `sealHash` is computed over the canonical JSON of `envelope` with sorted
  keys so equivalent payloads hash identically.
- `plaintextHash` is verified after decryption as defence in depth against
  key-rotation bugs and ciphertext-vs-tag drift.
- The runner process receives **only** `sealHash`. The judge/scorer
  process is the only caller of `openSeal`.

### Judge prompts

The rendered judge prompt (post-template expansion) is hashed and stored
in `BenchmarkResult.meta.judgePromptHash`. A prompt drift invalidates the
result: the audit workflow rejects the result if the recorded hash does
not match the live prompt template.

### Dataset payloads

Each result records `datasetHash` — the SHA-256 of the dataset payload
served to the runner. The publishing pipeline refuses a result whose
`datasetHash` appears on the contamination manifest.

## Public / holdout split

Every benchmark has two splits:

- **public** — shipped with the repo. Used for local iteration and
  self-reporting. Never enters the published leaderboard feed.
- **holdout** — never committed to the repo. Used only for leaderboard
  submissions. Stored in the sealed artifact and unsealed exclusively
  inside the judge process.

The publishing pipeline rejects any result whose `meta.splitType !==
"holdout"`.

## Rotation policy

| Artifact            | Rotation trigger                                                       | Owner       |
|---------------------|------------------------------------------------------------------------|-------------|
| Seal key (AES-256)  | Every 90 days; on every key custodian change; after any suspected leak | Ops         |
| Sealed qrels        | On rotation of seal key; on any task-set change                        | Bench lead  |
| Judge prompts       | On every prompt template change                                        | Bench lead  |
| Dataset payload     | On every task-set change                                               | Bench lead  |
| Contamination list  | Append-only; reviewed quarterly for stale entries                      | Bench lead  |

Rotation procedure:

1. Generate a new 256-bit key via `openssl rand -base64 32`.
2. Store the new key in the KMS backing `REMNIC_BENCH_SEAL_KEY`.
3. Re-seal every holdout qrels file with the new key. Commit the new
   artifacts; the old artifacts are retired immediately.
4. Update each benchmark's pinned `qrelsSealedHash`.
5. Run the exploit-audit workflow against `main` to confirm every
   benchmark's canary stays under the floor.
6. Revoke the old key in the KMS.

## CI gates

### `bench-exploit-audit.yml`

Runs on every PR touching `packages/bench/`, `packages/bench-ui/`, or
the workflow itself. Executes:

1. Integrity unit tests (`packages/bench/src/integrity/**/*.test.ts`).
2. `scripts/bench-exploit-audit.ts` which mirrors the four Berkeley RDI
   exploit classes against every registered benchmark:
   - **ground_truth_in_prompt**: verifies the runner-visible recall
     surface never contains a ground-truth token.
   - **regex_gameable_format**: verifies a strict answer regex rejects a
     content-free canary response.
   - **judge_sycophancy**: verifies a sycophantic memory injection does
     not boost the canary score above the floor.
   - **eval_contamination**: verifies the contamination guard flags a
     known-dirty dataset hash.
3. Per-benchmark canary run using the `CanaryAdapter`. If the canary
   scores above `REMNIC_BENCH_CANARY_FLOOR` (default `0.1`) on any
   benchmark, the workflow fails and the benchmark is flagged as
   exploitable.

### Publishing

`buildBenchmarkPublishFeed` refuses any result whose `meta` is missing
any of `splitType`, `qrelsSealedHash`, `judgePromptHash`, `datasetHash`.
Results with `splitType: "public"` are skipped from the leaderboard feed.

## Result schema

`BenchmarkResult.meta` carries the following integrity-specific fields:

| Field              | Type                  | Required | Notes                                                     |
|--------------------|-----------------------|----------|-----------------------------------------------------------|
| `splitType`        | `"public" \| "holdout"` | Yes      | Leaderboard feed accepts only `holdout`.                  |
| `qrelsSealedHash`  | `string` (64-char hex) | Yes      | Must match the seal hash of the qrels used by the judge.  |
| `judgePromptHash`  | `string` (64-char hex) | Yes      | SHA-256 of the rendered judge prompt.                     |
| `datasetHash`      | `string` (64-char hex) | Yes      | SHA-256 of the dataset payload served to the runner.      |
| `canaryScore`      | `number`              | No       | Canary-adapter score from the audit run that produced this result. |

## Randomization

Runners seed three randomization helpers per run:

- `shuffleTasks(tasks, seed)` — Fisher-Yates shuffle so position-in-prompt
  effects cancel across runs.
- `rotateDistractors(question, seed)` — MCQ answer position and distractor
  set rotate per run.
- `selectFixtureVariant(variants, seed)` — picks a variant fixture so no
  run overfits to a single graph layout.

The PRNG is seeded mulberry32: deterministic per seed, fast, and small.
It is **not** cryptographically secure and must not be used for seal
keys or IV generation.
