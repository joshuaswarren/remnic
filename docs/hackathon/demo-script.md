# MemCorrect Build Week demo script

Target duration: 2 minutes 40 seconds. Hard limit: 3 minutes.

Operator gate before recording: replace every bracketed placeholder used in the
video with real evidence. Do not record until the npm cold-install path and
Codex `/feedback` session ID exist. If the GPT-5.6 frontier artifact does not
land, omit that result and its URL rather than substituting another model or
turning a bounded trial into a full-run claim.

## 0:00-0:20: the stale-memory problem

Picture: A simple card showing an original fact, a user correction, and a
later answer that repeats the original fact.

Voiceover: "Agent memory demos show that an assistant remembers. The harder
question is whether it can forget something you corrected. A stale memory can
make an agent confidently act on a fact the user already fixed. MemCorrect
turns that failure into a reproducible test."

## 0:20-0:45: one command, real MCP path

Picture: A clean terminal. Run:

```bash
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo
```

Voiceover: "This keyless smoke run starts the packaged stdio MCP memory
server and benchmarks it through the same generic adapter an external backend
uses. There is no dataset download and no model call. The demo is deliberately
small; it proves the transport, correction contract, and report flow."

Keep the terminal output visible long enough to show `uptake_at_next` and
`non_resurrection`. Do not describe either value until it appears on screen.

## 0:45-1:15: accepted correction versus stale resurrection

Picture: Highlight the two emitted metrics, then open the task detail in the
HTML report.

Voiceover: "These are separate checks. Uptake asks whether the next answer
uses the correction. Non-resurrection asks whether the old fact returns later.
The packaged demo currently accepts the correction immediately but later serves
the stale fact again. MemCorrect catches both behaviors instead of collapsing
them into one flattering score."

If the packaged demo behavior changes before recording, update this beat to the
actual output. Never narrate a metric that is not visible in the recorded run.

## 1:15-1:40: self-contained report card

Picture: Run `remnic bench runs list`, then:

```bash
remnic bench export <run-id> --format html --output ./memcorrect-report.html
```

Open the generated file. Scroll from the correction ledger to the dimension
table, task drill-down, and provenance section.

Voiceover: "The output is one offline HTML report: correction evidence,
per-dimension metrics, every persisted task, and the run provenance. It is a
receipt, not a dashboard that disappears when a service does."

## 1:40-2:10: any conforming memory server

Picture: Show the help lines for `--mcp-command`, `--mcp-url`, and
`--mcp-tool-map`. Do not show a vendor logo unless that exact integration was
run and recorded.

Voiceover: "Replace the demo with a stdio command or Streamable HTTP URL.
For a non-canonical MCP surface, map the store, recall, correct, and reset tools
and their argument semantics explicitly. Preflight rejects an unsafe or
unscoped server; a backend failure never gets scored as an innocent empty
recall."

## 2:10-2:35: Codex and GPT-5.6 roles

Picture: Show the dated implementation commit, selected test names, and the
model provenance from a real artifact. If available, briefly show
`[CODEX_FEEDBACK_SESSION_ID]`, `[GPT_5_6_ARTIFACT_URL]`, and the sanitized
credit summary. Do not show the private JSON ledger.

```bash
export OPENAI_API_KEY=...
remnic bench run --quick memcorrect-v1 --adapter mcp --mcp-demo \
  --judge-provider openai --judge-model gpt-5.6
```

Voiceover: "Codex built and adversarially reviewed the new MCP adapter,
Responses provider, and report card during Build Week. GPT-5.6 is the optional
structured-output judge inside the harness. Our bounded CLI measurement uses
Luna for bulk work and Terra for quality-critical judging, with every completed
turn charged to the harness ledger. The account stays exclusive to that run,
and missing usage blocks further dispatch. Remnic itself and the original
benchmark package are prior work; our public evidence ledger draws that line
commit by commit."

The exact API model id above is `gpt-5.6`. It is distinct from the
ChatGPT-backed Codex CLI slugs `gpt-5.6-luna` and `gpt-5.6-terra`. If the CLI
artifact is shown, its run must use one-shot isolated `codex exec` calls, normal
service rather than fast mode, a 2,473-credit budget, a 473-credit reserve, and
the real model labels. `gpt-5.6-sol` is opt-in only and is outside the bounded
plan. Confirm ChatGPT authentication with `codex login status` and the catalog
with `codex debug models` immediately before recording.

Do not say GPT-5.6 was benchmarked as the system under test unless the real,
hash-locked artifact is on screen.

## 2:35-2:40: close

Picture: Repository URL and `HACKATHON.md` evidence link.

Voiceover: "MemCorrect: because agent memory without evals is vibes with a
database."

## Recording checklist

- [ ] Public YouTube URL: `[YOUTUBE_URL]`
- [ ] Runtime is under 3 minutes and audio is present.
- [ ] Audio explicitly explains both Codex and GPT-5.6 usage.
- [ ] Commands shown match the released packages or the disclosed source path.
- [ ] No API key, token, personal data, or private terminal history is visible.
- [ ] Every narrated score appears in the recorded artifact.
- [ ] Any CLI artifact identifies Luna/Terra separately from API `gpt-5.6`.
- [ ] Any credit claim reconciles 2,473 total, 473 reserved, and 2,000 usable.
- [ ] No fast-mode or Sol run is presented as part of the bounded plan.
- [ ] Codex `/feedback` session ID: `[CODEX_FEEDBACK_SESSION_ID]`
- [ ] GPT-5.6 artifact, if claimed: `[GPT_5_6_ARTIFACT_URL]`
