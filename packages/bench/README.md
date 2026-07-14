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

## OpenAI Build Week: five-minute MemCorrect path

MemCorrect scores correction uptake and stale-memory harm through the same
`remnic bench` surface. This keyless smoke path uses the packaged stdio MCP
server, so it tests the actual MCP adapter rather than the in-memory baseline:

```bash
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo
remnic bench runs list
remnic bench export <run-id> --format html --output ./memcorrect-report.html
```

The run itself is deterministic and offline. It needs no dataset or API key.
The generated HTML is self-contained and includes the correction ledger,
per-dimension evidence, task drill-down, and reproducibility provenance. Treat
the packaged demo as a transport and product smoke test, not a publishable
backend-quality result.

From a source checkout, build the optional companion before invoking the CLI:

```bash
pnpm install --frozen-lockfile
pnpm --filter @remnic/bench build
pnpm exec tsx packages/remnic-cli/src/index.ts bench run \
  --quick memcorrect-v1 --adapter mcp --mcp-demo
```

An external MCP server can replace `--mcp-demo` with exactly one of:

```bash
# stdio
remnic bench run --quick memcorrect-v1 --adapter mcp \
  --mcp-command memory-server --mcp-args '["--stdio"]' \
  --mcp-tool-map '{"store":"memory_store","recall":"memory_recall","correct":"memory_correct","reset":"memory_reset"}'

# Streamable HTTP; set REMNIC_BENCH_MCP_BEARER_TOKEN if authentication is required
remnic bench run --quick memcorrect-v1 --adapter mcp \
  --mcp-url https://memory.example/mcp \
  --mcp-tool-map '{"store":"memory_store","recall":"memory_recall","correct":"memory_correct","reset":"memory_reset"}'
```

Tool names alone may not be enough for a non-canonical server. The mapping can
also describe argument semantics; see `remnic bench --help` for the current CLI
surface and use preflight failures as conformance errors rather than empty
recall scores.

GPT-5.6 judging is explicit and uses the OpenAI Responses API:

```bash
export OPENAI_API_KEY=...
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo \
  --judge-provider openai --judge-model gpt-5.6
```

Codex built and adversarially reviewed the Build Week adapter, Responses
provider, and report card. The underlying Remnic engine and original benchmark
harness are prior work. The evidence ledger, credential-dependent frontier-run
placeholder, and release status live in the root [`HACKATHON.md`](../../HACKATHON.md).

The claimed judge path requires Node.js 22.12+. It is verified from source and
from packed tarballs installed into a clean global prefix on Linux; macOS is
supported with the same Node CLI but still needs a release-install receipt.
Windows judges should use WSL2; native Windows is not currently claimed as
Build Week-verified.

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

## Coding-graph benchmark harness (issue #1557)

A dedicated benchmark suite for [`@remnic/coding-graph`](https://www.npmjs.com/package/@remnic/coding-graph) — the symbol-extraction engine + SQLite knowledge-graph store for codebase memory. The harness is the authority for every performance claim: no number ships in docs without a harness measurement behind it (rule 55, #1527 stub-honesty).

### What it measures

| Metric | Description |
|---|---|
| `fullIndexMs` | Wall time to index the entire fixture in one batch. |
| `fullIndexLocsPerSecond` | Sustained LOC/s during full index (higher is better). |
| `incrementalUpdateP50Ms` / `incrementalUpdateP95Ms` | Single-file re-ingest latency for UNCHANGED content (the common-case no-op path; p50/p95 over ≥20 iterations). |
| `incrementalModifiedUpdateP50Ms` / `incrementalModifiedUpdateP95Ms` | Single-file re-ingest latency for MODIFIED content — the change-heavy path (edge deletion/creation, symbol re-resolution). Complementary to `incrementalUpdate` (#1688). |
| `tracePathP95Ms` | `trace_path` (BFS, depth ≤ 5) p95. |
| `searchGraphP95Ms` | `search_graph` name-pattern p95. |
| `deadCodeMs` | Dead-code query wall time. |
| `dbBytesPerKloc` | SQLite DB bytes per KLOC after index. |

### Synthetic fixture generator

The harness ships a **deterministic** synthetic repo generator (`generateSyntheticRepo`): parameterized by files × symbols-per-file × call-density × language. Same seed + same params always produces byte-identical IR output (rule 38). Fixtures are synthetic code only — no real repos, no user data (public-repo policy).

### Baseline + regression gate

The measured numbers live in [`baselines/coding-graph-baseline.json`](./baselines/coding-graph-baseline.json) — bench-owned, separate from the structural ratchets in `scripts/ratchet-baseline.json`. The regression gate (`checkCodingGraphRegression`) compares a report against the baseline with a generous tolerance (default 30%). It hard-fails on gross regression — a real failing step, not a warning (rule 50). Tightening the baseline is a deliberate PR act (mirrors `check-ratchets --update`).

The gate carries a **machine-fingerprint guard** (`compareMachineFingerprints`): when the report's machine class differs from the baseline's (arch/platform/Node major/cpuModel/cores), the comparison is *skipped* (`passed: true`, `skipped: true`, `machineMismatch` populated) rather than failed, so a cross-machine CI run does not false-positive on legitimate hardware variance (#1688). Regenerate the baseline on the target machine class for a real comparison.

### Measured numbers (first baseline)

> Numbers below are from the **baseline JSON file** — this section is checked against it so prose can't drift from measurement. Run `remnic bench coding-graph` to reproduce.

| Metric | Value | Machine |
|---|---|---|
| Full index | ~15 ms, ~131k LOC/s | Apple M2 Max, Node v22 |
| Incremental update p95 (idempotent) | ~0.24 ms | Apple M2 Max |
| Incremental modified update p95 (change-heavy) | ~0.96 ms | Apple M2 Max |
| trace_path p95 | ~0.13 ms | Apple M2 Max |
| search_graph p95 | ~0.18 ms | Apple M2 Max |
| dead_code | ~0.53 ms | Apple M2 Max |
| DB size | ~270 KB/KLOC | Apple M2 Max |

These are **working targets on a small fixture (20 files, 200 symbols)**, NOT parity claims against codebase-memory-mcp's published numbers (28M LOC in 3 min, <1ms Cypher). Scale targets at 1M+ LOC are tracked as stretch goals — the harness will measure them when Tier-L fixtures are wired (issue #1557 PR2).

### Usage

```typescript
import { runCodingGraphBenchmark, checkCodingGraphRegression } from "@remnic/bench";

// Use the SAME fixture as the bundled baseline (20×10, density 0.3, seed
// 42) so the regression gate compares like-for-like. A custom fixture
// (different fileCount/symbolsPerFile/callDensity/seed/language) needs its
// OWN baseline — build one with buildBaselineFromReport(report, note) and
// commit it, otherwise checkCodingGraphRegression reports a fixture mismatch.
const report = await runCodingGraphBenchmark({
  fixture: { seed: 42, fileCount: 20, symbolsPerFile: 10, callDensity: 0.3, language: "typescript" },
  iterations: 20,
});

const baseline = require("@remnic/bench/baselines/coding-graph-baseline.json");
const gate = checkCodingGraphRegression(report, baseline, 30);
if (!gate.passed) {
  console.error(gate.summary);
  process.exit(1);
}
// gate.skipped === true when the report's machine fingerprint differs from
// the baseline's (different CPU/arch/Node major) — the comparison is skipped
// rather than failed so cross-machine CI does not false-positive (#1688).
```
