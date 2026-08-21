# Extraction Judge: LLM-as-Judge Fact-Worthiness Gate

## What it does

The extraction judge is an optional post-extraction filter that evaluates each
candidate fact against a **durability rubric** before it is written to the memory
store. A fact is considered "durable" if it will still be useful 30+ days from
now and across multiple sessions.

The goal is to reduce memory store noise without losing valuable facts. The judge
complements the existing local-heuristic importance gate (issue #372) by adding
an LLM-powered semantic evaluation layer.

## Why

The local importance scorer catches trivial content (greetings, filler, very
short text) but cannot evaluate whether substantive-looking content is actually
worth persisting long-term. For example, "currently debugging line 42 of
parser.ts" passes the importance gate but is transient task state that will be
stale within hours.

## Config properties

| Property | Type | Default | Description |
|---|---|---|---|
| `extractionJudgeEnabled` | boolean | `false` | Enable the judge gate (opt-in) |
| `extractionJudgeModel` | string | `""` | Model override; empty = use local model |
| `extractionJudgeBatchSize` | number | `20` | Max candidates per LLM batch call |
| `extractionJudgeShadow` | boolean | `false` | Log verdicts but do not filter |

## How to enable and calibrate

1. **Start in shadow mode** to observe verdicts without affecting writes:
   ```json
   {
     "extractionJudgeEnabled": true,
     "extractionJudgeShadow": true
   }
   ```

2. **Monitor logs** for `extraction-judge[shadow]` entries. Review the
   `would reject` messages to verify the rubric aligns with your expectations.

3. **Switch to active mode** once satisfied:
   ```json
   {
     "extractionJudgeEnabled": true,
     "extractionJudgeShadow": false
   }
   ```

4. **Tune batch size** if you have large extraction runs:
   ```json
   {
     "extractionJudgeBatchSize": 10
   }
   ```

## Durability rubric

The judge evaluates each fact against these criteria:

**Durable** (approve):
- Personal preferences, identities, relationships
- Decisions with rationale
- Corrections to previously held beliefs
- Principles, rules, constraints
- Stable project/tool/workflow facts
- Commitments, deadlines, obligations

**Not durable** (reject):
- Transient task details
- Ephemeral state
- Routine operations
- Conversational filler
- Information stale within hours
- One-time step-by-step instructions

## Safety bypasses

The following categories are **auto-approved** without LLM evaluation:
- `correction` — always persisted (user corrections must never be lost)
- `principle` — always persisted (durable rules/values)
- Facts with `critical` local importance level

## Performance budget

Target: 1.5s or less per batch. The LLM call uses a 1.5s timeout. An
in-memory content-hash cache (keyed by SHA-256 of `text + category`) avoids
redundant LLM calls for previously judged content within the same process
lifetime.

## Architecture

```
extractedFacts
    |
    v
[importance gate] -- drops trivial content (local heuristic)
    |
    v
[judge gate] -- drops non-durable content (LLM evaluation)
    |               - auto-approves corrections, principles, critical
    |               - batches remaining candidates
    |               - checks content-hash cache
    |               - calls LocalLlmClient, falls back to FallbackLlmClient
    |               - fails open on any error
    |
    v
[semantic dedup] -- drops near-duplicates (embedding similarity)
    |
    v
  writeMemory()
```

The judge runs *after* the importance gate (so trivial facts never incur an LLM
call) and *before* semantic dedup (so rejected facts never incur an embedding
lookup).
