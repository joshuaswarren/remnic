# MemCorrect — an open correction / steerability benchmark

Issue #1584. Part of the glass-box epic (#1572). Benchmark id: `memcorrect-v1`.

## Why this benchmark exists

Prior benchmarks test only *slices* of memory correction — StateBench
(superseded-fact resurrection), STALE (arXiv:2605.06527, stale-belief
resolution), MemSyco-Bench (arXiv:2607.01071, read-time trust in memory),
MemStrata (arXiv:2606.26511, temporal supersession), and MemoryAgentBench's
FactConsolidation (correction-priority at answer time). None combines
correction uptake, adversarial non-resurrection, collateral safety, scoped
precision, write-path false-apply, and revocation in one system-agnostic
protocol. The closest recall benchmark — LongMemEval's knowledge-update
(KU) category — only checks *instantaneous answer correctness*: does the
newest fact win at answer time? The motivation is not saturation: our own
in-repo Tier-L LongMemEval run (`docs/benchmarks/results/2026-07-07-longmemeval-qwen2.5-7b-32k_latest-47aae03.json`,
full 500/500 LongMemEval-oracle, qwen2.5-7b-32k:latest (Q4_K_M), tier `local`)
scores `judge_accuracy=0.186` across all categories — far from ceiling
(its `perTaskScores` carry no `question_type`, so no KU-only figure is
derivable from it). The gap MemCorrect fills is that KU does not measure:

- how **fast** a correction takes effect,
- whether corrected facts **resurrect** after maintenance or re-ingest,
- whether corrections **damage** unrelated memories,
- whether corrections **respect scope** boundaries, or
- whether the system **falsely applies** third-party / hypothetical cues.

"The tool remembers a stale fact" is the field's #1 documented user pain,
and users' only defense today is turning memory off. MemCorrect defines the
eval that measures the correction behaviors #1580 (Correction Contract) and
#1579 (tombstones) exist to guarantee. Remnic should define this eval and
win it — that is the contribution.

## Where it lives

Inside `@remnic/bench`:

- Scenario generator — `packages/bench/src/benchmarks/remnic/memcorrect/generator.ts`
- Metric functions — `packages/bench/src/benchmarks/remnic/memcorrect/metrics.ts`
- Runner — `packages/bench/src/benchmarks/remnic/memcorrect/runner.ts`
- Adapters — `packages/bench/src/benchmarks/remnic/memcorrect/adapters.ts`
- Corpus schema — `packages/bench/src/benchmarks/remnic/memcorrect/schema.ts`
- Leaderboard row — `packages/bench/src/leaderboard-export.ts`

Registered as `memcorrect-v1` (tier `remnic`) in
`packages/bench/src/registry.ts`.

## The adapter contract (the public contribution)

MemCorrect is system-agnostic. Any memory system that implements this
interface can be scored on identical scenarios with identical metrics:

```ts
interface MemCorrectSystemAdapter {
  readonly label: string;
  reset(): Promise<void>;
  ingestTurn(sessionKey: string, role: "user" | "assistant", text: string, at: string): Promise<void>;
  recall(query: string, sessionKey: string): Promise<string[]>;
  correct(text: string, sessionKey: string, at?: string): Promise<void>;
  runMaintenance(): Promise<void>;
}
```

In-tree adapters:

1. **`PromptOnlyBaselineAdapter`** — append-everything store; BM25-style
   term-overlap recall over raw turns; `correct()` is just another turn;
   `runMaintenance()` is a no-op. The structural floor: it scores well on
   recall and terribly on `non_resurrection`-under-re-ingest (it never
   retires anything, so re-ingesting the original transcript resurrects the
   retired fact). The baseline exists so metric deltas mean something.
