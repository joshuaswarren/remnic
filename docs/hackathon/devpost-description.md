# Devpost submission text (OpenAI Build Week 2026)

Status: DRAFT. Do not paste this into Devpost yet. First, check each claim
against the shipped code. Add the Codex `/feedback` session ID and video URL.
The paid GPT-5.6 proof named here is now public. Each clean receipt binds to a
private result and manifest. LongMemEval also has a clean public artifact.
`HACKATHON.md` tracks the last operator gates. This file must pass voice-lint
in article mode before it ships.

Project name: MemCorrect: benchmark an AI agent's memory.

Category: Developer Tools. MemCorrect helps developers test and compare an
agent's memory backend. It is not an end-user memory assistant.

Tagline: Agent memory without evals is vibes with a database. One MemCorrect
command can score Remnic or another conforming memory backend. It checks
recall, corrections, and harm from stale facts. GPT-5.6 can grade answers when
you select it.

Built with: typescript, node.js, gpt-5.6, codex, openai-responses-api, mcp,
sqlite.

## Inspiration

Everyone is shipping agent memory. Almost no one tests it. Demos show an agent
that recalls your name. They skip what happens three weeks later. You say,
"Actually, we moved off PostgreSQL." The agent still cites the old choice.
That is not a small flaw. An agent that acts on stale facts can be worse than
one with no memory.

We build Remnic, an open-source memory engine. We saw memory tools, ours
included, make claims with no proof. So we built the proof machine.

## What it does

MemCorrect tests the memory system behind an AI agent with one command:

```bash
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo
```

It scores three things that most memory tests skip. First, did the agent find
the right fact at the right time? We test that with LongMemEval, LoCoMo, and
other sets. Second, did the memory use a fact that the user fixed? Third, did
the old fact come back after the fix?

It runs against Remnic or any MCP memory backend that meets the contract. The
MCP adapter works with stdio and Streamable HTTP. You can also map tools and
arguments for a custom surface. When selected, GPT-5.6 grades the answers. It
can use the OpenAI Responses API or an isolated Codex CLI call. Each run writes
a locked manifest with hashes, seeds, git state, and config. The output is a
memory report card you can share. "Our memory is good" becomes a score that
anyone can check again.

## How we built it

Codex sessions built the new Build Week work. We added GPT-5.6 as an opt-in
judge through the OpenAI Responses API and Codex CLI. The contest runs use the
CLI because the event grant pays in Codex credits, not API credits. The Codex
`/feedback` session ID is still operator input. It must be in the form before
submission. We mark the line between prior work and new work, commit by commit,
in
[HACKATHON.md](https://github.com/joshuaswarren/remnic/blob/main/HACKATHON.md).

Codex first studied our adapter seam. It then built the generic MCP memory
adapter and its tests. It added checks that decide if a backend can be scored.
It wired in the GPT-5.6 judge and its versioned rules. Codex also turned the
HTML export into one scored report card for your team.

The API provider still uses model ID `gpt-5.6`. It did not run the contest
tests. The ChatGPT-backed CLI uses `gpt-5.6-luna` for bulk and internal work.
It uses `gpt-5.6-terra` for key judge calls. Each call starts a fresh, isolated
`codex exec`. Fast mode is not allowed. During a run, the account is for this
harness alone. The guard keeps 473 of 2,473 credits in reserve. Planned spend
cannot top 2,000 credits. Bounded mode checks the ChatGPT login. After each
turn, the harness logs input, cached input, and output use. If exact use is
missing, it blocks the next call. `gpt-5.6-sol` is opt-in and not part of this
plan.

We do not claim a GPT-5.6 result without a clean receipt. It must bind to the
private result and manifest. The proof meets that gate: a full 500-task
LongMemEval
[artifact](https://github.com/joshuaswarren/remnic/blob/main/docs/benchmarks/results/2026-07-17-longmemeval-gpt-5.6-luna-810f36a.json)
and [receipt](https://github.com/joshuaswarren/remnic/blob/main/docs/benchmarks/evidence/2026-07-17-longmemeval-gpt-5.6-luna-build-week-receipt.json),
and a full 40-scenario MemCorrect
[receipt](https://github.com/joshuaswarren/remnic/blob/main/docs/benchmarks/evidence/2026-07-17-memcorrect-v1-gpt-5.6-luna-build-week-receipt.json).
Both runs used fresh stores, not production Remnic data. Both made zero Sol
calls. Usage totals are local tool estimates, not account bills. We do not call
the Terra scores calibrated. We do not use them for cross-system rank claims.

## Challenges we ran into

Test tools can lie by accident. Two bugs were hard. A dead endpoint must not
score as "no facts found." Empty results and backend faults are now distinct
states in the code. A correction test must also stay in its own test session.
It must never touch a real memory store. Both rules are now hard contracts.

## Accomplishments we're proud of

You can run the quick test with no key after install. One command checks MCP,
correction uptake, and harm from stale facts. Each public number needs a clean
receipt. Each rank claim also needs a clean artifact and manifest.

The full LongMemEval run finished 500/500 tasks with no failures. It scored
`0.762` judge accuracy, `0.5551` F1, and `0.49` exact answer containment. The
full MemCorrect run finished 40/40 tasks with no failures. But its result was
mixed. The model judge gave correction acceptance a `0.9875`. The fixed checks
gave next-turn uptake and non-resurrection a `0`. We publish that split. We do
not call the memory system a success.

## What we learned

The judge itself is part of the test. The full MemCorrect run made that plain.
Terra gave correction acceptance a high score. The fixed containment checks
failed. So we mark model scores as uncalibrated. We keep fixed checks in their
own rows. We avoid one headline score. That rule shaped the rubric and the
proof saved with each run.

## What's next

Next comes a public results page at remnic.ai. The publish pipe is already in
place. We also want more memory adapters from the community. MemCorrect is part
of our Glass-Box Memory paper draft in the repo. That paper covers prior work,
such as StateBench and MemoryAgentBench. We claim a test protocol, not that we
were first to think of the problem.

## Try it (judges)

Version 9.6.34 of both packages is public. After install, the smoke path needs
no data set, API key, or network:

```bash
npm install -g @remnic/cli@9.6.34 @remnic/bench@9.6.34
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo
remnic bench runs list
remnic bench export <run-id> --format html --output ./memcorrect-report.html
```

The quick run uses the packed stdio MCP server. The exact 9.6.34 install passed
in a clean Linux x86_64 prefix. It made a 15,128-byte offline report. The run
needs no data set, key, or network. It uses the real adapter.

The paid GPT-5.6 run is not a copy-paste judge step. It needs the account,
budget, reserve, private ledger, and no-Sol guards in `HACKATHON.md`. That path
uses the operator's Codex CLI login. It does not need `OPENAI_API_KEY`. The full
steps are in `docs/paper/repro-appendix.md`.
