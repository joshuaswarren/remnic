# @remnic/bench

Benchmark suite and CI regression gates for [Remnic](https://github.com/joshuaswarren/remnic) memory pipelines. Ships the runners, adapters, and results store that the `remnic bench` CLI surface drives.

`@remnic/bench` is an **optional companion** to [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli). Install it only when you need to run benchmarks, compare runs, or publish results. Memory-only users do not need it.

## Install

```bash
# Alongside the CLI:
npm install -g @remnic/cli @remnic/bench

# Or in a project that drives benchmarks programmatically:
pnpm add @remnic/bench
```

The CLI loads `@remnic/bench` via a computed-specifier dynamic import. If it's not installed, `remnic bench *` prints a clear install hint; the rest of the CLI keeps working.

## What it does

- **Benchmark runners** for a growing set of memory-oriented evals: `longmemeval`, `locomo`, `memory-arena`, `amemgym`, `ama-bench`, plus a lightweight smoke fixture.
- **Stored-run management** — every `remnic bench run *` writes a timestamped JSON result under `~/.remnic/bench/results/`; `remnic bench runs list|show|delete` let you browse, inspect, and prune.
- **Reproducibility manifests** — package-backed runs write `MANIFEST.json` beside the result files, locking result hashes, dataset file hashes, seeds, runtime profiles, command argv with secret values redacted, selected environment keys, git state, QMD collections, and config-file hashes.
- **Baselines + regression gates** — save a run as a named baseline, compare candidates against it, gate CI on threshold violations.
- **Result export** — `remnic bench export <run> --format json|csv|html`.
- **Published feed** — `remnic bench publish --target remnic-ai` builds the tamper-evident integrity manifest consumed by remnic.ai.
- **Provider discovery** — `remnic bench providers discover` enumerates local OpenAI / Anthropic / Ollama / LiteLLM providers for adapter wiring.

## Memory eval dimensions

Agent memory without evals is vibes with a database.

`@remnic/bench` exports `MEMORY_EVAL_DIMENSIONS` as Remnic's shared eval
contract for user-aware agents. It covers:

- repeated-context reduction
- unnecessary-clarification reduction
- retrieval correctness
- stale-memory harm
- scope respect
- ask-when-needed decisions
- act-when-enough-context decisions
- personalization quality

Each dimension maps to existing quick-capable benchmark ids. Use
`listMemoryEvalBenchmarkIds()` when wiring CI coverage, and use the per-dimension
`fullModeGuidance` strings when designing publishable eval claims. See
[`docs/memory-evals.md`](../../docs/memory-evals.md) for the full map.

## CLI quick reference

```bash
# List available benchmarks:
remnic bench list

# Download a dataset for a full run:
remnic bench datasets download longmemeval

# Full run on the downloaded dataset:
remnic bench run longmemeval

# 60-second smoke run on the bundled fixture:
remnic bench run --quick longmemeval

# Browse stored runs:
remnic bench runs list
remnic bench runs show <run-id> --detail

# Inspect the reproducibility lock for the last run set:
jq . ~/.remnic/bench/results/MANIFEST.json

# Compare two runs:
remnic bench compare base-run candidate-run

# Save a baseline (archives the run under ~/.remnic/bench/baselines):
remnic bench baseline save dashboard-v1 candidate-run

# Gate CI against a stored run with a 2% threshold (compare takes run
# ids / paths, not baseline names — use `baseline save` for archival,
# then reference the underlying run id in `compare`):
remnic bench compare candidate-run nightly-run --threshold 0.02

# Ship results to remnic.ai:
remnic bench publish --target remnic-ai
```

Dataset markers match the runner's accepted filenames, so `datasets status` reports "downloaded" exactly when the runner will load successfully.

## Running on real datasets

The `longmemeval` and `locomo` runners ship with a bundled smoke fixture so
`remnic bench run --quick` and CI stay green without downloading anything.
To produce public-quality numbers you need the real datasets. Both live on
HuggingFace.

```bash
# Print the exact download commands (no auto-fetch):
scripts/bench/fetch-datasets.sh --help
scripts/bench/fetch-datasets.sh --target ./bench-datasets
```

Expected layout (the `bench-datasets/` directory is gitignored):

```
bench-datasets/
  longmemeval/
    longmemeval_oracle.json          # preferred filename
    longmemeval_s_cleaned.json       # optional alternate
    longmemeval_s.json               # optional alternate
  locomo/
    locomo10.json                    # preferred filename
    locomo.json                      # optional alternate
```

Point the runners at the directory. Use the current `remnic bench run`
CLI surface with `--dataset-dir` (a dedicated `remnic bench published`
subcommand with user-configurable `--limit`, `--model`, and `--seed` is
planned for a later slice of
[#566](https://github.com/joshuaswarren/remnic/issues/566)):

```bash
pnpm exec remnic bench run longmemeval \
  --dataset-dir ./bench-datasets/longmemeval

pnpm exec remnic bench run locomo \
  --dataset-dir ./bench-datasets/locomo
```

Programmatic loaders are exported from `@remnic/bench`:

```ts
import { loadLongMemEvalS, loadLoCoMo10 } from "@remnic/bench";

const longmemeval = await loadLongMemEvalS({
  mode: "full",
  datasetDir: "./bench-datasets/longmemeval",
  limit: 100,
});
// longmemeval.source === "dataset" when the real file was found,
// "smoke" when quick-mode fallback was used, "missing" when full-mode
// could not find any of the canonical filenames.
```

When `mode: "full"` and no dataset is found, the loaders return
`{ source: "missing", errors }` and the runner throws a
`formatMissingDatasetError()` message pointing operators at
`scripts/bench/fetch-datasets.sh`. Quick mode silently falls back to the
bundled smoke fixture and logs the probe errors so you can tell why.

## CI regression gate (smoke fixtures)

`.github/workflows/bench-smoke.yml` runs `scripts/bench/bench-smoke.ts`
on every PR. The script exercises the LongMemEval + LoCoMo runners
against their bundled smoke fixtures with a fixed seed and a
deterministic in-memory adapter (no real datasets, no LLM calls, no
network). Metrics are compared to the committed baseline at
`tests/fixtures/bench-smoke/baseline.json`; any drop greater than 5%
fails the job.

Regenerate the baseline after an intentional runner change:

```bash
pnpm exec tsx scripts/bench/bench-smoke.ts --update-baseline
```

## Programmatic API

```ts
import {
  listBenchmarks,
  runBenchmark,
  writeBenchmarkResult,
  writeBenchmarkReproManifest,
  createLightweightAdapter,
  createRemnicAdapter,
  compareResults,
  saveBenchmarkBaseline,
  listBenchmarkResults,
  deleteBenchmarkResults,
  buildBenchmarkPublishFeed,
  discoverAllProviders,
  type BenchmarkResult,
  type ComparisonResult,
  type BenchmarkDefinition,
} from "@remnic/bench";
```

Each runner accepts a `system` adapter — `createRemnicAdapter()` talks to a live `@remnic/core` Orchestrator; `createLightweightAdapter()` is a minimal in-memory stand-in used for CI smoke runs. Results conform to the `BenchmarkResult` schema (see `dist/index.d.ts`).

## Agent note

If you're an AI agent extending a Remnic-based stack: **do not** import `@remnic/bench` from a base install surface (CLI, core, plugin). Optional companion packages must be loaded via computed-specifier dynamic imports with an install-hint fallback. See `packages/remnic-cli/src/optional-bench.ts` in the repo for the canonical pattern, and the à-la-carte invariant in the repo's `AGENTS.md` §44 / `CLAUDE.md` gotcha #57.

## Related

- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) — the CLI that drives `remnic bench *`
- [`@remnic/core`](https://www.npmjs.com/package/@remnic/core) — the memory engine bench adapters talk to
- Source + issues: <https://github.com/joshuaswarren/remnic>

## License

MIT. See the root [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE) file.
