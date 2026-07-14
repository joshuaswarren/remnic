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
It runs against any memory backend through a generic MCP adapter, not just
Remnic. It uses GPT-5.6 as the grading judge. It produces a shareable
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
- [ ] GPT-5.6 frontier-tier run. A full Tier-F benchmark run with GPT-5.6
  as the system under test. Committed as a reproducible artifact under
  `docs/benchmarks/results/` with its manifest. **Blocked on operator input:**
  Codex CLI 0.144.4 authenticated through ChatGPT rejects `gpt-5.6` as an
  unsupported account model, and this environment has no `OPENAI_API_KEY` or
  `REMNIC_BENCH_OPENAI_API_KEY`. Run it through the raw Responses API once a
  key is available; do not substitute or relabel a different model.
- [x] Memory report card. Extends `remnic bench export --format html` into
  a single shareable scored report with per-dimension scores, correction
  behavior, and provenance. Included in the existing publish feed for
  remnic.ai.
- [ ] Judge sandbox instructions. A documented five-minute test path (see
  below), so judges can run the tool without rebuilding anything.

Delivered implementation commit:
[`fb295ff8`](https://github.com/joshuaswarren/remnic/commit/fb295ff8fb9cb66c7f4bcde793d4ce63aa095ae1)
(MCP adapter, Responses judge provider, and report card).

Codex `/feedback` session ID for the core functionality:
**PENDING OPERATOR INPUT.** Run `/feedback` in the primary Codex session and
paste the real session ID here before submission.

GPT-5.6 frontier artifact and manifest:
**PENDING OPERATOR INPUT.** This requires an OpenAI API key. Link only the committed
artifact produced by the raw Responses API run.

## How Codex and GPT-5.6 were used

Codex built the adapter, provider, report card, and sandbox work above.
Exploration of the existing adapter seam, implementation, tests, and
iteration all ran inside Codex sessions during the window. The README and
the `/feedback` session ID document where Codex sped up the work. They also
record the key design calls: the adapter contract shape, the scoring
rubric, and the report layout.

GPT-5.6 is load-bearing in the implemented product as the opt-in benchmark
judge that grades memory answers through strict structured outputs. The
planned second use, benchmarking GPT-5.6 as the system under test, remains
credential-blocked and is not claimed as delivered.

## How to test it in five minutes

After the npm packages are installed, no datasets, API keys, or network:

```bash
npm install -g @remnic/cli @remnic/bench
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo
remnic bench runs list
remnic bench export <run-id> --format html --output ./memcorrect-report.html
```

After package installation, the run itself uses the bundled MCP demo and needs
no dataset, API key, or network. It exercises the real MCP transport and
correction contract. It is a product smoke test, not a publishable backend or
model result.

Until the Build Week revision is published to npm, use the source checkout:

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
| Linux | Source-checkout MCP demo verified on Linux x64 |
| macOS | Supported by the Node CLI; final global-install receipt pending |
| Windows | Use WSL2 for the claimed path; native Windows is not claimed as verified |
| MCP transport | stdio and Streamable HTTP |

The published-package cold-install receipt is still pending. Before submission,
replace this sentence with the release version and link the exact receipt, or
leave the source-checkout path as the only verified installation claim.

## Honest framing of the novelty claim

MemCorrect's contribution is a composition and protocol claim. It is a
one-command harness that scores any memory backend on correction acceptance
and stale-memory harm, with provenance-locked artifacts. It is not a claim
to be first to measure memory correction. StateBench, STALE, MemSyco-Bench,
MemStrata, and MemoryAgentBench are prior art. We engage them in
`docs/paper/related-work.md`.

## Compliance checklist

- [x] Free Codex credits requested by July 17, 12:00 PM PT (requested 2026-07-14).
- [ ] Core functionality built in Codex sessions, with the `/feedback` session ID captured.
- [ ] Demo video under 3 minutes, public on YouTube. Audio covers Codex and GPT-5.6 usage.
- [ ] Repository public with MIT license (already true).
- [x] README documents where Codex sped up the work and how GPT-5.6 is used.
- [ ] Devpost submission filed before July 21, 5:00 PM PT.
