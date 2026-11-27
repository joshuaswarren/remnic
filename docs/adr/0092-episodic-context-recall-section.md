# Episodic context recall is opt-in, namespace-isolated, and fail-open per candidate

Status: accepted

## Context

Episodic-context recall queries archive/session state that may be absent, foreign, or failing; a default-on section would change recall output for everyone, and one failing session read once sank the whole fallback window. Session ids provenance-mapped across namespaces could leak another caller's sessions.

## Decision

The episodic-context recall section is strictly opt-in (`episodicContextEnabled === true`, default off) and fully disabled, including skipping any archive query, when the flag is off. Legacy scalar `source` parsing is an explicit non-goal. Only LCM session ids framed under the caller's authorized read namespaces are eligible; a foreign session's rows live under a foreign namespace frame and are unreachable. Each candidate session read fails open individually: one failing read skips that candidate, and the window is dropped only when every candidate fails. Where recall ranking uses negative examples, their penalty is capped to avoid runaway ranking distortion; the extraction anchor snapshot falls back to the same cold-aware id lookup the merge uses when a pre-existing cold-tier target has no hot path entry, so cached pre-merge bodies are not served stale.

## Consequences

Recall output is unchanged unless the operator opts in; cross-namespace session leakage is structurally impossible; partial archive failures degrade to a shorter window instead of an error. Cost: per-candidate fail-open can silently shorten a section, accepted for a best-effort context section.

## Origin comments
This theme also absorbs smaller neighbouring records that did not justify their own ADR: extraction anchor cold-tier fallback and the capped negative-example ranking penalty (both recall-section correctness guards).
- `packages/remnic-core/src/negative.ts:112` — "Cap effect to avoid runaway ranking distortion."
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:1` — "Episodic-context recall section (issue #2331, harmonic-memory P3). ... Opt-in: gated on `episodicContextEnabled === true` (default off), so flag-off"
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:66` — "Zero semantics (checklist item 33): disable before any archive query."
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:93` — "legacy scalar `source` parsing — issue non-goal)."
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:124` — "2. Authoritative LCM session ids for a provenance sessionKey"
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:125` — "(checklist item 30): only keys framed under the caller's authorized read"
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:126` — "namespaces. A foreign session's rows live under a foreign namespace"
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:127` — "frame and are unreachable through this mapping."
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:160` — "One failing session read must not sink the fallback; try the"
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:161` — "next candidate (fail-open per candidate)."
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:197` — "A failing session read skips that candidate only; the window"
- `packages/remnic-core/src/orchestration/episodic-context-section.ts:198` — "is dropped when every candidate fails (fail-open)."
- `packages/remnic-core/src/orchestration/extraction-anchor-snapshot.ts:66` — "Final round (B): a pre-existing target (e.g. cold-tier) has no"
- `packages/remnic-core/src/orchestration/extraction-anchor-snapshot.ts:67` — "pathById entry, so the derived hot path misses and the read returns"
- `packages/remnic-core/src/orchestration/extraction-anchor-snapshot.ts:68` — "null — leaving the cached pre-merge body in place. Fall back to the"
- `packages/remnic-core/src/orchestration/extraction-anchor-snapshot.ts:69` — "same cold-aware id lookup the merge itself uses."
