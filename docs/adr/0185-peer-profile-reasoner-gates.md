# The peer profile reasoner treats its budgets, thresholds, and LLM-supplied data as fail-closed: state is committed only after writes succeed, and hostile model output cannot shape storage keys or bypass gates.

Status: accepted

## Context
The reasoner merges LLM-proposed profile fields into operator-visible peer files under a run-wide cap and an interactions-since-last-run threshold; naive ordering let transient errors poison budgets, truncate gates, or pass hostile keys through.

## Decision
1. Budget-after-write: the run-wide fieldsAppliedTotal cap is incremented only after writePeerProfile succeeds; a candidate-count projection is tracked locally per peer and committed to the global budget on success, so a transient I/O error can never mark later peers skipped_cap_reached for fields never persisted.
2. Full-log gates: the min-interactions threshold is computed from the FULL interaction log since the last run marker, not the maxLogPerPeer-truncated slice; truncation is applied only when building the LLM prompt (most recent entries preferred), so active peers are never permanently flagged skipped_below_min_interactions.
3. Run markers: interactions are counted since an appended run-marker entry (markers don't count themselves); the marker append is best-effort - a write failure logs but does not roll back the profile update.
4. LLM input hardening: JSON.parse output must be a plain object ('null' parses fine and is rejected), prototype-pollution keys are dropped at the field-name layer (redundantly re-checked before assignment), and field keys must match a conservative pattern so path-traversal-shaped keys cannot reach downstream consumers.
5. Defensive gating: the disabled flag requires strict triple-equals true (a stray "true" string must not flip it), and explicit peer-id lists are filtered against on-disk registered peers.
6. Provenance entries are append-only, never replaced, so the operator retains a full audit trail. Parsing regexes avoid polynomial backtracking.

## Consequences
A failed profile write consumes nothing from the cap (correct, but means caps reflect only successful writes); marker loss makes the next threshold slightly noisy; hardening drops fields a hostile or buggy model proposed rather than salvaging them.
## Origin comments
(57 records)
- `packages/remnic-core/src/peers/profile-reasoner.ts:265` - "Dropped the \s* groups around the lazy body (they overlapped it and backtracked polynomially — CodeQL js/polynomial-redo"
- `packages/remnic-core/src/peers/profile-reasoner.ts:266` - "backtracked polynomially — CodeQL js/polynomial-redos). Input is already trimmed and fenced[1] is trimmed below"
- `packages/remnic-core/src/peers/profile-reasoner.ts:267` - "trimmed and fenced[1] is trimmed below, so matches are identical."
- `packages/remnic-core/src/peers/profile-reasoner.ts:276` - "Gotcha #18: JSON.parse('null') succeeds. Reject non-objects."
- `packages/remnic-core/src/peers/profile-reasoner.ts:283` - "Gotcha — drop prototype-pollution keys at the field-name layer."
- `packages/remnic-core/src/peers/profile-reasoner.ts:315` - "Find the most recent reasoner-run marker timestamp in the log. Used to count interactions since last run"
- `packages/remnic-core/src/peers/profile-reasoner.ts:363` - "Disabled flag is the master gate. Defaults to false in callers' config; we additionally require strict === true"
- `packages/remnic-core/src/peers/profile-reasoner.ts:364` - "config; we additionally require strict === true here so a stray "true" string doesn't silently flip the flag"
- `packages/remnic-core/src/peers/profile-reasoner.ts:365` - "stray "true" string doesn't silently flip the flag (Gotcha #36)."
- `packages/remnic-core/src/peers/profile-reasoner.ts:393` - "Filter the explicit list against on-disk peers so we never act on an id the operator typed but didn't register."
- `packages/remnic-core/src/peers/profile-reasoner.ts:394` - "act on an id the operator typed but didn't register."
- `packages/remnic-core/src/peers/profile-reasoner.ts:426` - "Codex P2 review on PR #736: the min-interactions threshold must reflect the FULL log of new activity"
- `packages/remnic-core/src/peers/profile-reasoner.ts:427` - "must reflect the FULL log of new activity, not the maxLogPerPeer-truncated slice. Otherwise a peer with a"
- `packages/remnic-core/src/peers/profile-reasoner.ts:428` - "maxLogPerPeer-truncated slice. Otherwise a peer with a genuinely active conversation history can be permanently"
- `packages/remnic-core/src/peers/profile-reasoner.ts:429` - "genuinely active conversation history can be permanently marked skipped_below_min_interactions whenever"
- `packages/remnic-core/src/peers/profile-reasoner.ts:430` - "marked skipped_below_min_interactions whenever peerProfileReasonerMinInteractions > maxLogEntriesPerPeer"
- `packages/remnic-core/src/peers/profile-reasoner.ts:431` - "peerProfileReasonerMinInteractions > maxLogEntriesPerPeer, because the slice will never include enough new entries."
- `packages/remnic-core/src/peers/profile-reasoner.ts:432` - "because the slice will never include enough new entries. Read the full log first to compute the gate, then truncate"
- `packages/remnic-core/src/peers/profile-reasoner.ts:433` - "Read the full log first to compute the gate, then truncate for prompt construction below."
- `packages/remnic-core/src/peers/profile-reasoner.ts:434` - "for prompt construction below."
- `packages/remnic-core/src/peers/profile-reasoner.ts:449` - "Count interactions since the last reasoner-run marker, so dormant peers don't trigger another LLM call"
- `packages/remnic-core/src/peers/profile-reasoner.ts:450` - "dormant peers don't trigger another LLM call until enough new signal accumulates. Run markers themselves don't count."
- `packages/remnic-core/src/peers/profile-reasoner.ts:451` - "new signal accumulates. Run markers themselves don't count."
- `packages/remnic-core/src/peers/profile-reasoner.ts:468` - "Truncate ONLY for prompt construction so the LLM context stays bounded. Use the most recent maxLogPerPeer entries"
- `packages/remnic-core/src/peers/profile-reasoner.ts:469` - "stays bounded. Use the most recent maxLogPerPeer entries from the full since-last-run set"
- `packages/remnic-core/src/peers/profile-reasoner.ts:470` - "from the full since-last-run set so the prompt prefers fresh signal over older entries."
- `packages/remnic-core/src/peers/profile-reasoner.ts:471` - "signal over older entries."
- `packages/remnic-core/src/peers/profile-reasoner.ts:543` - "Build the merged profile. We never replace existing provenance entries — provenance is append-only"
- `packages/remnic-core/src/peers/profile-reasoner.ts:544` - "provenance entries — provenance is append-only so the operator retains a full audit trail."
- `packages/remnic-core/src/peers/profile-reasoner.ts:545` - "operator retains a full audit trail."
- `packages/remnic-core/src/peers/profile-reasoner.ts:561` - "Codex P1 review on PR #736: the global fieldsAppliedTotal counter must NOT be incremented until the write succeeds"
- `packages/remnic-core/src/peers/profile-reasoner.ts:562` - "counter must NOT be incremented until the profile write actually succeeds. Otherwise a transient I/O error"
- `packages/remnic-core/src/peers/profile-reasoner.ts:563` - "actually succeeds. Otherwise a transient I/O error here poisons the per-run cap for every subsequent peer"
- `packages/remnic-core/src/peers/profile-reasoner.ts:564` - "poisons the per-run cap for every subsequent peer — they get marked skipped_cap_reached for fields never persisted"
- `packages/remnic-core/src/peers/profile-reasoner.ts:565` - "marked skipped_cap_reached for fields that were never persisted. Track the candidate count locally and only"
- `packages/remnic-core/src/peers/profile-reasoner.ts:566` - "persisted. Track the candidate count locally and only commit it to the run-wide budget after writePeerProfile"
- `packages/remnic-core/src/peers/profile-reasoner.ts:567` - "commit it to the run-wide budget after writePeerProfile returns successfully (Gotcha #25 — don't destroy old state"
- `packages/remnic-core/src/peers/profile-reasoner.ts:568` - "returns successfully (Gotcha #25 — don't destroy old state before confirming new state succeeds)."
- `packages/remnic-core/src/peers/profile-reasoner.ts:569` - "before confirming new state succeeds)."
- `packages/remnic-core/src/peers/profile-reasoner.ts:574` - "Use a candidate-budget projection so we never propose more than the run-wide cap allows even before the write"
- `packages/remnic-core/src/peers/profile-reasoner.ts:575` - "than the run-wide cap allows even before we know the write will succeed."
- `packages/remnic-core/src/peers/profile-reasoner.ts:576` - "will succeed."
- `packages/remnic-core/src/peers/profile-reasoner.ts:583` - "Final defensive guard against prototype keys (parser already drops them, but be redundant for safety)."
- `packages/remnic-core/src/peers/profile-reasoner.ts:584` - "already drops them, but be redundant for safety)."
- `packages/remnic-core/src/peers/profile-reasoner.ts:593` - "Sanity-check field key matches a conservative pattern so a hostile LLM can't sneak path-traversal-shaped keys"
- `packages/remnic-core/src/peers/profile-reasoner.ts:594` - "hostile LLM can't sneak path-traversal-shaped keys through for downstream consumers."
- `packages/remnic-core/src/peers/profile-reasoner.ts:595` - "for downstream consumers."
- `packages/remnic-core/src/peers/profile-reasoner.ts:645` - "Write succeeded — NOW commit the budget. A throw above bubbles to the outer catch, where the peer is recorded"
- `packages/remnic-core/src/peers/profile-reasoner.ts:646` - "bubbles to the outer catch, where the peer is recorded as error and the global cap remains intact"
- `packages/remnic-core/src/peers/profile-reasoner.ts:647` - "error and the global cap remains intact for subsequent peers (Codex P1 fix on PR #736)."
- `packages/remnic-core/src/peers/profile-reasoner.ts:648` - "peers (Codex P1 fix on PR #736)."
- `packages/remnic-core/src/peers/profile-reasoner.ts:651` - "Append a run marker so the next reasoner pass can compute interactions since last run without a dedicated state file."
- `packages/remnic-core/src/peers/profile-reasoner.ts:652` - "interactions since last run without a dedicated state file. The marker is best-effort — a write failure here"
- `packages/remnic-core/src/peers/profile-reasoner.ts:653` - "file. The marker is best-effort — a write failure here logs but does not roll back the profile"
- `packages/remnic-core/src/peers/profile-reasoner.ts:654` - "logs but does not roll back the profile (the operator would prefer a slightly noisy threshold over a lost"
- `packages/remnic-core/src/peers/profile-reasoner.ts:655` - "would prefer a slightly noisy threshold over a lost profile update)."
- `packages/remnic-core/src/peers/profile-reasoner.ts:656` - "profile update)."