2. **`createRemnicMemCorrectAdapter`** — wraps the public `BenchMemoryAdapter`
   (the access-service-level abstraction) into the contract. `ingestTurn` →
   `store`; `recall` → `adapter.recall` split into ranked strings; `correct`
   → routes through the Correction Contract (plan + confirmed apply) via the
   public access-service surface, with the plain user-turn path as fallback
   (landed in PR #1862); `runMaintenance` → `adapter.drain()`.

Third-party adapters (Mem0, OpenMemory, …) are welcome follow-ups behind
the same interface. **Do not** reach into orchestrator internals — that
makes the benchmark meaningless as a comparison and brittle in-tree.

## Dataset: synthetic-only, generated, never committed

Per the repo ethics contract, no dataset files with real content are
committed. `generateMemCorrectCorpus()` is a deterministic (seeded)
synthetic corpus builder:

- **N personas × M facts** across categories
  (`fact` / `preference` / `decision` / `commitment` / `relationship`),
  each persona owning ≥2 namespaces (work + home).
- Every name, subject, and value is drawn from small **synthetic token
  pools** (`token-pools.ts`) — no real-world PII is possible by
  construction. The schema validator (`schema.ts`) enforces token-pool
  provenance for every fact token.
- Each fact is seeded via a natural **establishing transcript** (two turns)
  so systems ingest it through their normal observe path, not a backdoor.
- **Correction events** in four shapes:
  1. *explicit-targeted* — "your record that I prefer X is wrong".
  2. *conversational* — "oh by the way, we dropped X last month".
  3. *scoped* — correction valid in namespace A must not affect the
     same-text fact seeded in namespace B (carries a namespace-B twin).
  4. *re-assertion* — after a correction, the user re-asserts the original
     ("actually, we went back to X") — tests the revocation path.
- **Anti-events** (quoting-others / hypothetical / third-party-correction)
  measure false-apply, mirroring #1581's anti-fixture taxonomy.

CI runs the generator (seeded) and asserts the corpus hash is stable — the
same guard pattern the published benchmarks use. Two runs with the same
seed produce a byte-identical corpus hash and identical deterministic
metrics.

## Metrics

All eight are deterministic where possible. The LLM judge (sealed rubric,
temperature 0, #1573 cache) is reserved for paraphrase-equivalence only;
the unit-tested harness scores via token containment so a benchmark whose
scores move with judge temperature is not a benchmark. Time windows are
half-open `[start, end)` everywhere (checklist §23).

| Metric | Definition | Direction |
|---|---|---|
| `uptake_at_next` | Fraction of corrections reflected in the *first* post-correction probe (corrected content present, retired content absent). | higher |
| `uptake_latency` | Mean interaction turns until the first correct recall, capped at K. Censored (never-correct-within-cap) corrections contribute K and are counted in `uptake_latency_censored`. | lower |
| `non_resurrection` | After correction: `runMaintenance()` ×K cycles AND re-ingest of the original establishing transcript; fraction of retired facts that stay retired. | higher |
| `collateral_delta` | Recall over a fixed probe set of UNRELATED facts, before vs after corrections. Report the delta (after − before); unchanged = 0 is the target. | → 0 |
| `scope_precision` | Scoped corrections: fraction where the namespace-B twin stays intact AND the namespace-A retired fact is retired. | higher |
| `false_apply` | Anti-events that caused an undesired memory mutation (detected behaviorally: the `shouldNotAppear` token surfaces in a subsequent probe). | lower |
| `reassertion` | Re-asserted facts recallable again after the re-assertion event. | higher |
| `provenance_fidelity` | (Systems supporting it; else n/a) corrected state cites the correction event. | higher |

The metric functions are pure functions over a probe log + resolved
scenario metadata (`metrics.ts`), with hand-computed table tests
(`metrics.test.ts`). Per-task scores are emitted under `scores` (the 7
deterministic metrics); `provenance_fidelity` is n/a for adapters that do
not surface provenance and is carried in `details.metrics.memcorrect` as
`null`. The headline aggregate bundle (computed across the union of all
scenario probe logs) is attached to `config.benchmarkOptions.aggregateMetrics`.

## Running it

```bash
# Hermetic synthetic-corpus smoke (no dataset download, no GPU):
remnic bench run memcorrect-v1 --quick

# Lab run on a resolved runtime profile:
remnic bench run memcorrect-v1 --runtime-profile local-lab \
  --local-lab-manifest ~/bench/local-lab.json
```

The benchmark id is the positional `memcorrect-v1` (the registered catalog
id); `--runtime-profile` selects `baseline|real|openclaw-chain|local-lab`.
The runner selects the adapter via `benchmarkOptions.adapter` (a
`MemCorrectSystemAdapter`). When none is supplied — as is the case for CLI
runs — it wraps the bench `system` adapter via
`createRemnicMemCorrectAdapter` (the Remnic-native path), **not** the
prompt-only baseline. The hermetic `PromptOnlyBaselineAdapter` (the
structural floor deltas are measured against) is a programmatic adapter
supplied via `benchmarkOptions.adapter` in scripts and `runner.test.ts`;
there is no CLI flag that selects it. The default `--quick` corpus is
2 personas × 4 facts (8 scenarios); `--full` is 5 × 8 (40 scenarios).

## Determinism guarantees

- Same seed → byte-identical `meta.datasetHash` (SHA-256 of the canonical
  corpus JSON).
- Same seed → identical per-task deterministic metric values across runs
  (latency is non-deterministic and excluded from the equality check).
- The hermetic corpus hash is independent of the runtime profile — the
  profile only resolves providers, not the scenario corpus.

## Sanity contract (the referee, not the marketing)

Per rule 55 in spirit: **the benchmark is the referee, not the marketing**.
The prompt-only baseline must score near-zero on
`non_resurrection`-under-re-ingest (it never retires anything). Remnic
must not. If a Remnic run fails that floor, **file the bugs against
#1580/#1579 — do not tune the benchmark**.

## Submitting third-party results

1. Implement `MemCorrectSystemAdapter` for your system (see the contract
   above). `reset()` must return a clean slate; no call may touch another
   system's durable store.
2. Run `remnic bench run memcorrect-v1` with your adapter under
   `benchmarkOptions.adapter`. Submit the resulting artifact.
3. The leaderboard row (`buildMemCorrectLeaderboardRow`) carries your
   adapter label, the seed, the dataset hash, and all 8 metrics — that is
   the public submission format. Lower-is-better metrics are emitted raw;
   this doc defines the interpretation.

## Status

- PR 1 (generator + schema) — landed.
- PR 2 (runner + metrics) — landed.
- PR 3 (adapters) — baseline + Remnic-native wrapper landed. **Lab
  artifacts are not committed in this PR**: the local-lab Tier-L run
  requires the lab GPU (Jarvis), which is intentionally out of scope for
  the harness PR. Run it on the lab box and commit both artifacts per the
  issue's PR 3 acceptance.
- PR 4 (this doc + leaderboard-export wiring) — landed.
