# Passive correction detection is guarded and polarity-agnostic; notification drains preserve the queue on cancellation

Status: accepted

## Context
Passive correction detection infers corrections from conversational text and queues notifications consumed by briefings. False positives from quoted speech or fixtures would corrupt memory; a briefing cancelled mid-drain would silently lose the consumed items.

## Decision
The detector only treats double-quoted spans as quoted speech; corrections inside quotation marks are rejected (the user is reporting someone else's words). Anti-fixture guards take precedence — one guard kills all corrections for the input. Correction dedup is polarity-agnostic ("we don't use X anymore" matches a memory saying "we use X"). The notification drain keeps the queue intact when cancellation arrives after the read, because the caller never receives what the drain consumed. Malformed queue lines are skipped (best-effort, never crash a briefing), and the file is cleared by delete, which is atomic enough for this use.

## Consequences
Single-quoted speech is not recognized and may produce corrections from quoted material; callers needing that must upgrade the quote parser. A cancelled briefing re-reads its notifications on the next run.

## Origin comments
- `packages/remnic-core/src/correction/passive-correction-detector.ts:226` — "// Only DOUBLE quotes delimit quoted speech. Single quotes (ASCII apostrophe"
- `packages/remnic-core/src/correction/passive-correction-detector.ts:285` — "// Anti-fixture guards take precedence — one guard kills ALL corrections"
- `packages/remnic-core/src/correction/passive-correction-detector.ts:296` — "// Reject corrections that appear within quotation marks — the user is"
- `packages/remnic-core/src/correction/passive-correction-detector.ts:304` — "// Polarity-agnostic: "actually, we don't use Redis anymore" matches"
- `packages/remnic-core/src/correction/passive-correction-notifications-abort.test.ts:12` — "// Issue #3139 review: a briefing cancelled mid-drain must leave the queue"
- `packages/remnic-core/src/correction/passive-correction-notifications-abort.test.ts:13` — "// intact, because the caller never receives what the drain consumed."
- `packages/remnic-core/src/correction/passive-correction-notifications.ts:101` — "// Cancellation after the read must keep the queue: the caller never receives these."
- `packages/remnic-core/src/correction/passive-correction-notifications.ts:110` — "// Skip malformed lines (rule 34 — best-effort, never crash a briefing)."
- `packages/remnic-core/src/correction/passive-correction-notifications.ts:115` — "// Clear the file atomically (delete is atomic enough for this use case —"
