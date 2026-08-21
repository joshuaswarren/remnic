# Remnic published-benchmark runbook

This runbook documents how to produce full published benchmark numbers
for Remnic and publish them to <https://remnic.ai/benchmarks>. It covers
the full `@remnic/bench` published registry: `ama-bench`,
`memory-arena`, `amemgym`, `longmemeval`, `locomo`, `beam`,
`personamem`, `memoryagentbench`, and `membench`.

Every step must be runnable from a fresh clone on a machine with
appropriate API keys; nothing auto-runs on CI.

> **Do not commit real user data.** The repository is public. Only the
> runner aggregates + per-task scores land in `docs/benchmarks/results/`.
> Never commit raw dataset files, API keys, or intermediate LLM traces.

> **Leaderboard safety.** Issues #841 through #850 hardened the
> published runners so exact cue recall uses user-visible or
> stored-in-memory evidence only. Hidden gold metadata remains reserved
> for scoring and reporting.

## 1. Prerequisites

- Node.js ≥ 22.12.0 and `pnpm` 10+.
- Dataset access for every benchmark you plan to run. Some datasets are
  script-managed through `remnic bench datasets download`; others are
  manual because their upstream projects require separate acceptance or
  credentials.
- A provider key or endpoint for the system model and judge model.
  Supported provider flags include OpenAI-compatible, Ollama, and
  local-LLM endpoints depending on the runtime profile.
- A dedicated benchmark memory directory. Do not point full benchmark
  runs at a production Remnic memory store.

## 2. One-time setup

```bash
pnpm install
pnpm --filter @remnic/core run build
pnpm --filter @remnic/bench run build
pnpm --filter @remnic/cli run build

# `remnic` is only exposed as a bin from the @remnic/cli workspace
# package. From repo root use either the shim below or add
# `packages/remnic-cli/bin` to your PATH for the duration of the run.
alias remnic='pnpm --filter @remnic/cli exec remnic'

# Inspect available benchmark ids and managed dataset status.
pnpm --filter @remnic/cli exec remnic bench list
pnpm --filter @remnic/cli exec remnic bench datasets status
```

Suggested local dataset layout:

```
bench-datasets/
  ama-bench/
  memory-arena/
  amemgym/
  longmemeval/
    longmemeval_oracle.json          # preferred
    longmemeval_s_cleaned.json       # optional alternate
  locomo/
    locomo10.json                    # preferred
  beam/
  personamem/
  memoryagentbench/
  membench/
```

`bench-datasets/` is gitignored. Never commit it.

## 3. Run One Published Benchmark

```bash
pnpm --filter @remnic/cli exec remnic bench run longmemeval \
  --runtime-profile real \
  --dataset-dir ./bench-datasets/longmemeval \
  --system-provider ollama \
  --system-model <model-id> \
  --judge-provider ollama \
  --judge-model <judge-model-id> \
  --seed 1
```

`--system-provider` + `--system-model` pin the responder;
`--judge-provider` + `--judge-model` pin the LLM judge. Without these
flags, `remnic bench run` falls back to the default provider from local
configuration, which makes published numbers harder to reproduce.

The runner:

1. Loads the selected full dataset.
2. Resets the Remnic orchestrator for each item.
3. Ingests the benchmark's memory sessions into the isolated benchmark
   adapter.
4. Recalls + answers each question with the pinned system model.
5. Scores via benchmark-specific metrics and the pinned judge.
6. Writes a `BenchmarkResult` JSON under the default results store
   unless `--results-dir` is supplied.

## 4. Run The Published Suite

Run each published benchmark one at a time for easier monitoring and
retry. A shell loop is acceptable, but keep the results directory and
status file for post-run audit.

```bash
for bench in ama-bench memory-arena amemgym longmemeval locomo beam personamem memoryagentbench membench; do
  pnpm --filter @remnic/cli exec remnic bench run "$bench" \
    --runtime-profile real \
    --dataset-dir "./bench-datasets/$bench" \
    --system-provider ollama \
    --system-model <model-id> \
    --judge-provider ollama \
    --judge-model <judge-model-id> \
    --seed 1
done
```

For AMA-Bench recommended judge runs, use the AMA-specific judge flags
documented by `remnic bench --help`, including the recommended protocol
and cross-validation options when available.

## 5. Verify artifacts before publishing

```bash
# Each artifact is validated + re-hashed. Exits non-zero on mismatch.
pnpm exec tsx scripts/bench/verify-artifact.ts \
  docs/benchmarks/results/*.json
```

The output line for each artifact shape is:

```
OK <filename> <benchmark> model=<id> seed=<n> metrics=<k>=<v>,<k>=<v>,... sha256=<hex>
```

## 6. Publish

Generate the Remnic.ai feed from stored full runs:

```bash
pnpm --filter @remnic/cli exec remnic bench publish \
  --target remnic-ai \
  --results-dir <results-dir> \
  --output <benchmarks.json>
```

Artifacts live under `docs/benchmarks/results/` when publishing from
the monorepo. That directory is gitignored by default — add only the
specific artifact you want to publish with `git add -f` so nothing
experimental leaks in. The Remnic.ai site consumes the generated JSON
feed for its `/benchmarks` page.

If a future release promotes results to tracked-by-default, remove
the `docs/benchmarks/results/` entry from `.gitignore` in the same
commit that updates this section.

## 7. Local-LLM Parity Run

```bash
pnpm --filter @remnic/cli exec remnic bench run longmemeval \
  --dataset-dir ./bench-datasets/longmemeval \
  --system-provider local-llm \
  --system-base-url http://127.0.0.1:8080 \
  --system-model llama-3.1-8b-instruct-q4_k_m \
  --judge-provider local-llm \
  --judge-base-url http://127.0.0.1:8080 \
  --judge-model llama-3.1-8b-instruct-q4_k_m
```

The same runner + artifact schema as the cloud run. Only the responder
/ judge provider differ.

## 8. Troubleshooting

- **`LongMemEval dataset not found under ./bench-datasets/longmemeval`**
  Rerun `scripts/bench/fetch-datasets.sh --target ./bench-datasets` and
  copy-paste the printed `huggingface-cli` commands.
- **`parseBenchmarkArtifact: schemaVersion <N> is not supported`**
  The artifact was written by a newer version of `@remnic/bench`.
  Either update the local checkout or inspect the newer schema.
- **LLM judge returns 0 on everything**
  Pass `--judge-provider <openai|anthropic|ollama|litellm>` and
  `--judge-model <id>` on the `remnic bench run` command. The CLI
  surface in `packages/remnic-cli/src/bench-args.ts` is the only
  sanctioned configuration path for the judge today; environment
  variables are not consumed. Without these flags the runner falls
  back to whatever the adapter's evaluator LLM is, which can legally
  score 0 if it lacks access to the `(question, predicted, expected)`
  tuple format the scorer expects.

## 9. Mocked example

`docs/benchmarks/results/2026-04-20-longmemeval-gpt-4o-mini-mock000.json`
and `.../2026-04-20-locomo-gpt-4o-mini-mock000.json` are **example**
artifacts with placeholder scores, committed so the leaderboard page
has something to render on a fresh clone. They are clearly marked
`datasetVersion: "mock-fixture"` and the filename sha segment is
`mock000`. Replace them with real artifacts produced via steps 3-5 once
the full run is executed. **Do not cite the mock numbers publicly.**
