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

The credit-backed Codex CLI path is a distinct provider and model namespace.
Use `gpt-5.6-luna` for bulk responder and internal work and
`gpt-5.6-terra` for quality-critical judging. The exact API id `gpt-5.6`
above is not a CLI alias. Confirm the authenticated catalog before a run with
`codex debug models`. `gpt-5.6-sol` is opt-in only and is disabled in the
bounded plan.

Each Codex completion is a fresh, non-interactive `codex exec` in a new empty
temporary workspace. It ignores user configuration and project rules,
disables hooks, and keeps no session. The sandbox is read-only, approvals are
denied, and the benchmark prompt instructs the model not to use tools. The
Build Week plan uses normal service, not fast mode.

The Build Week grant has 2,473 Codex credits. Use the account exclusively for
this one harness process during a bounded run because Codex CLI exposes no
machine-readable account balance. Bounded mode also requires `codex login
status` to report ChatGPT authentication. A 473-credit safety reserve leaves
2,000 usable credits. Configure the atomic completed-turn ledger and guards,
then measure a quick task before choosing a workload bound:

```bash
export BUILD_WEEK_RUN_ROOT="$HOME/.remnic/bench/build-week-2026"
export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"
umask 077
mkdir -p "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"
chmod 700 "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"

export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473
export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473
export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"

remnic bench run longmemeval \
  --runtime-profile real \
  --limit 1 \
  --dataset-dir ./bench-datasets/longmemeval \
  --results-dir "$BUILD_WEEK_RESULTS_DIR" \
  --drain-timeout 600000 \
  --system-provider codex-cli --system-model gpt-5.6-luna \
  --system-codex-reasoning-effort medium \
  --internal-provider codex-cli --internal-model gpt-5.6-luna \
  --internal-codex-reasoning-effort medium \
  --judge-provider codex-cli --judge-model gpt-5.6-terra \
  --judge-codex-reasoning-effort high

remnic bench run longmemeval \
  --runtime-profile real --limit <LEDGER_DERIVED_LIMIT> \
  --dataset-dir ./bench-datasets/longmemeval \
  --results-dir "$BUILD_WEEK_RESULTS_DIR" \
  --drain-timeout 600000 \
  --system-provider codex-cli --system-model gpt-5.6-luna \
  --system-codex-reasoning-effort medium \
  --internal-provider codex-cli --internal-model gpt-5.6-luna \
  --internal-codex-reasoning-effort medium \
  --judge-provider codex-cli --judge-model gpt-5.6-terra \
  --judge-codex-reasoning-effort high
```

The placeholder is intentional. `--limit` and LoCoMo/MemoryAgentBench's
`--trial-limit` bound tasks, not token credits. Derive each next batch from
actual `turn.completed` JSONL usage. Stop dispatching at 2,000 spent; the
473-credit reserve absorbs only a final in-flight call whose exact cost becomes
known after completion. Missing exact terminal usage blocks the ledger pending
manual account reconciliation.
The measured probe is a full-mode run bounded to one staged LongMemEval item.
Full mode fails before provider dispatch if that explicit dataset directory is
missing or unreadable, so it cannot fall back to the bundled quick fixture.
Both commands pin the same gitignored dataset source and do not fall back to
the CLI-managed dataset store.
Rates per one million tokens are Luna: 25 input, 2.5 cached input, 150 output;
Terra: 62.5 input, 6.25 cached input, 375 output. A bounded result is a trial,
not a full leaderboard artifact.

Codex CLI receives a benchmark-owned 180-second transport timeout when no
request timeout is supplied. Keep `--request-timeout` out of these commands:
an explicit value also becomes a whole-phase guard, while the transport-only
default lets long store/recall/reset phases complete. The 600-second drain cap
remains explicit for queued internal work.

The ledger and results stay outside the repository because stored runs may
contain questions, answers, and recalled context. The `umask` plus explicit
directory modes make newly created state private. After the first ledger write,
run `chmod 600 "$REMNIC_BENCH_CODEX_CREDIT_LEDGER"`. Preserve the exact run ID
printed by the CLI, or recover it only from this run store with
`remnic bench runs list --results-dir "$BUILD_WEEK_RESULTS_DIR"`; use that ID
for export and artifact promotion rather than an ambiguous “latest” run.

Commit only a sanitized evidence receipt, never the private result or manifest:

```bash
pnpm exec tsx scripts/bench/generate-build-week-evidence-receipt.ts \
  --result "$BUILD_WEEK_RESULTS_DIR/<result>.json" \
  --manifest "$BUILD_WEEK_RESULTS_DIR/MANIFEST.json" \
  --output docs/benchmarks/evidence/<public-receipt>.json \
  --dataset-version longmemeval-oracle-v1 \
  --bounded-task-count 300 \
  --confirm-fresh-isolated-store \
  --limitations boundedSubset,singleRun,estimatedAccounting,modelJudged
```

Use `--full-task-count <DATASET_TASK_COUNT>` instead of
`--bounded-task-count` only for a genuinely complete, unlimited run. The
fresh-store confirmation is mandatory: never generate a competition receipt
from a production Remnic store. The generator binds the exact private source
bytes, runner dataset payload, and manifest file inventory with SHA-256 hashes,
then emits aggregate metrics, model provenance, and explicitly estimated usage
only. It refuses partial, failed, task-count-mismatched, hash-mismatched, Sol,
or falsely full evidence. Its fixed output schema cannot copy questions,
answers, recall text, private paths, environment values, ledger details, or
account balances into the repository.

MemCorrect v1 is generated rather than file-backed. Its receipt path is
deliberately narrower: only the pinned full 40-scenario corpus (seed
`0xc077e7`, dataset version `memcorrect-v1-c077e7`) is accepted. The receipt
binds the known corpus payload hash, generator parameters, benchmark version,
seed, Remnic-native adapter, and exact two-judge-calls-per-scenario telemetry;
its manifest must retain the normal empty `not-provided` dataset entry. It does
not weaken the hashed-file requirement for LongMemEval, LoCoMo, or any other
file-backed benchmark:

```bash
pnpm exec tsx scripts/bench/generate-build-week-evidence-receipt.ts \
  --result "$BUILD_WEEK_RESULTS_DIR/<memcorrect-result>.json" \
  --manifest "$BUILD_WEEK_RESULTS_DIR/MANIFEST.json" \
  --output docs/benchmarks/evidence/<public-memcorrect-receipt>.json \
  --dataset-version memcorrect-v1-c077e7 \
  --full-task-count 40 \
  --confirm-fresh-isolated-store \
  --limitations singleRun,estimatedAccounting,modelJudged
```

### Completed Build Week evidence

The July 17 run at Remnic 9.7.6, source head `810f36ae`, completed the full
uncapped 500-task LongMemEval-oracle matrix with zero failures. The public
[frontier artifact](../../docs/benchmarks/results/2026-07-17-longmemeval-gpt-5.6-luna-810f36a.json)
and [sanitized receipt](../../docs/benchmarks/evidence/2026-07-17-longmemeval-gpt-5.6-luna-build-week-receipt.json)
report `contains_answer=0.49`, F1 `0.5551`, `judge_accuracy=0.762`, and
`search_hits=8.538`. The receipt binds dataset payload SHA-256
`821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`,
records 2,892 calls and 745.745695 locally estimated budget units, and confirms
a fresh isolated store and zero Sol calls.

The same source head completed the generated 40-scenario
`memcorrect-v1-c077e7` corpus with zero task failures. Its
[sanitized receipt](../../docs/benchmarks/evidence/2026-07-17-memcorrect-v1-gpt-5.6-luna-build-week-receipt.json)
reports deterministic `uptake_at_next=0`, fully censored uptake latency of 8,
`non_resurrection=0`, `false_apply=1`, `scope_precision=0`, and
`reassertion=1`. Terra's model-judged correction acceptance was `0.9875` and
stale-harm avoidance was `1`. Those judgments do not override the
deterministic failures; this is mixed evidence, not a strong or successful
MemCorrect result. The receipt records 550 calls and 98.720145 locally
estimated budget units, fresh isolated stores, and zero Sol calls.

Both receipts label token and budget-unit accounting as local estimates rather
than account billing and cover one model-judged run each, without run-to-run
variance. Raw results, manifests, reports, and ledgers remain private because
they can contain benchmark content or local state.

Codex built and adversarially reviewed the Build Week adapter, Responses
provider, and report card. The underlying Remnic engine and original benchmark
harness are prior work. The evidence ledger, completed frontier evidence, and
release status live in the root [`HACKATHON.md`](../../HACKATHON.md).

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
