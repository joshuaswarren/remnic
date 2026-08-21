# ADAM Memory-Extraction Baseline — April 2026

Baseline Attack Success Rate (ASR) measurements for the ADAM-style memory
extraction attack harness introduced in issue #565 PR 2 (see
`packages/bench/src/security/extraction-attack/`). Captured against the
`main` branch as of 2026-04-20 with **no mitigations** enabled. PRs 4 and 5
(cross-namespace query budget, recall-audit anomaly detection) will be
measured against this baseline.

## 1. Methodology

### 1.1 Attack loop

The harness re-implements the entropy-guided adaptive-query loop described
in *ADAM — Adaptive Data Extraction Attack* (arXiv:2604.09747, Apr 2026).
It is a clean-room implementation:

1. Seed a belief map from a small English vocabulary (`name`, `email`,
   `project`, `meeting`, `preference`, etc.) plus, for the
   `same-namespace` tier, whatever entity names the attacker observes via
   the entity side channel.
2. On each iteration compute normalized Shannon entropy over the belief
   map.
   - Low entropy (`<= entropyThreshold`, default `0.3`): exploit — query
     the highest-weight token the attacker has not tried yet.
   - High entropy: explore — pick an un-queried token from the belief map,
     falling back to the seed vocabulary.
3. Issue the chosen query against the target's recall surface.
4. Mark any hit whose tokenized content overlaps a ground-truth memory's
   salient-token set at `>= 0.5` as "recovered". Update the belief map
   (down-weight tokens already covered by recovered content; bump tokens
   that co-occur with hits).
5. Terminate when every ground-truth memory is recovered, the query budget
   is exhausted, or no un-queried candidate remains.

The attack never calls an LLM. Token "information gain" is computed from
lexical overlap, matching the paper's low-cost non-LLM variant; this is
adequate for measuring the read-path's structural leakage.

### 1.2 Fixture

The baseline target is deterministic and in-process
(`createSyntheticTarget`): it scores memories by query-token overlap and
returns the top-K hits. Every fixture memory is synthetic per the repo's
public-privacy policy.

- **15 memories in the `victim` namespace** spanning fact, preference,
  decision, and entity categories (`SYNTHETIC_MEMORIES`).
- **1 sentinel memory in the `other` namespace**
  (`OTHER_NAMESPACE_MEMORIES`) — used only in the T3 scenario below.
- Memory IDs are disclosed in hits (mirrors the current MCP recall surface
  — see threat-model §4 for the enumeration).
- The target enforces namespace ACLs when `enforceNamespaceAcl: true`,
  matching the intended behavior of the production read path.

### 1.3 Scenarios

| Scenario | Attacker tier | Entity side-channel | Namespace ACL | Seed |
|---|---|---|---|---:|
| `T1-zero-knowledge-no-entities` | T1 / zero-knowledge | none | n/a (single ns) | 101 |
| `T2-same-namespace-with-entity-sidechannel` | T2 / same-namespace | yes (5 names) | n/a | 202 |
| `T3-cross-namespace-acl-enforced` | T3 / cross-namespace | none | enforced (`allowed="other"`) | 303 |

- **T1 — zero-knowledge.** No prior information, no entity enumeration.
  The attacker can only probe the seed vocabulary.
- **T2 — same-namespace.** Models a compromised or adversarial agent on
  the user's machine that already holds a valid token and can enumerate
  entity names via `memory_entities_list`.
- **T3 — cross-namespace.** The attacker holds a valid token for a
  *different* namespace (`other`) and is trying to leak `victim`
  memories. The target enforces the namespace ACL (per threat-model
  §6.1), so direct recall should return zero `victim` hits.

Budgets are fixed at **200 queries** per scenario — well above the point at
which every tier plateaus on the 15-memory fixture. Runs are reproducible:
seeds are fixed, the PRNG is `mulberry32`, and the target is deterministic.

## 2. Results

Captured 2026-04-20 on branch `security/issue-565-pr3-adam-baseline`.
Reproduce with:

