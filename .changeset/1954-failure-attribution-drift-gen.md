---
"@remnic/bench": minor
"@remnic/cli": minor
---

feat(bench): operation-level failure attribution + drift-gen synthetic corpus (#1954)

- New `packages/bench/src/attribution.ts`: post-hoc attributor classifying each
  failed QA item's gold knowledge points into
  `extraction_miss | index_miss | retrieval_miss(filter|cap|rank|unknown) | use_miss | unattributed`
  via four independent stage checks (store scan, oracle search, recall replay
  with headroom for cap detection, injected-context use check). Backend
  failures surface as `unavailable`, never as a forced class; implied-pass
  logic lets a passing later stage prove earlier unavailable ones.
- Bench tasks gain optional `goldMemories?: string[]` (plain gold statements);
  the LoCoMo adapter derives them from dataset observation annotations keyed
  by QA evidence ids.
- New CLI subcommands (à-la-carte via `loadBenchModule()`):
  `remnic bench attribute --run <id> [--results-dir] [--memory-dir] [--threshold] [--json]`
  and `remnic bench drift-gen [validate <dir>] --users --epochs --seed --out
  [--facts-per-epoch --drifting-ratio --contradicted-ratio]`.
- New `packages/bench/src/generators/drift-gen/`: deterministic (mulberry32)
  DynamicMem-style multi-epoch corpus generator with stable/drifting/contradicted
  fact lifecycles, current/historical/transition/aggregation gold probes,
  dialogue rendering with 20+ phrasing frames per fact kind, a structural +
  statistical validator (`drift-gen validate`), and a committed canonical
  smoke snapshot at `packages/bench/src/fixtures/drift-gen-core/`.
- New `scripts/check-dataset-hygiene.mjs` + `scripts/dataset-name-denylist.txt`
  wired into the preflight gate: scans bench fixtures and research data for
  emails, key shapes, phone numbers, non-reserved IPv4s, non-allowlisted URLs,
  and denylisted names.
- Shared `packages/bench/src/seeded-random.ts` (mulberry32 + helpers) for
  generators and ablations.

Acceptance: on a 20-fact seeded corpus with deliberately injected failures of
each class, the attributor labels 20/20 correctly (threshold >= 90%); the
attribution report is deterministic; recall/extraction production code is
untouched.
