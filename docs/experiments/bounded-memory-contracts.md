# Bounded Memory Contracts — Experiment

> Issue [#1708](https://github.com/joshuaswarren/remnic/issues/1708) · benchmark id: `bounded-memory-contracts`

This benchmark ablates three memory/context strategies under a controlled,
reproducible harness, plus a no-memory control:

| Condition | id | What the agent receives |
|---|---|---|
| **C0** | `no-memory` | The current task only. |
| **C1** | `raw-transcript` | The current task + prior transcript, truncated to the shared token budget. |
| **C2** | `typed-contract` | The current task + a bounded memory pack assembled from typed, scoped, citable slots. **No historical raw transcript is appended.** |
| **C3** | `typed-plus-skills` | C2 plus procedural/skill memories injected only when a trigger classifier fires. |

The thesis under test: Remnic's value is not "store more transcript" — it is
"distill trace into durable primitives, then retrieve the right primitive under
the right scope at the right time." A raw-transcript baseline is necessary
because it is the obvious thing agents do today; this benchmark shows the
quality / cost / governance tradeoff directly.

## Quick mode (offline, deterministic, no LLM)

```bash
remnic bench run bounded-memory-contracts --quick
```

Quick mode runs a 10-task smoke subset (one per family) across all four
conditions in a fully synthetic, offline, deterministic simulation. **No model
is called.** The "agent" is a pure decision procedure over the assembled memory
pack, so every run with the same seed produces byte-identical scores and
artifacts.

### Why no LLM?

The first slice (this PR) establishes the harness, the contract, the fixture,
the scoring, and the artifact tree. A deterministic offline agent lets CI
assert the differentiated outcomes without a frontier model or network. The
follow-up "full-run" slice swaps the deterministic agent for a real responder
under a condition-blinded judge.

### The deterministic agent is fair to the raw-transcript baseline

The issue's "do not make raw transcript stuffing intentionally bad" risk is
mitigated by design:

- C1 ranks candidate memories by keyword overlap, then by token length
  (longer / more repeated = more salient — a defensible heuristic).
- On **pure recall** tasks (where the needed fact is present and unambiguous),
  C1 recalls it as well as C2. The benchmark's own test pins this parity.
- C2/C3 win **governance** traps (stale, wrong-scope) because typed primitives
  carry status / scope / supersession metadata that raw transcript text does
  not — the actual thesis.

## The seven task families

| Family | What it tests | Correct behavior |
|---|---|---|
| `recall-needed` | The answer lives in an active, in-scope fact. | Recall it. |
| `stale-memory-trap` | A superseded fact + a newer correction. | Use the correction; exclude the stale fact. |
| `wrong-scope-trap` | An in-scope fact + a same-subject fact from another project. | Use the in-scope fact; exclude the cross-project one. |
| `skill-positive` | A procedural memory applies. | Use the triggered procedure. |
| `skill-negative` | A procedure looks related but a `doesNotApplyWhen` clause blocks it. | Do not inject. |
| `ask-needed` | The task lacks target/scope clarity. | Ask a clarifying question; do not act. |
| `act-when-enough` | The task has enough context. | Act; do not over-ask. |

## Metrics

Per task and per condition (full list in the runner):

- **Quality**: `task_success`, `should_ask_accuracy`, `unnecessary_clarification_rate`, `action_boundary_violation_rate`.
- **Memory behavior**: `relevant_memory_recall`, `stale_memory_harm_rate`, `wrong_scope_retrieval_rate`, `supersession_respected_rate`, `citation_coverage`.
- **Skill trigger** (C3): `skill_trigger_precision`, `skill_trigger_recall`, false-positive / false-negative rates, helped / harmed / irrelevant counts.
- **Cost/latency**: `memory_tokens_injected`, `retrieved_item_count`, `compression_ratio_vs_raw_transcript`. (No `estimated_cost_usd` — no model was called.)

## Artifacts

When `outputDir` is supplied, the runner writes:

```
conditions/<condition>/summary.json   per-condition headline bundle
prompts/<task>.<condition>.md         the assembled prompt pack
retrieval/<task>.<condition>.json     the pack + agent decision + scores
scores/per-task.csv                   one row per (task, condition)
scores/aggregate.json                 per-condition headline bundles
report.md                             human-readable comparison
```

## Safe vs unsupported claims

**Safe to claim from a quick-mode run:**

- Typed retrieval contracts (C2) exclude superseded and wrong-scope memories
  that raw transcript stuffing (C1) surfaces, *under this deterministic
  simulation*.
- Structured boundary notes are reliably surfaced by the typed contract and not
  by raw transcript, *under this simulation*.
- Typed packs are smaller than the raw transcript for the same task, under the
  shared budget.
- Skill-triggered memory (C3) can be ablated separately from generic context
  stuffing, with its own precision/recall metrics.

**NOT supported by a quick-mode run (do not claim):**

- That Remnic beats Mem0 / Zep / Letta or any other system. No cross-system
  comparison was performed.
- That these numbers generalize to real users. The fixture is small, synthetic,
  and hand-authored.
- Any frontier-model quality figures. No LLM was called.
- That skill-triggered memory helps on real procedural workloads. Two
  hand-authored skills are not evidence.

## Non-goals (this slice)

Per the issue, the first PR does **not**:

- Build the full 100+ task dataset.
- Claim leaderboard-quality results.
- Use real or de-identified traces.
- Require a frontier model.
- Reimplement the memory system inside the benchmark.

## Follow-up slices

1. Scale to the full fixture (100+ tasks) with de-identified/synthetic traces.
2. Swap the deterministic agent for a real responder under a blinded judge.
3. Add a `model-context-max` raw-transcript variant as a separate, non-primary condition.
4. Expand the skill library and report false-positive/negative rates over a larger trigger set.

## Programmatic use

```ts
import { runBenchmark } from "@remnic/bench";

const result = await runBenchmark("bounded-memory-contracts", {
  mode: "quick",
  seed: 42,
});
```

`@remnic/bench` remains an optional package — it is not imported from any base
install surface (à-la-carte package invariant).
