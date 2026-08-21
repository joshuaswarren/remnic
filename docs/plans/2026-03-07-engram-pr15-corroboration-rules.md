# Engram PR15: Corroboration Rules for Risky Promotions

## Goal

Ship the second bounded poisoning-defense slice from the roadmap by requiring
independent corroboration before risky trust-zone promotions can move
`working` records into `trusted`.

This slice implements PR15 from the benchmark-first roadmap in
[2026-03-06-engram-agentic-memory-roadmap.md](./2026-03-06-engram-agentic-memory-roadmap.md)
and builds directly on PR14's deterministic provenance trust scoring.

Relevant sources:

- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769
- AgentSys: https://arxiv.org/abs/2602.07398
- AgentLAB: https://arxiv.org/abs/2602.16901

## Why This Slice Exists

PR11 through PR14 established the trust-zone substrate:

- PR11: zone-aware storage
- PR12: explicit promotion rules
- PR13: bounded trust-zone retrieval
- PR14: deterministic provenance trust scoring

That still left a fail-open gap. A risky record with anchored provenance could
move from `working` to `trusted` based on a single source. The next bounded
defense is to require at least one independent corroborating record before that
promotion can succeed.

This keeps the rollout narrow and measurable. It does not attempt adversarial
benchmarking yet; it only makes risky promotion policy explicit and testable.

## Scope

In scope:

- Extend trust-zone promotion to require corroboration for risky
  `working -> trusted` promotions when `memoryPoisoningDefenseEnabled` is on.
- Define corroboration from stored records only:
  - different record id
  - non-`quarantine` source record
  - anchored provenance on the corroborating record
  - different provenance source class
  - overlap on `entityRefs` or `tags`
- Persist promotion metadata describing corroboration count and source classes.
- Add regression tests for:
  - missing corroboration
  - successful corroboration
  - quarantine-only candidates being ignored
- Update README, config reference, theory, and changelog.

Out of scope:

- Retrieval ranking changes based on corroboration or trust score
- Dynamic trust thresholds
- Adversarial/red-team benchmark packs
- Cross-record semantic inference beyond explicit tags/entity overlaps

## Contract

The corroboration rule must be:

- defaults-off behind `memoryPoisoningDefenseEnabled`
- limited to risky `working -> trusted` promotions
- deterministic from stored trust-zone records
- fail-closed for promotion, but fail-open for unrelated trust-zone reads
- operator-visible through promoted-record metadata

The first corroboration policy is intentionally simple:

- risky source classes: `tool_output`, `web_content`, `subagent_trace`
- corroborating records must be independent
- `quarantine` records do not count
- corroborating records must have anchored provenance
- corroboration requires explicit overlap on `entityRefs` or `tags`

## Verification

- `npx tsx --test tests/trust-zones.test.ts`
- `npm run check-types`
- `npm run check-config-contract`
- `npm test`
- `npm run build`

## Follow-on Slice

PR16 should introduce attack benchmark packs and poisoning-defense regression
coverage that exercise these corroboration rules under replay/eval conditions
instead of broadening the promotion policy further.
