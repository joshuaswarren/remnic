# Devpost submission text (OpenAI Build Week 2026)

Status: DRAFT. Do not paste this copy into Devpost yet. First, check every
claim against shipped code. Add the Codex `/feedback` session ID and video URL.
Any paid GPT-5.6 result named here also needs a committed, sanitized evidence
receipt tied to its private hash-locked result and manifest.
`HACKATHON.md` tracks those gates. This file must pass voice-lint in article
mode before each revision ships.

Project name: MemCorrect: benchmark an AI agent's memory.

Category: Developer Tools. MemCorrect is infrastructure for developers to test
and compare an agent's memory backend, not an end-user memory assistant.

Tagline: Agent memory without evals is vibes with a database. MemCorrect
scores Remnic or another conforming memory backend with one command. It checks
recall quality, correction handling, and stale-memory harm. GPT-5.6 can grade
answers when selected.

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
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo
```

It scores three things most memory benchmarks skip. First, recall: does the
agent surface the right fact at the right time? We measure that on
LongMemEval, LoCoMo, and friends. Second, corrections: when the user fixes
a stored fact, does the memory actually update? Third, stale-memory harm:
after a fix, does the old fact ever come back?

It runs against Remnic or another conforming MCP memory backend. A generic MCP
adapter supports stdio and Streamable HTTP plus explicit tool and argument
mapping for non-canonical surfaces. When selected, GPT-5.6 grades answers
through either the OpenAI Responses API or an isolated, one-shot Codex CLI
provider. Every run
writes a locked manifest: dataset hashes, seeds, git state, config. The
output is a memory report card you can share. "Our memory is good" becomes
a scored claim anyone can re-run.

## How we built it

The new work for Build Week was built in Codex sessions. GPT-5.6 was integrated
as an opt-in judge through both the OpenAI Responses API and the Codex CLI. The
competition measurements use the CLI because the event grant is denominated in
Codex credits rather than API credits. The Codex `/feedback`
session ID remains operator input and must be added to the form before
submission. The line between prior work and hackathon work is drawn commit by
commit in
[HACKATHON.md](https://github.com/joshuaswarren/remnic/blob/main/HACKATHON.md).

Codex studied our adapter seam first. Then it built the generic MCP memory
adapter, its tests, and the checks that decide if a backend can be scored
at all. It wired GPT-5.6 in as the judge and implemented the versioned rubric.
Codex then polished the HTML export into one scored report card you can
hand to your team.

The API provider remains available with model id `gpt-5.6`, but it is not the
provider used for the competition measurements. The ChatGPT-backed Codex CLI
provider assigns `gpt-5.6-luna` to bulk responder and internal
work, and `gpt-5.6-terra` to quality-critical judging. Each completion is a
fresh, isolated `codex exec`; the protocol forbids fast mode. During a
benchmark window, it requires exclusive account use and keeps 473 of the
2,473-credit grant in reserve, so planned spend cannot exceed 2,000 credits.
Bounded mode verifies ChatGPT authentication. The harness records actual
input, cached-input, and output usage after every completed turn and blocks
further dispatch if exact usage is missing.
`gpt-5.6-sol` is opt-in only and outside that bounded plan. We do not claim a
published GPT-5.6 model result until a sanitized receipt is committed and tied
to a private hash-locked result and manifest. Bounded evidence is labeled with
its exact coverage and is never presented as a full benchmark run.

## Challenges we ran into

Benchmark harnesses lie by accident. Two problems were hard. A dead
endpoint must not score as "recalled nothing, gracefully," so empty results
and backend failures are distinct shapes in the code. And correction tests
must stay inside the benchmark session, so the harness can never pollute a
real memory store. Both cost us real design time. Both are now hard
contracts in the code.

## Accomplishments we're proud of

A keyless quick benchmark you can run after installation. One command
exercises MCP correction uptake and stale-memory harm together. And the
discipline behind it: every public submission number requires a committed
artifact behind it.

## What we learned

Grading corrections is a judge-quality problem. A plausible score is not enough;
the judge must be calibrated against labeled examples before it supports a
headline claim. That constraint shaped the versioned rubric and explicit
provenance in every result.

## What's next

A public results page at remnic.ai, fed by the publish pipeline that
already exists. More backend adapters from the community. And the full
write-up: MemCorrect is part of our Glass-Box Memory paper (draft in the
repo). The paper engages prior art like StateBench and MemoryAgentBench
honestly. This is a protocol claim, not a "first to think of it" claim.

## Try it (judges)

Version 9.6.34 of both packages is published. After installation, the smoke
path needs no dataset, API key, or network:

```bash
npm install -g @remnic/cli@9.6.34 @remnic/bench@9.6.34
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo
remnic bench runs list
remnic bench export <run-id> --format html --output ./memcorrect-report.html
```

The quick run uses a packaged stdio MCP server. The exact 9.6.34 registry
install passed in a clean Linux x86_64 global prefix and produced a
15,128-byte offline report. The run itself needs no
dataset, key, or network, and it exercises the real adapter. To add GPT-5.6
judging with Codex credits, append `--judge-provider codex-cli
--judge-model gpt-5.6-terra --judge-codex-reasoning-effort high`. This path
uses the operator's Codex CLI login and does not require `OPENAI_API_KEY`.
Reproduction paths live in
`docs/paper/repro-appendix.md`.
