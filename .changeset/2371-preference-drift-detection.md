---
"@remnic/core": minor
"@remnic/cli": minor
"@remnic/plugin-openclaw": minor
---

Preference drift detection (issue #2371): the missing half of preference
maintenance. Contradiction scan and temporal supersession both need a *new
statement* to arrive; neither notices when a stored `category: preference`
memory simply stops being corroborated. That gap is what the agent-memory
survey calls stale preference reuse.

- New `runPreferenceDriftScan` in `@remnic/core`. Per active preference older
  than `driftDetection.minAgeDays`, it gathers recent same-namespace evidence
  inside a half-open `[start, end)` `lookbackDays` window and classifies:
  `corroborated` (stamps `lastCorroborated`), `stale` (stamps
  `driftState: stale`; no lifecycle change), `drifted` (opens one review item),
  or `skipped` — either `backend_unavailable` when the evidence lookup failed,
  which is deliberately NOT counted as "no evidence", or
  `verification_unavailable` when evidence exists but no judge could rule on
  it, so no claim is recorded in either direction. Shadow-first: a run without
  `apply` writes nothing, not even the run marker. Nothing is ever auto-deleted
  or auto-superseded.
- The review queue now carries a `kind`, so a drifted preference is rendered
  and resolved through the existing `review_list` / `review_resolve` surfaces
  with the verbs `keep` (confirm and stamp), `supersede` (write the corrected
  preference and retire the old one), and `archive`. Verb validity is per kind:
  a contradiction verb on a drift item, or a drift verb on a contradiction
  pair, is refused without mutating anything.
- Optional recall effects, both off by default and both applied on every recall
  branch: `driftDetection.recallDamping` multiplies the rank score of a stale
  preference by `stalePenalty` (`1` is a documented no-op), and
  `driftDetection.annotateAfterDays` appends a compact age note to an injected
  preference. With both off, recall ordering and injected text are
  byte-identical to before this change.
- New frontmatter: `driftState` and `lastCorroborated`. Like the Memory Worth
  counters, these are derived provenance stamped after a memory exists, so they
  stay outside the sealed write envelope. An unrecognized stored verdict reads
  back as absent; writing one throws.
- Surfaces: `remnic drift scan [--apply]` CLI and the
  `remnic.preference_drift_scan` MCP tool (alias
  `engram.preference_drift_scan`). Config: the `driftDetection.*` block,
  documented in `docs/config-reference.md`.
