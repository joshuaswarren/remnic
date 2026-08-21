# MemCorrect Build Week demo script

Target duration: 2 minutes 40 seconds. Hard limit: 3 minutes.

Operator gate before recording: replace every bracketed placeholder used in the
video with real evidence. The version 9.6.34 registry-install path is verified
on Linux x86_64. The Codex `/feedback` session ID and public YouTube URL are
still required. The full GPT-5.6 LongMemEval artifact and sanitized LongMemEval
and MemCorrect receipts are committed. Do not show private results, reports, or
the ledger, and do not turn MemCorrect's mixed evidence into a success claim.

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
In the verified version 9.6.34 packaged run, uptake was 1. Non-resurrection was
0: the correction appeared at once, but the stale fact returned later.
MemCorrect catches both behaviors instead of hiding them in one score."

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
and their arguments. Preflight rejects an unsafe or unscoped server. It also
keeps a backend failure separate from an empty recall."

## 2:10-2:35: Codex and GPT-5.6 roles

Picture: Show the dated implementation commit, selected test names, and the
model provenance from the
[LongMemEval artifact](../benchmarks/results/2026-07-17-longmemeval-gpt-5.6-luna-810f36a.json),
[LongMemEval receipt](../benchmarks/evidence/2026-07-17-longmemeval-gpt-5.6-luna-build-week-receipt.json),
and [MemCorrect receipt](../benchmarks/evidence/2026-07-17-memcorrect-v1-gpt-5.6-luna-build-week-receipt.json).
Briefly show `[CODEX_FEEDBACK_SESSION_ID]`. Do not show the private JSON ledger,
private report, or launch a paid call while recording.

Voiceover: "Codex built and adversarially reviewed the new adapter, providers,
and report card. Competition runs used isolated, one-shot Codex CLI calls:
Luna for responder and internal work, Terra for judging. Full LongMemEval
completed 500 tasks with 0.762 judge accuracy. Full MemCorrect completed 40,
but its evidence was mixed: 0.9875 model-judged acceptance while deterministic
next-turn uptake and non-resurrection were both zero. The public receipts keep
that divergence and the prior-work boundary visible."

The optional API provider uses model id `gpt-5.6`. Competition measurements
use the Codex CLI slug `gpt-5.6-terra` for judging and `gpt-5.6-luna` for bulk
responder and internal work. If a CLI result is shown, its run must
use isolated one-shot `codex exec` calls and normal service, not fast mode. It
must show the 2,473-credit budget, 473-credit reserve, and real model labels.
`gpt-5.6-sol` is opt-in only and is outside the bounded plan. Right before
recording, check the login with `codex login status` and the model list with
`codex debug models`.

Show the real hash-locked artifact when narrating the LongMemEval score. Show
the sanitized MemCorrect receipt when narrating its mixed metrics.

## 2:35-2:40: close

Picture: Repository URL and `HACKATHON.md` evidence link.

Voiceover: "MemCorrect: because agent memory without evals is vibes with a
database."

## Recording checklist

- [ ] Public YouTube URL: `[YOUTUBE_URL]`
- [ ] Runtime is under 3 minutes and audio is present.
- [ ] Audio explicitly explains both Codex and GPT-5.6 usage.
- [ ] Commands shown match the released packages or the disclosed source path.
- [ ] The keyless package receipt identifies version 9.6.34 and does not imply
  a paid-model run.
- [ ] No API key, token, personal data, or private terminal history is visible.
- [ ] Every narrated score appears in the recorded artifact.
- [ ] Any CLI artifact identifies Luna/Terra separately from API `gpt-5.6`.
- [ ] Any credit claim reconciles 2,473 total, 473 reserved, and 2,000 usable.
- [ ] No fast-mode or Sol run is presented as part of the bounded plan.
- [ ] Codex `/feedback` session ID: `[CODEX_FEEDBACK_SESSION_ID]`
- [ ] GPT-5.6 LongMemEval artifact and both sanitized receipts are visible from
  the committed paths linked above.
