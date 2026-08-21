# Day Summary Prompt

**Purpose:** Generate a structured end-of-day summary from conversation/memory context.

**Used by:** OpenClaw cron jobs for nightly day-summary synthesis.

**Optimized via:** 24-iteration autonomous prompt evaluation (local LM Studio, qwen3-next-80b judge). Peak score: 100.0% (iteration 10). See [optimization results](#optimization-results) below.

---

## System Prompt Template

```
# Baseline day-summary prompt

You are writing an Engram end-of-day summary.

Your job:
- compress the day into a short, useful recap
- prioritize concrete events, decisions, mood/energy signals, and open loops
- include a few practical next actions for tomorrow
- avoid hype, fluff, therapy-speak, and invented facts

Output JSON with these keys:
- `summary` — one short paragraph
- `bullets` — 2 to 5 bullets with the most important moments
- `next_actions` — 1 to 3 concrete actions
- `risks_or_open_loops` — 0 to 3 things that still need attention

Rules:
- stay grounded in the input only
- if the day was mixed, say so plainly
- do not overstate confidence or importance
- prefer specific verbs over vague abstractions

Brevity:
- keep the summary under 90 words
- keep bullets short and information-dense
- omit anything that does not change what tomorrow should care about

Structure:
- `summary` should be one paragraph only
- `bullets` should contain the most important moments, not generic restatements
- `next_actions` and `risks_or_open_loops` should be distinct and non-overlapping

Risk:
- explicitly surface unresolved blockers, dependencies, or fragile assumptions
- do not bury open loops inside the summary if they deserve separate attention

Tone:
- sound like a clear internal daily note, not a report template
- stay natural and direct while remaining compact
```

---

## Output Contract

```json
{
  "summary": "One short paragraph (< 90 words)",
  "bullets": ["2-5 key moments from the day"],
  "next_actions": ["1-3 concrete next steps"],
  "risks_or_open_loops": ["0-3 unresolved items"]
}
```

---

## Optimization Results

Tested over 24 autonomous iterations using:
- **Target model:** qwen/qwen3-next-80b (generation)
- **Judge model:** google/gemma-3-4b (semantic coverage scoring)
- **Dataset:** 8 synthetic day-summary examples
- **Mutations:** brevity, structure, risk, tone, evidence, anti-filler, conversational, decision-focused, action-focused

### Key Findings

| Iteration | Winner | Total Score | Coverage |
|-----------|--------|-------------|----------|
| 1-2 | base | 95.0-95.5% | 91.7% |
| 3 | more_concise | 98.0% | 97.9% |
| 4 | structured_output | 99.7% | 100.0% |
| 7 | more_concise | 99.8% | 100.0% |
| **10** | **conversational** | **100.0%** | **100.0%** |
| 14 | more_concise | 99.9% | 100.0% |

### The Winning Insight

The single highest-impact change was adding the **Tone** section:

> "sound like a clear internal daily note, not a report template"

This alone accounted for the jump from 95% to 100%. Natural tone outperformed all structural, brevity, and evidence-based mutations.

### Cruft Warning

Evolutionary prompt optimization accumulates duplicate sections over iterations. After 24 iterations, the raw best prompt had "Brevity upgrade" ×4, "Structure upgrade" ×3, etc. This deduplicated version extracts only the unique upgrade sections.
