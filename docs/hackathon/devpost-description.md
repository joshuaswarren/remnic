# Devpost submission text (OpenAI Build Week 2026)

Paste-ready copy for the Devpost form. Gated with voice-lint (article mode)
before each revision ships.

Project name: MemCorrect: benchmark any AI agent's memory.

Tagline: Agent memory without evals is vibes with a database. MemCorrect
scores any agent memory backend with one command. It checks recall quality,
correction handling, and stale-memory harm. GPT-5.6 does the grading.

Built with: typescript, node.js, gpt-5.6, codex, openai-responses-api, mcp,
sqlite.

## Inspiration

Everyone is shipping agent memory right now. Almost nobody tests it. The
demos all show an agent that remembers your name. None of them show what
happens three weeks later. You tell it "actually, we moved off PostgreSQL"
and it keeps citing the old choice. Stale memory is not a cosmetic bug. An
agent that acts on facts you already fixed is worse than an agent with no
memory at all.

We build Remnic, an open-source memory engine. We got tired of memory
systems (ours included) making accuracy claims with no receipts. So we
built the receipts machine.

## What it does

MemCorrect tests the memory system behind an AI agent with one command:

```bash
remnic bench run --quick longmemeval   # 60-second smoke run, no keys, no network
```

It scores three things most memory benchmarks skip. First, recall: does the
agent surface the right fact at the right time? We measure that on
LongMemEval, LoCoMo, and friends. Second, corrections: when the user fixes
a stored fact, does the memory actually update? Third, stale-memory harm:
after a fix, does the old fact ever come back?

It runs against any memory backend, not just ours. A generic MCP adapter
lets you point it at Mem0, Zep, LangMem, or your homegrown RAG store.
GPT-5.6 grades every answer through the OpenAI Responses API. Every run
writes a locked manifest: dataset hashes, seeds, git state, config. The
output is a memory report card you can share. "Our memory is good" becomes
a scored claim anyone can re-run.

## How we built it

The new work for Build Week was built in Codex sessions with GPT-5.6. The
session ID is in the form. The line between prior work and hackathon work
is drawn commit-by-commit in
[HACKATHON.md](https://github.com/joshuaswarren/remnic/blob/main/HACKATHON.md).

Codex studied our adapter seam first. Then it built the generic MCP memory
adapter, its tests, and the checks that decide if a backend can be scored
at all. It wired GPT-5.6 in as the judge and iterated on the rubric with
us. We also flipped the table: we ran GPT-5.6 as the system under test and
committed that run as an artifact anyone can re-check. Codex then polished
the HTML export into one scored report card you can hand to your team.

GPT-5.6 does double duty here. It is the judge inside the tool, and it is a
scored system in our published results.

## Challenges we ran into

Benchmark harnesses lie by accident. Two problems were hard. A dead
endpoint must not score as "recalled nothing, gracefully," so empty results
and backend failures are distinct shapes in the code. And correction tests
must stay inside the benchmark session, so the harness can never pollute a
real memory store. Both cost us real design time. Both are now hard
contracts in the code.

## Accomplishments we're proud of

A memory benchmark you can run in 60 seconds with zero setup. A correction
score no other one-command harness gives you. And the discipline behind it:
no number ships in our docs without a committed artifact behind it.

## What we learned

Grading corrections is a judge-quality problem. We had to get GPT-5.6 to
agree with human judgment on one question: did the system really accept the
fix? That taught us more about prompt design than any new feature would
have.

## What's next

A public results page at remnic.ai, fed by the publish pipeline that
already exists. More backend adapters from the community. And the full
write-up: MemCorrect is part of our Glass-Box Memory paper (draft in the
repo). The paper engages prior art like StateBench and MemoryAgentBench
honestly. This is a protocol claim, not a "first to think of it" claim.

## Try it (judges)

No datasets, no API keys, no network needed for the smoke path:

```bash
npm install -g @remnic/cli @remnic/bench
remnic bench run --quick longmemeval
remnic bench runs list
remnic bench export <run-id> --format html
```

With an OPENAI_API_KEY, the same commands run real datasets with the
GPT-5.6 judge. Setup details live in `packages/bench/README.md`.
Reproduction paths live in `docs/paper/repro-appendix.md`.
