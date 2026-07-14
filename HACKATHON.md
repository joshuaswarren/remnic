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

Every item below is built in Codex sessions with GPT-5.6 during the window.
Status boxes get checked as the work lands. Each item links to its commits
and Codex session evidence at submission time.

- [ ] Generic MCP memory adapter (`packages/bench/src/adapters/`). A
  benchmark adapter that speaks the Model Context Protocol, so the harness
  can score any MCP memory server: Mem0, Zep, LangMem, or a bare RAG
  store. This is the core new functionality of the submission.
- [ ] GPT-5.6 judge provider (`packages/bench/src/providers/`). Wires
  GPT-5.6 through the OpenAI Responses API as the grading model. It scores
  benchmark answers, correction acceptance, and stale-memory harm.
- [ ] GPT-5.6 frontier-tier run. A full Tier-F benchmark run with GPT-5.6
  as the system under test. Committed as a reproducible artifact under
  `docs/benchmarks/results/` with its manifest.
- [ ] Memory report card. Extends `remnic bench export --format html` into
  a single shareable scored report with per-dimension scores, correction
  behavior, and provenance. Published through the existing feed to
  remnic.ai.
- [ ] Judge sandbox instructions. A documented five-minute test path (see
  below), so judges can run the tool without rebuilding anything.

Commits for these items: added at submission time.
Codex `/feedback` session ID for the core functionality: added at
submission time.

## How Codex and GPT-5.6 were used

Codex built the adapter, provider, report card, and sandbox work above.
Exploration of the existing adapter seam, implementation, tests, and
iteration all ran inside Codex sessions during the window. The README and
the `/feedback` session ID document where Codex sped up the work. They also
record the key design calls: the adapter contract shape, the scoring
rubric, and the report layout.

GPT-5.6 is load-bearing inside the product twice. It is the benchmark judge
that grades memory answers. It is also a benchmarked system in the
frontier-tier run. Both uses produce committed, hash-locked artifacts.

## How to test it in five minutes

No datasets, no API keys, no network:

```bash
npm install -g @remnic/cli @remnic/bench
remnic bench run --quick longmemeval   # ~60s against the bundled fixture
remnic bench runs list
remnic bench export <run-id> --format html
```

The quick run always uses the bundled fixture; that is the zero-setup
path. To score the real datasets with the GPT-5.6 judge, download them
first, then drop the `--quick` flag:

```bash
export OPENAI_API_KEY=sk-...
remnic bench datasets download longmemeval
remnic bench run longmemeval \
  --judge-provider openai --judge-model gpt-5.6 \
  --judge-api-key "$OPENAI_API_KEY"
```

Without the judge flags, the run falls back to the unjudged scoring
path, and the key must go through `--judge-api-key` (the provider does
not read the env var on its own). Full reproduction paths live in
`docs/paper/repro-appendix.md`.

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
- [ ] README documents where Codex sped up the work and how GPT-5.6 is used.
- [ ] Devpost submission filed before July 21, 5:00 PM PT.
