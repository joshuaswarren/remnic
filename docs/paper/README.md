# Paper — Glass-Box Memory (working draft)

Working title: **Glass-Box Memory: Correctable, Provenance-Tracked Memory for
User-Aware Agents.**

This directory holds the in-repo working draft of the arXiv paper for the
evidence sprint (epic #1725). It is a **skeleton**, not a finished paper: every
section is a short statement of intent plus clearly-marked `TODO(#NNNN)`
placeholders pointing at the issue that owns the real content. **No results,
numbers, or claims live here yet** — when a number is needed, it is a TODO that
references a committed artifact, never a fabricated value.

## Source of truth

- **Outline:** `docs/plans/2026-07-07-evidence-sprint-arxiv-outline.md` (Part 1).
  This skeleton matches that outline section-for-section; if the two diverge,
  the plan wins and this file is wrong.
- **Authoritative issue:** #1726.

## Why markdown and not `.tex`

There is no LaTeX tooling anywhere in this repo (no `documentclass`, no
`*.tex`, no paper/latex script in `package.json`). The rest of `docs/` is
markdown, so the draft is markdown too. If a later sprint adopts LaTeX, the
skeleton is a one-file conversion — the content boundaries are the deliverable,
not the markup.

## Layout

| File | Owner | Status |
|---|---|---|
| `main.md` | #1726 (this issue) | Skeleton — abstract + §1–§9, intent + TODOs only |
| `related-work.md` | #1729 (sibling issue) | Not created here. `main.md` §2 points at it. |
| `repro-appendix.md` | follow-up child of the plan's execution item 8 | Not created here. `main.md` §9 points at it. |

Section-level standalone files are intentionally avoided except where a sibling
issue owns one (`related-work.md`). Keeping the rest of the skeleton in a single
`main.md` prevents collisions with the wave of section-drafting children.

## Non-negotiable drafting rules (lifted from the plan + repo rule 55)

1. **No fabricated numbers.** Every metric cited must trace to a committed
   artifact under `docs/benchmarks/results/` (or a sibling path). Anything not
   yet produced is a `TODO(#NNNN)`, never a placeholder value.
2. **Cite only committed artifacts.** As of this skeleton the only real
   (non-mock) committed artifacts are the two Tier-L local runs at
   `docs/benchmarks/results/2026-07-07-locomo-qwen2.5-7b-32k_latest-47aae03.json`
   and
   `docs/benchmarks/results/2026-07-07-longmemeval-qwen2.5-7b-32k_latest-47aae03.json`
   (both `tier: "local"`, model `qwen2.5-7b-32k:latest`). The
   `2026-04-20-*-mock000.json` files are **mocks** and must never be cited as
   results.
3. **No Tier-F claim without the real run.** A complete Tier-F responder run
   (Opus 4.8 via `claude -p`) is still pending for the full dataset. The
   bounded artifacts and provider are available; §6 Results and §5 Tier-F rows
   must distinguish trial coverage from full coverage.
4. **Lead with MemCorrect (composition framing), not raw Tier-L accuracy.** Per
   Joshua's confirmed decision (2026-07-07). MemCorrect's novelty is a
   composition/protocol claim, **not** "first to measure memory correction" —
   the plan's Novelty section names StateBench / STALE / MemSyco-Bench /
   MemStrata / MemoryAgentBench as prior art that must be engaged.
5. **Label `claude -p` with complete provenance.** A `claude -p` number is
   "Opus 4.8 via Claude Code," a valid research-harness measurement distinct
   from a raw-API run. Keep `tier: "frontier"` when the artifact contract is
   satisfied; carry provider, harness, model, isolation, invocation, and
   artifact labels in metadata. Do not invent a new tier value.
6. **Keep the corrected KU framing.** `docs/benchmarks/memcorrect.md` already
   reads *"the strongest systems score roughly 70–90%, not ceiling"* (the old
   "near ceiling" wording was removed before this skeleton landed). The §4
   draft must preserve this corrected framing; do not re-introduce the old
   wording.

## TODO conventions

`TODO(#NNNN): <what is missing>` — the issue number is the owner of the real
content. `TODO(#1726)`: this issue itself closes a gap. `N/A`: the section has
no outstanding owner issue (e.g. limitations prose is draft-only, no build
work).
