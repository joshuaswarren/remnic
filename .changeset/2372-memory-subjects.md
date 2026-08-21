---
"@remnic/core": minor
---

memory subjects: user/agent classification, promotion guard, promotion candidates (#2372)

Adds the survey's memory-subject dimension to the core store:

- `subject` (`"user" | "agent"`) rides the sealed write envelope and lands in
  frontmatter. Write-time classification is deterministic — category defaults
  (preference/relationship/moment/commitment → `user`;
  procedure/principle/skill → `agent`; no default → `user`, the
  most-restrictive value) with an optional extractor token for fact/decision
  facts. Gated by `subjectClassification.enabled` (default off): with the gate
  off, no field is written. `subject` is fingerprint-EXEMPT — two writes
  identical except subject are the same memory for dedup.
- Uniform promotion guard (`subjectGuard`, default `"warn"`) across BOTH
  promotion surfaces: the spaces promote workflow and the scope-profile
  promotion/shared-routing paths. Promoting a `user`-subject memory — or one
  with no subject, fail closed — into a team/shared layer warns, or under
  `"enforce"` is rejected naming the `--allow-user-subject` override. The
  spaces audit trail records both warnings and the override.
- Read-only `remnic promotion-candidates` / `engram.promotion_candidates`:
  active, agent-subject, reuse-signaled memories (`reinforcement_count > 0`,
  `mw_success > mw_fail`, or `accessCount >= promotionCandidates.minAccessCount`)
  with no content-equivalent already in the target layer. Nothing is
  auto-promoted.
- Deterministic backfill (`backfillMemorySubjects`, shadow/apply, no LLM) that
  stamps only memories with no `subject` and writes through
  `writeMemoryFrontmatter`, so caches invalidate and the fact-hash index
  re-syncs.
