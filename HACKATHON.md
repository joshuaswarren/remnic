# OpenAI Build Week 2026 submission scope

Project: MemCorrect / Remnic Bench. A tool that benchmarks any AI agent's memory system.
Track: Developer Tools.
Event: OpenAI Build Week Challenge at openai.devpost.com. The window runs July 13 (9:00 AM PT) through July 21, 2026 (5:00 PM PT).
Entrant: Joshua Warren ([@joshuaswarren](https://github.com/joshuaswarren)).

Remnic is a pre-existing project. The Build Week rules say pre-existing
projects "will be evaluated only on work added during the Submission Period."
They also require clear documentation that separates prior work from new
work, with evidence that Codex and GPT-5.6 were used within the period. This
document is that documentation. Judges: everything you are asked to evaluate
is listed under "Work built during the submission period" below. Nothing
else counts.

## Judge summary

MemCorrect tests agent memory. One local command starts a small MCP server,
runs a correction case, and writes a report. The run needs no key or data set.
It checks two facts on their own: did the next answer use the fix, and did the
old fact come back later? The report keeps both results visible.

The MCP adapter, GPT-5.6 judge path, and report card are new Build Week work.
The Remnic engine and the first bench package are not. The checked list below
links the new code. Open boxes show work or proof that is still due.

## What the submission is

A one-command harness that benchmarks the memory system behind an AI agent.
It asks three questions. Does the agent recall the right things? Does it
accept corrections? Does it stop serving stale facts after a correction?
It runs against Remnic or another conforming memory backend through a generic
MCP adapter. It can use GPT-5.6 as the grading judge. It produces a shareable
scored report card.

The pitch in one line: agent memory without evals is vibes with a database.

## Prior work (not part of this submission)

Everything committed before the Codex sessions listed below is prior work.
That includes work merged in the first hours of the window, which came out
of ongoing research rather than hackathon Codex sessions. We draw the line
conservatively. If it was not built in a Codex session during the window,
we do not claim it.

Prior work includes, at minimum:

- The Remnic memory engine, CLI, server, and host plugins. That covers all
  of `packages/` except the files named in the next section.
- The `@remnic/bench` package as of `v9.6.13`. That covers the benchmark
  runners (`longmemeval`, `locomo`, `memory-arena`, `amemgym`, `ama-bench`,
  smoke fixtures), the results store, reproducibility manifests, baselines,
  regression gates, export, the publish feed, and provider discovery.
- The MemCorrect benchmark design and its Correction Contract routing
  (PR #1862, merged 2026-07-13). Also the Tier-F frontier artifacts
  (PR #1863) and the temporal-reasoning heuristic (PR #1864, merged
  2026-07-14). These merged after the window opened but were not built
  with Codex, so we classify them as prior work.
- The Glass-Box Memory paper draft under `docs/paper/`. Also every
  committed benchmark artifact under `docs/benchmarks/results/` dated on
  or before 2026-07-14.

The dated commit history on `main` is the audit trail for this line.

## Work built during the submission period

Status boxes get checked as the work lands. Each item links to its commits
and Codex session evidence at submission time.

- [x] Generic MCP memory adapter (`packages/bench/src/adapters/`). A
  benchmark adapter that speaks the Model Context Protocol, so the harness
  can score a conforming MCP memory server through explicit tool and argument
  mapping. This is the core new functionality of the submission.
- [x] GPT-5.6 judge provider (`packages/bench/src/providers/`). Wires
  GPT-5.6 through the OpenAI Responses API as the grading model. It scores
  benchmark answers, correction acceptance, and stale-memory harm.
- [ ] GPT-5.6 frontier-tier run. A bounded, credit-backed Tier-F run uses
  `gpt-5.6-luna` for bulk responder and internal work and `gpt-5.6-terra` for
  quality-critical judging. `gpt-5.6-sol` is outside the bounded plan and is
  disabled unless the operator explicitly opts in. A result is claimed only
  after its artifact and manifest are committed under
  `docs/benchmarks/results/`; bounded coverage is labeled as a trial, never a
  full leaderboard number.
- [x] Memory report card. Extends `remnic bench export --format html` into
  a single shareable scored report with per-dimension scores, correction
  behavior, and provenance. Included in the existing publish feed for
  remnic.ai.
- [x] Judge sandbox instructions. A documented five-minute test path (see
  below), so judges can run the tool without rebuilding anything.

Delivered implementation commit:
[`2c2f63be`](https://github.com/joshuaswarren/remnic/commit/2c2f63be98ad3d8b40bca96567de067e11d4e56d)
(MCP adapter, Responses judge provider, and report card).

Additional in-window receipts:

- [`e758e275`](https://github.com/joshuaswarren/remnic/commit/e758e27552c531e428ad5997cafb3c8870200005)
  pins the judge data. It also adds a repeatable bootstrap confidence range.
- [`e698b144`](https://github.com/joshuaswarren/remnic/commit/e698b14409f8022f42b08097fe6834cace47a99b)
  adds the judge instructions, honest Devpost draft, and demo script.
- [`b12307c5`](https://github.com/joshuaswarren/remnic/commit/b12307c51a8a9b1bff4f314a2f1ae93daa09e991)
  adds the cold packed-tarball test. It passed on Linux x64 with Node 22.23.1
  on 2026-07-14. The run ended in `PACKAGED_SANDBOX_OK`. It used
  `adapterMode=mcp`, saved one task with `uptake_at_next=1`, and made a
  15,144-byte report. Run it with
  `node scripts/verify-build-week-sandbox.mjs`.
- [`366b6143`](https://github.com/joshuaswarren/remnic/commit/366b61436e5b5e960f59c0480a387ebce70a9629)
  makes provider failures fail closed. A rejected GPT-5.6 smoke can no longer
  produce a complete-looking artifact or exit successfully; 47 focused tests
  cover partial status, legitimate negative scores, empty results, and
  promotion refusal.
- [`7ea9657a`](https://github.com/joshuaswarren/remnic/commit/7ea9657a61599cde1ee3b18e145324652049e5de),
  [`3b301c41`](https://github.com/joshuaswarren/remnic/commit/3b301c417ffe42d878f76e14a46315ee1aafdfad), and
  [`3d42b455`](https://github.com/joshuaswarren/remnic/commit/3d42b455ec0b7e2762c44aa760991e976e3f7342)
  are in-window research hardening beyond the submission core: bounded
  cross-session temporal recall, an evidence-bounded LoCoMo category
  diagnosis, and a default-off empty-recall abstention foundation. They are
  not presented as benchmark lifts because the required acceptance artifacts
  are still operator-gated.
- [`e3ffce20`](https://github.com/joshuaswarren/remnic/commit/e3ffce20096e51916c33e82562d9f5c194fc495f)
  adds the narrowly tested manifest-only Dependabot review-gate exception.
- [`53db4aeb`](https://github.com/joshuaswarren/remnic/commit/53db4aebd885947b953e0d35ee73e26f6405b010),
  [`6483f2da`](https://github.com/joshuaswarren/remnic/commit/6483f2da407af6531c2b3a90fc86a1e7d4689e93), and
  [`1db7d86f`](https://github.com/joshuaswarren/remnic/commit/1db7d86f27f230e282b32d7c4d7e83c96117d8bd)
  add the one-shot Codex CLI path, enforce its credit cap, and add safety checks
  for bounded frontier runs.
- [`164f925d`](https://github.com/joshuaswarren/remnic/commit/164f925d559f360fe9c9cb85f3f102fa7959b7a9),
  [`bcc11197`](https://github.com/joshuaswarren/remnic/commit/bcc1119734d7c281975478268c1fc51292ea404f),
  [`50fa56b0`](https://github.com/joshuaswarren/remnic/commit/50fa56b01711c6df8b7e138f17e97e94c31a2ab0), and
  [`ab849733`](https://github.com/joshuaswarren/remnic/commit/ab84973365935418f938fd0ed9510d3b4a95e1c7)
  add the LoCoMo diagnosis tool, pin staged dataset paths, add safe credit
  recovery, and let judge calibration resume after a stop.
- [`30de78ea`](https://github.com/joshuaswarren/remnic/commit/30de78ea924af066c72f64768a017fc88518af78)
  and
  [`7d885e2e`](https://github.com/joshuaswarren/remnic/commit/7d885e2e1fcecdceee056aa4a3ac3419cb5a650a)
  add provider-free LoCoMo recall receipts and a strict paired structural
  analyzer. The July 16 current-main capture covered all 321 historical
  multi-hop tasks and found no baseline/real retrieval-structure delta. This
  is negative diagnostic evidence, not a scored benchmark lift.

On July 15, merged head `ab849733` passed the cold package test:
`node scripts/verify-build-week-sandbox.mjs --keep`. The test put version 9.6.24
in a clean global prefix. The host was Linux x86_64 with Node 22.23.1. The test
ended in `PACKAGED_SANDBOX_OK`. This was a keyless, one-task MCP run. No judge
or provider ran. It scored `uptake_at_next=1` and `non_resurrection=0`. It also
wrote a 15,144-byte offline HTML report. The focused results-store test passed
20 of 20 tests. This receipt proves the packaged keyless path and report
export. It is not a paid-model result.

On July 16, merged head `7d885e2e` repeated the cold package test from the
source checkout at version 9.6.33. A clean global prefix installed the packed
core, server, Pi plugin, coding graph, bench, and CLI packages. The keyless
one-task LongMemEval smoke and MCP MemCorrect run both completed; run listing
and HTML export succeeded; the report was 15,144 bytes; and the test ended in
`PACKAGED_SANDBOX_OK`. This verifies the current source package set on Linux
x64. It does not claim that version 9.6.33 is published or that a model ran.

On July 16, merged head `2b98fbff` also passed the cold package test at
version 9.6.34. Separately, an exact registry install of
`@remnic/cli@9.6.34` and `@remnic/bench@9.6.34` into a clean Linux x86_64
prefix completed the keyless MCP MemCorrect smoke, run listing, and HTML
export. The registry-installed report was 15,128 bytes. No judge or provider
ran. This is the current judge install path below.

Codex `/feedback` session ID for the core functionality:
**PENDING OPERATOR INPUT.** Run `/feedback` in the primary Codex session and
paste the real session ID here before submission.

GPT-5.6 frontier artifact and manifest:
**PENDING OPERATOR RUN.** Link only a committed artifact produced by the
credit-backed Codex CLI protocol below. Do not convert a bounded trial into a
full-run claim.

## How Codex and GPT-5.6 were used

Codex built the new adapter, provider, report card, and sandbox. Codex also
reviewed that work. It explored the old adapter seam, wrote the code and tests,
and handled each revision during the event. The README records
where Codex sped up the work. The `/feedback` session ID remains operator input
and will be added before submission. Those receipts show three key choices: the
adapter shape, the scoring rubric, and the report layout.

GPT-5.6 is part of the product. It can act as an opt-in judge with strict
structured output. There are two provider paths. The optional Responses API
judge uses the exact model id `gpt-5.6`. The ChatGPT-backed Codex CLI has other
names. Luna does the bulk work. Terra does the key judge work. These names and
paths are not the same. We will not claim a CLI result until a real, locked
artifact exists.

## Credit-backed Codex CLI run protocol

The Build Week grant is **2,473 Codex credits**. During a benchmark window,
this account must be used exclusively by this one harness process; the Codex
CLI has no machine-readable account-balance command, so unrelated Codex use
cannot be reconciled into the local ledger. Before starting, `codex login
status` must report ChatGPT authentication. We hold back **473 credits**.
That leaves **2,000 usable credits**. The holdback is not a spend target. It
covers the last call, since its true cost is known only after it ends. Codex
adds each finished turn to one JSON ledger. The usage comes from the
`turn.completed` JSONL event. We read that ledger before we choose the next
small batch.

| Ledger item | Credits |
| --- | ---: |
| Starting balance | 2,473 |
| Safety reserve | -473 |
| Maximum planned spend | 2,000 |
| Unallocated balance after the plan | 473 |

Credit accounting uses the published per-million-token rates:

| CLI model | Role | Input | Cached input | Output |
| --- | --- | ---: | ---: | ---: |
| `gpt-5.6-luna` | Bulk responder and internal work | 25 | 2.5 | 150 |
| `gpt-5.6-terra` | Quality-critical judge | 62.5 | 6.25 | 375 |

For each finished turn, credits equal
`((input_tokens - cached_input_tokens) * input_rate + cached_input_tokens * cached_rate + output_tokens * output_rate) / 1,000,000`.
The ledger records harness-observed use. If a process exits without exact usage,
the ledger blocks further calls until the account is manually reconciled. It
does not guess a fixed trial count. After each
small batch, set the next `--limit` or `--trial-limit` from the balance and the
measured cost per task. Stop at the 2,000-credit spend line. Stop sooner if the
balance cannot cover one more task. We do not use fast service. Sol needs its
own opt-in and is not part of this plan.

First, inspect the signed-in CLI catalog with `codex debug models`. Each call
starts a new, non-interactive `codex exec` in an empty work folder. It ignores
user config and project rules, disables hooks, and keeps no chat. The sandbox
is read-only, and approval is set to `never`. The benchmark prompt also tells
the model not to use tools. The artifact records this one-shot setup.

The harness can cap task counts with `--limit`. LoCoMo and MemoryAgentBench can
also use `--trial-limit`. These flags do not cap credits. The provider has
separate credit guards. Set them, then choose the task cap from the ledger:

```bash
export BUILD_WEEK_RUN_ROOT="$HOME/.remnic/bench/build-week-2026"
export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"
umask 077
mkdir -p "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"
chmod 700 "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"

export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473
export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473
export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"

# Replace <LEDGER_DERIVED_LIMIT> after a smoke turn establishes actual cost.
remnic bench run longmemeval --runtime-profile real \
  --limit <LEDGER_DERIVED_LIMIT> \
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

The placeholder is on purpose. There is no honest fixed task count until we
measure this prompt and test mix. Keep the ledger private because it can hold
local run data. The external results directory can also contain questions,
answers, and recalled context, so keep it private too. After each run, preserve
the exact ID printed by the CLI; recover it without scanning another results
store with
`remnic bench runs list --results-dir "$BUILD_WEEK_RESULTS_DIR"`. Confirm the
ledger is mode `0600` with
`chmod 600 "$REMNIC_BENCH_CODEX_CREDIT_LEDGER"` after it is first created.
Publish only the safe cost and token totals from the result and manifest.
Codex CLI gets a benchmark-owned 180-second transport timeout automatically;
do not add `--request-timeout` here because that explicit flag also enables a
whole-phase benchmark guard. The separate drain timeout stays explicit so
queued internal work can finish after the last scored task.

## How to test it in five minutes

After the npm packages are installed, no datasets, API keys, or network:

```bash
npm install -g @remnic/cli@9.6.34 @remnic/bench@9.6.34
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo
remnic bench runs list
remnic bench export <run-id> --format html --output ./memcorrect-report.html
```

After package installation, the run itself uses the bundled MCP demo and needs
no dataset, API key, or network. It exercises the real MCP transport and
correction contract. It is a product smoke test, not a publishable backend or
model result.

To test a development checkout instead of the published packages:

```bash
pnpm install --frozen-lockfile
pnpm --filter @remnic/bench build
pnpm exec tsx packages/remnic-cli/src/index.ts bench run \
  --quick memcorrect-v1 --adapter mcp --mcp-demo
```

To invoke GPT-5.6 as the structured-output judge:

```bash
export OPENAI_API_KEY=...
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo \
  --judge-provider openai --judge-model gpt-5.6
```

Without the judge flags, MemCorrect reports its deterministic contract metrics
without making an OpenAI call. The OpenAI provider is selected only when the
flags are present and reads `OPENAI_API_KEY`; the manifest records the provider,
model, and rubric version but redacts the secret. Full reproduction paths live
in `docs/paper/repro-appendix.md`.

## Supported judge environment

| Environment | Build Week support statement |
|---|---|
| Node.js | 22.12 or newer |
| Linux | Source-checkout, packed-tarball, and version 9.6.34 registry-install paths verified on Linux x64 |
| macOS | Supported by the Node CLI; final global-install receipt pending |
| Windows | Use WSL2 for the claimed path; native Windows is not claimed as verified |
| MCP transport | stdio and Streamable HTTP |

The version 9.6.24 packed-tarball cold-install receipt is complete on Linux.
Both `@remnic/cli` and `@remnic/bench` are published at 9.6.24. This receipt
does not claim a macOS or native Windows verification. The version 9.6.33
source package set also passed the same Linux x64 cold global-prefix test on
July 16; that newer receipt is a source-package check, not a publication
claim. Version 9.6.34 of both judge-facing packages is now published, and the
exact registry install plus keyless flow is verified on Linux x86_64.

## Honest framing of the novelty claim

MemCorrect's contribution is a composition and protocol claim. It is a
one-command harness that scores Remnic or another backend implementing its
supported adapter contract on correction acceptance and stale-memory harm,
with provenance-locked artifacts. It is not a claim to be first to measure
memory correction. StateBench, STALE, MemSyco-Bench,
MemStrata, and MemoryAgentBench are prior art. We engage them in
`docs/paper/related-work.md`.

## Compliance checklist

- [x] Free Codex credits requested by July 17, 12:00 PM PT (requested 2026-07-14).
- [ ] Core functionality built in Codex sessions, with the `/feedback` session ID captured.
- [ ] Demo video under 3 minutes, public on YouTube. Audio covers Codex and GPT-5.6 usage.
- [x] Repository public with MIT license.
- [x] README documents where Codex sped up the work and how GPT-5.6 is used.
- [ ] Devpost submission filed before July 21, 5:00 PM PT.