```bash
pnpm --filter @remnic/bench build
node -e "import('@remnic/bench').then(async ({ runBaseline, renderBaselineMarkdown }) => console.log(renderBaselineMarkdown(await runBaseline())))"
```

| Scenario | Attacker | Budget | Queries | ASR | Recovered | Missed |
|---|---|---:|---:|---:|---:|---:|
| `T1-zero-knowledge-no-entities` | zero-knowledge | 200 | 26 | 6.7% | 1 | 14 |
| `T2-same-namespace-with-entity-sidechannel` | same-namespace | 200 | 61 | 53.3% | 8 | 7 |
| `T3-cross-namespace-acl-enforced` | cross-namespace | 200 | 20 | 0.0% | 0 | 15 |

### 2.1 Interpretation

- **T1 (6.7%).** An un-authenticated probe that only knows generic English
  vocabulary recovers roughly one memory on this fixture within its
  budget. The single recovered memory (`mem-008` — weekly meeting
  reference) sits at the intersection of the seed vocabulary and the
  fixture's language. T1 is structurally bounded: with no entity
  side-channel and no valid token the attacker has almost nothing to
  pivot on. A larger fixture would likely push T1 higher in absolute
  count but not in rate.

- **T2 (53.3%).** The same-namespace attacker using entity enumeration
  plus adaptive querying leaks just over half of the fixture with ~60
  queries. This is the tier the hardening PRs (4 + 5) must move. The
  entity side-channel is the primary lever — every recovered memory that
  T1 missed was unlocked by a fresh entity-seeded exploit cycle.

- **T3 (0%).** With the namespace ACL enforced the cross-namespace
  attacker recovers nothing. The harness terminates early (20 queries
  issued because every candidate query returns no hits and the entropy
  exploration exhausts the seed pool quickly). This confirms the ACL
  invariant from threat-model §6.1 and provides a regression bound —
  any future change that causes cross-namespace recalls to succeed
  should show up as a non-zero ASR here.

### 2.2 What the baseline does *not* measure

- **LCM archive (`memory_lcm_search`).** The fixture is fact-shaped; the
  harness does not exercise the richer LCM read path. A follow-up
  fixture is warranted before PR 5 lands.
- **High-cardinality return disclosure.** The target's `hitCap` is 5; a
  real recall surface can return more. The anomaly detector in PR 5
  should still catch high-cardinality fan-out regardless, but the
  baseline does not stress it.
- **Real-world memory sizes.** 15 memories is enough to validate the
  harness and compare mitigations, not to extrapolate absolute ASR to a
  production namespace with thousands of memories. The T2 number should
  be read as *directionally high*, not as a production forecast.

## 3. Mitigation targets

Informs the thresholds used in PR 4 (`recallCrossNamespaceBudgetEnabled`)
and PR 5 (recall-audit anomaly detection):

| Tier | Baseline ASR | PR 4 + 5 target |
|---|---:|---:|
| T1 — zero-knowledge | 6.7% | ≤ 6.7% (already structurally bounded) |
| T2 — same-namespace | 53.3% | ≤ 20% (threat-model §6.2, first milestone) |
| T3 — cross-namespace (ACL on) | 0.0% | 0.0% (regression bound, must not regress) |

## 4. Reproducibility

Everything needed to reproduce is in-tree:

- Harness: `packages/bench/src/security/extraction-attack/runner.ts`
- Fixture: `packages/bench/src/security/extraction-attack/fixture.ts`
- Baseline runner + scenarios:
  `packages/bench/src/security/extraction-attack/baseline.ts`
- Public entry points: `runBaseline`, `renderBaselineMarkdown`,
  `DEFAULT_BASELINE_SCENARIOS` from `@remnic/bench`.

Seeds, budgets, and fixture are hard-coded so the document stays stable
across reruns. Changing any of them invalidates the comparison to the
PR 4 / PR 5 mitigated runs — record the change in the follow-up report
rather than silently rerunning.
