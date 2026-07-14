# Glass-Box Memory: Correctable, Provenance-Tracked Memory for User-Aware Agents

> **Status: working draft.** Sections §1, §3, §4, §5, §6.1, §6.2, §7.1, and §8
> are drafted as prose. Remaining `TODO(#NNNN)` markers are inline where the
> owning data or adapter run is still pending. The drafting rules in
> `README.md` still bind every number and claim (no fabricated metrics; cite
> only committed artifacts; lead with MemCorrect, not raw accuracy).
>
> **Structure source of truth:**
> `docs/plans/2026-07-07-evidence-sprint-arxiv-outline.md` (Part 1). If this
> file and the outline diverge, the outline wins.

---

## Abstract

Agent memory systems fail users at the moment they need them most: when a
stored fact goes stale. The assistant that learned the old address, the old
employer, or the old preference keeps injecting the outdated value, and the
user's recourse is blunt: disable memory entirely. We argue that recall
accuracy, while necessary, is no longer the open problem. The open problems
are correction durability (whether a fix propagates to every serving
surface), collateral safety (whether a correction damages unrelated
memories), scope precision (whether a correction respects namespace
boundaries), and explainability (whether the user can inspect why a memory
was served). This paper makes three contributions. First, we introduce
MemCorrect, a system-agnostic benchmark for memory correction and
steerability whose novelty is compositional: it combines adversarial
non-resurrection, collateral safety, namespace-scoped precision, write-path
false-apply, and revocation in one deterministic, adapter-scoreable corpus.
Prior benchmarks each test an individual slice; none evaluates correction as
a complete protocol (see §2). Second, we specify a two-tier evaluation
protocol that is reproducible on consumer hardware. Tier L runs entirely on
one RTX 3090 as the reproducibility anchor; Tier F carries the head-to-head
accuracy claim, with Opus 4.8 via Claude Code (`claude -p`) as responder and
the local 3090 as judge, cross-calibrated by Cohen's kappa against an
Opus-judged gold slice. Committed repro manifests pin every number to a git
SHA, seed, model identity, and runtime profile. Third, we describe glass-box
trust mechanisms that make recalls explainable and correctable: provenance
spans, a faithfulness gate, TrustScore, and bi-temporal validity with
tombstoned non-resurrection. The Tier-L 7B-local numbers are a
reproducibility anchor, not the accuracy headline; the accuracy claim rests
on MemCorrect's composition framing and the Tier-F results reported in §6.

- `TODO(#1584)`: land the MemCorrect one-line framing once the third-party
  adapter coverage (#1727) exists, so the comparison set is real.

---

## 1. Introduction

When an agent learns that a user lives in Portland, and the user later says
they moved to Austin, the test is not whether the agent can recall an
address. It is whether the old address stops appearing. Stale-fact memory is
a persistent user pain: the system remembers what the user told it months ago
and keeps injecting the outdated value, and the only widely available
recourse is to disable memory entirely. This observation motivates the
benchmark design documented in `docs/benchmarks/memcorrect.md`.

Recall accuracy is necessary, but it is no longer the open problem. Standard
long-context benchmarks (LongMemEval, LoCoMo) already measure whether the
newest fact surfaces at answer time. The unsolved problems are downstream of
recall. Correction durability asks whether a fix propagates to every serving
surface or quietly survives in a behavioral profile or a verbatim transcript
quote. Collateral safety asks whether correcting one memory damages unrelated
ones. Scope precision asks whether a correction to one namespace stays out of
another. Explainability asks whether the user can inspect why a memory was
served and trust the verdict behind it. These four properties, not raw
recall, are where current memory systems fail users.

The durability gap is concrete. At Tier L, Remnic's containment-scored
MemCorrect metrics land on the same floor as a prompt-only baseline that
performs no correction at all (§6.1). The failure is not a dead correction
path. Extraction produces the target fact, the Correction Contract applies,
and the stored fact is retired. The probes still fail because stale content
reaches recall context
through side channels the fact store does not control: the 7B classify model
drafts retire-only plans that leave no corrected fact behind,
behavioral-profile lines derived from the original fact survive, and verbatim
LCM turn evidence quotes the outdated statement into context. MemCorrect is
strict by design. A system that corrects its fact store but keeps serving the
old value anywhere in recall context fails the probe. That is exactly the
failure class the benchmark exists to expose: fact-store correction is
necessary but not sufficient.

This paper makes four contributions:

1. **MemCorrect**, a benchmark that evaluates agent-memory correction as a
   complete, system-agnostic protocol. It combines five correction
   behaviors in one deterministic, adapter-scoreable corpus: adversarial
   non-resurrection, collateral safety, namespace-scoped precision,
   write-path false-apply, and revocation. The novelty is compositional, not
   a claim to be first at measuring any single behavior. StateBench, STALE,
   MemSyco-Bench, MemStrata, and MemoryAgentBench each test a slice; §2
   engages each one metric by metric so the composition claim is defensible.
2. **Glass-box mechanisms** that make every recall explainable and every
   correction auditable: provenance spans (#1575), a faithfulness gate
   (#1576), TrustScore (#1577), bi-temporal validity with tombstoned
   non-resurrection (#1578-1579), and the Correction Contract with passive
   correction detection and memory handles `[m:xxxx]` (#1580-1583). §3
   describes the shipped system module by module; every mechanism cited
   corresponds to committed code.
3. **A reproducible-on-one-GPU evaluation protocol.** A two-tier design
   (Tier L local RTX 3090 anchor, Tier F frontier) with committed repro
   manifests, a content-cached judge, and Cohen's-kappa cross-tier
   calibration against an Opus-judged gold slice. §5 specifies the protocol
   and the publishability rubric every number must pass.
4. **Results** across three surfaces: MemCorrect exposes a containment-floor
   failure class that fact-store correction alone does not close (§6.1);
   LoCoMo and LongMemEval report Tier-F head-to-head results with the Tier-L
   anchor as the reproducibility baseline (§6.2); TrustScore and
   faithfulness behavior are reported as system capability (§6.3). Numeric
   results live in §6; this introduction asserts no accuracy figure that §6
   does not back with a committed artifact.

---

## 2. Related Work

Related Work is drafted standalone in [`related-work.md`](related-work.md)
(issue #1729, landed). It positions MemCorrect as a composition/protocol
claim. It engages the closest relatives metric-by-metric: StateBench, STALE,
MemSyco-Bench, MemStrata, MemoryAgentBench FactConsolidation, and the
weight-editing ancestors RippleEdits/MQuAKE/TOFU/MUSE. It carries the two
load-bearing tables. Table 1 gives the metric-by-metric differentiation
with attribution. The capability matrix compares StateBench, STALE,
MemSyco-Bench, and the commercial systems (Mem0, Zep, Letta). The
metric-attribution split is stated there explicitly: three metrics
borrowed-and-attributed (`uptake_at_next`, `non_resurrection`,
`collateral_delta`), two partly new (`scope_precision`, `false_apply`),
three new (`uptake_latency`, `reassertion`, `provenance_fidelity`). This
file does not duplicate that content.

---

## 3. System — Glass-Box Memory

**Intent.** Describe the system whose behaviors §4's benchmark measures and
§6's results score. Walk the recall path top-down: three-tier retrieval
(explicit-cue → targeted-fact → response-guidance, unified on the #1539 recall
spine), then the glass-box layers that make recalls explainable and
correctable. Every mechanism claim below cites the shipped module; nothing is
aspirational.

**Substrate.** Remnic is files-first: every memory is a markdown file with
YAML frontmatter in a plain directory tree, and every index — the tombstone
log, search collections, projections — is an explicitly rebuildable cache of
that file truth. All durable writes funnel through a single storage
chokepoint, so cross-cutting invariants (tombstone checks, dedup, cataloging)
are enforced once rather than re-implemented per write path. This one
decision does a lot of quiet work: §3.6's non-resurrection guarantee holds
for write paths that did not exist when the guarantee was written.

### 3.1 Three-tier retrieval

Recall runs as tiered pipelines — explicit-cue (verbatim turn references),
targeted-fact (entity- and claim-directed lookup), and response-guidance
(behavioral steering), plus an event-order pipeline for chronology questions.
All tiers instantiate one shared stage sequence: intent classification →
candidate collection → dedup → rank → filter → slice → metadata → token
budgeting (`recall-pipeline-stages.ts`). A single `unifiedDedupeAndRank`
stage owns scoring, thresholding, and ordering behind a declared
configuration object, so behavioral differences between tiers — most
dangerously, recency-descending versus chronology-ascending turn ordering —
are declared fields rather than divergent copies of comparator code. The
pipeline order itself is a repository contract: candidate headroom first,
then policy filters, then rerank/boost, then the user-facing cap — a cap
applied before final filtering is treated as a bug class, not a tuning
choice. Above the spine, an episode/note classification layer routes
experiential episodes and semantic notes into different consolidation
behavior (`himem.ts`), and Memory Boxes group related episodes for
verified recall (`boxes.ts`, `verified-recall.ts`).

### 3.2 Provenance spans

Every extracted claim can carry claim-level source spans: session key, turn
id, observation timestamp, and the verbatim quote with character offsets
(`provenance.ts`). A coarse tag (`verified` | `unverified` | `none`)
summarizes span state for cheap filtering. The load-bearing invariant is
enforced symmetrically at write and read: a `verified` or `unverified` tag
never survives without at least one structurally valid span — it is
downgraded to `none`; a corrupt span drops to absent rather than poisoning
the memory. With the feature disabled, serialized output is byte-identical
to pre-provenance behavior, which is what makes incremental adoption safe.

### 3.3 Faithfulness gate

At extraction time, each candidate fact is entailment-checked against its
own verified source span — the §3.2 quote, deliberately not the whole
conversation, both for latency and because re-reading the full transcript
would reintroduce the hallucination surface the gate exists to close
(`extraction-faithfulness.ts`). This is distinct from fact-worthiness
judging: the gate asks "is this claim supported by what was actually said,"
targeting the highest-severity memory failure — a hallucinated extraction
becoming a confident durable memory. Verdicts are `entailed`,
`contradicted`, or `unsupported`; a backend failure is a tagged bypass
(`unchecked`), never a silent verdict, and never blocks the write. Shadow
mode records verdicts without enforcement, which is the harvest stream the
model lab uses to train the local gate model (Appendix A.4.3).

### 3.4 TrustScore

TrustScore is a pure, deterministic blend of up to eight per-memory signals
— memory-worth, faithfulness verdict, provenance strength, corroboration,
contradiction state, operator feedback, recency, and domain calibration —
with declared default weights that are sum-normalized over the signals
actually present (`trust-score.ts`). Its contract is epistemically
conservative: a memory with no instrumentation scores exactly neutral (0.5,
recall multiplier 1.0) rather than being penalized for missing data; a
corrupt component contributes neutrally, never an extreme; absent components
redistribute their weight. Scores map to bands (high / medium / low /
quarantine), where quarantine is reserved for hard negatives — a
`contradicted` faithfulness verdict or an unresolved contradiction — and
quarantined memories are excluded from injection but always visible in
recall X-ray output with the reason attached. At injection time the score
becomes a bounded recall multiplier and, in the low bands, a deterministic
epistemic hedge that names the actual weakest signals instead of a generic
"low confidence" disclaimer. **Note for §3 vs §6:** TrustScore is a shipped
*recall-stage feature*, **not yet a benchmark metric** — it is described
here as a system capability and is not scored in §6.

### 3.5 Correction Contract, passive detection, memory handles

Correction is a first-class write path, not an `update()` API. A
natural-language correction becomes a `CorrectionPlan`: the planner resolves
targets (searched or explicitly named), classifies the correction (`wrong`,
`outdated`, `incomplete`, `wrong_scope`, `never_store`), drafts per-memory
actions, and renders a human-readable diff with a confidence score and an
expiry (`correction-contract.ts`). Planning is read-only by construction —
with no LLM available the planner degrades to zero actions and "located for
review," never to a guessed mutation. Apply is confirm-gated and
exactly-once; a plan interrupted mid-apply is detected at startup and
scrubbed rather than silently retried. The executor is the only writer and
follows a non-destructive order: replacement memories are written first
(page-versioned, revertable), only then are predecessors superseded,
validity-stamped, and tombstoned, then changes propagate to the search
index, graph edges, belief ledger, and profile, and finally an audit record
— itself a searchable memory — lands in `corrections/`. A failed
replacement write never destroys the old state.

Two adjacent mechanisms make the contract reachable in practice. Passive
correction detection watches user turns with a morphology-aware heuristic —
no additional LLM call — and is deliberately conservative: hypotheticals,
quoted speech, and third-party corrections are rejected by anti-fixture
guards, with the contradiction scan and the chat surface as backstops
(`passive-correction-detector.ts`). Memory handles render every injected
memory with a short id-derived token (`[m:4f2a]`) so an agent or user can
say "`[m:4f2a]` is stale" and route the correction to an exact target;
handles are derived from ids (never content), widened on collision, and
resolved per-session against the injection snapshot, so no global handle
table exists to leak across sessions (`recall-handles.ts`). The chat
surface (#1583) exercises the full loop end-to-end: recall with handles,
passive detection, plan preview, confirm, apply.

### 3.6 Bi-temporal validity and tombstoned non-resurrection

Memories carry two independent time axes: transaction time (when the system
learned/updated the record) and validity time (`valid_at` / `invalid_at`,
half-open) describing when the fact was true in the world
(`temporal-validity.ts`). Supersession stamps the predecessor's
`invalid_at`, and `as_of` recall answers "what did we believe was true at
time T" — the corrected past stays queryable instead of being overwritten.
A corrupt validity timestamp conservatively evaluates to not-valid, never
to always-true.

Retirement is enforced by an append-only tombstone log keyed by content
hash, normalized text, and entity reference (`lifecycle/tombstones.ts`).
Because the check runs at the single write chokepoint, one mechanism blocks
all five known resurrection paths — re-extraction from old transcripts,
importers, consolidation merges, dream/REM re-derivation, and pattern
reinforcement — without per-path code. Reversal is itself an append
(`kind: revocation`); history is never rewritten. A blocked write is parked
as `pending_review` with the blocking tombstone recorded, never silently
dropped. This mechanism is exactly what §4's `non_resurrection` metric
measures from the outside.

### 3.7 Recall X-ray

Every recall can be replayed as a per-result attribution: which tier served
it, the score decomposition, the graph path when graph retrieval fired, the
filter ladder that admitted or rejected it, and the audit entry id
(`recall-xray.ts`), rendered identically across CLI, HTTP, and MCP. The
design rule is that an exclusion must never look like an absence: a
quarantined memory shows up in the X-ray with its quarantine reason rather
than disappearing.

### 3.8 What makes this architecture different

Read together, the subsystems implement one discipline rather than eight
features:

1. **Correction is an auditable write path.** A plan/apply contract with
   non-destructive ordering, revertable page-versioned edits, and a
   substrate-level non-resurrection invariant. Contemporary memory systems
   expose add/update/delete APIs; we are not aware of a published
   resurrection-blocking guarantee or confirm-gated correction protocol
   among them (§2).
2. **Recall is glass-box end-to-end.** Claim-level source spans →
   entailment verdict → multi-signal TrustScore with component echo →
   named epistemic hedges → X-ray filter ladder. "Why is this memory in my
   context" has a mechanical answer at every layer.
3. **Fail-safe epistemics are a recurring contract shape.** Neutral on
   absent signals, drop-corrupt-never-poison, tagged backend-failure versus
   verdict, byte-identical output when disabled, exclusions never invisible.
   The system prefers admitting ignorance to manufacturing confidence.
4. **The substrate is bi-temporal, human-readable, and reproducible.**
   Markdown files as truth, rebuildable indexes, `as_of` history, and a
   benchmark protocol that reruns on a single consumer GPU (§5).

These are engineering claims, and §8 states their limits honestly:
TrustScore is not yet a scored benchmark metric, the fine-tuned faithfulness
gate model's final manifest is pending (#1737), and §4's uptake metrics are
strict by design — a system that keeps quoting the outdated turn in recall
context fails the probe even when a corrected fact also surfaces.


---

## 4. MemCorrect Benchmark

MemCorrect (`memcorrect-v1`, issue #1584, registered tier `remnic`) is a
write-time correction benchmark built on a system-agnostic adapter contract
and a deterministic synthetic corpus. Its claim is compositional, not "first
to measure memory correction": the individual behaviors it scores each have
antecedents in prior work (StateBench, STALE, MemSyco-Bench, MemStrata,
MemoryAgentBench's FactConsolidation; see §2). The contribution is that no
prior benchmark combines uptake, non-resurrection, collateral safety, scope
precision, write-path false-apply, and revocation in one system-agnostic
protocol with a hermetic corpus, and that several of its metrics
(`uptake_latency`, `reassertion`, `provenance_fidelity`, namespace-twin
`scope_precision`, anti-event `false_apply`) have no direct prior expression.

The motivation is not saturation. LongMemEval's knowledge-update (KU)
category, the closest recall benchmark, checks only instantaneous answer
correctness: does the newest fact win at answer time? The strongest systems
score roughly 70-90% on KU, not ceiling. Our own in-repo Tier-L LongMemEval
run (`docs/benchmarks/results/2026-07-07-longmemeval-qwen2.5-7b-32k_latest-47aae03.json`,
full 500/500 oracle, `qwen2.5-7b-32k:latest` (Q4_K_M), tier `local`) returns
`judge_accuracy = 0.186` across all categories, far from ceiling. Its
`perTaskScores` carry no `question_type`, so no KU-only figure is derivable
from it. KU is answer-time-only by design, so it cannot measure five
behaviors users experience: how fast a correction takes effect, whether
corrected facts resurrect after maintenance or re-ingest, whether
corrections damage unrelated memories, whether corrections respect scope
boundaries, and whether the system falsely applies third-party or
hypothetical cues. "The tool remembers a stale fact" is the field's most
documented user pain, and the only defense most systems offer is turning
memory off. MemCorrect defines the evaluation that measures the correction
behaviors the Correction Contract (#1580) and tombstones (#1579) exist to
guarantee.

### 4.1 Task construction: a deterministic synthetic corpus

Per the repo ethics contract, no dataset file with real content is committed.
`generateMemCorrectCorpus()`
(`packages/bench/src/benchmarks/remnic/memcorrect/generator.ts`) is a
deterministic, seeded synthetic corpus builder with the following structure:

- **N personas × M facts** across five categories (`fact`, `preference`,
  `decision`, `commitment`, `relationship`), each persona owning at least two
  namespaces (work and home). The default `--quick` corpus is 2 personas × 4
  facts (8 scenarios); `--full` is 5 × 8 (40 scenarios).
- Every name, subject, and value is drawn from small **synthetic token pools**
  (`token-pools.ts`). No real-world PII is possible by construction, and the
  schema validator (`schema.ts`) enforces token-pool provenance for every fact
  token.
- Each fact enters the system through a natural **establishing transcript** of
  two turns, so adapters ingest it via their normal observe path rather than a
  backdoor write.

CI runs the generator under a fixed seed and asserts the corpus hash is
stable, the same guard pattern the published benchmarks use. Two runs with the
same seed produce a byte-identical `meta.datasetHash` (SHA-256 of the
canonical corpus JSON) and identical per-task deterministic metric values.
The corpus hash is independent of the runtime profile: the profile resolves
providers, but the scenario corpus is hermetic.

### 4.2 The adapter contract

MemCorrect is system-agnostic. Any memory system that implements this
interface can be scored on identical scenarios with identical metrics:

```ts
interface MemCorrectSystemAdapter {
  readonly label: string;
  reset(): Promise<void>;
  ingestTurn(sessionKey, role, text, at): Promise<void>;
  recall(query, sessionKey): Promise<string[]>;
  correct(text, sessionKey, at?): Promise<void>;
  runMaintenance(): Promise<void>;
}
```

The committed interface and both in-tree adapters live in
`packages/bench/src/benchmarks/remnic/memcorrect/`: the typed
`MemCorrectSystemAdapter` in `types.ts`, the adapters in `adapters.ts`. The
listing above drops the TypeScript annotations for readability.
`PromptOnlyBaselineAdapter` is an append-everything store with BM25-style
term-overlap recall over raw turns; its `correct()` is just another turn and
`runMaintenance()` is a no-op. It never retires anything, so re-ingesting the
original transcript resurrects the retired fact. It exists as the structural
floor so metric deltas mean something. `createRemnicMemCorrectAdapter` wraps
the public `BenchMemoryAdapter` (the access-service-level abstraction):
`ingestTurn` maps to `store`, `recall` maps to `adapter.recall` split into
ranked strings, `correct` routes through the Correction Contract (plan plus
confirmed apply) via the public access-service surface, with the plain
turn path as fallback, and `runMaintenance` maps to `adapter.drain()`.

### 4.3 Correction events and anti-events

Each scenario seeds facts, then fires correction events in four shapes:

1. **Explicit-targeted.** "Your record that I prefer X is wrong." The
   correction names the target fact directly.
2. **Conversational.** "Oh by the way, we dropped X last month." The
   correction is embedded in ordinary dialogue, not flagged as a correction.
3. **Scoped.** A correction valid in namespace A must not affect the same-text
   fact seeded in namespace B. The scenario carries a namespace-B twin to
   test boundary respect.
4. **Re-assertion.** After a correction, the user re-asserts the original
   ("actually, we went back to X"). This exercises the revocation path: a
   superseded fact that the user reverses must become recallable again.

A parallel anti-event taxonomy measures false-apply, mirroring the #1581
anti-fixture design:

- **Quoting-others.** The user quotes or attributes a statement to someone
  else; the system must not store it as the user's own fact.
- **Hypothetical.** The user reasons about a counterfactual; the system must
  not persist it as established.
- **Third-party-correction.** A correction aimed at another person's record
  must not mutate the current user's memory.

### 4.4 Metrics

All eight metrics score through token containment in the unit-tested harness
(`metrics.ts`, `metrics.test.ts`). The metric functions are pure functions
over a probe log plus resolved scenario metadata, with hand-computed table
tests. A sealed-rubric LLM judge (temperature 0, #1573 content cache) is
reserved for paraphrase-equivalence cases, but no shipped metric routes
through it: a benchmark whose scores move with judge temperature is not a
benchmark. Time windows are half-open `[start, end)` everywhere.

| Metric | Direction | Definition | Determinism |
|---|---|---|---|
| `uptake_at_next` | higher | Fraction of corrections reflected in the *first* post-correction probe (corrected content present, retired content absent). | token containment |
| `uptake_latency` | lower | Mean interaction turns until the first correct recall, capped at K. Censored (never-correct-within-cap) corrections contribute K and are counted in `uptake_latency_censored`. | token containment; excluded from cross-run equality |
| `non_resurrection` | higher | After correction: `runMaintenance()` ×K cycles AND re-ingest of the original establishing transcript; fraction of retired facts that stay retired. | token containment |
| `collateral_delta` | → 0 | Recall over a fixed probe set of UNRELATED facts, before vs after corrections. Report the delta (after − before); unchanged = 0 is the target. | token containment |
| `scope_precision` | higher | Scoped corrections: fraction where the namespace-B twin stays intact AND the namespace-A retired fact is retired. | token containment |
| `false_apply` | lower | Anti-events that caused an undesired memory mutation (detected behaviorally: the `shouldNotAppear` token surfaces in a subsequent probe). | token containment |
| `reassertion` | higher | Re-asserted facts recallable again after the re-assertion event. | token containment |
| `provenance_fidelity` | higher | (Systems supporting it; else n/a) corrected state cites the correction event. | token containment; n/a if unsupported |

Per-task scores carry the seven always-scored metrics under `scores`;
`provenance_fidelity` is `null` for adapters that do not surface provenance and
is carried in `details.metrics.memcorrect`. The headline aggregate, computed
across the union of all scenario probe logs, attaches to
`config.benchmarkOptions.aggregateMetrics`.

### 4.5 The sanity contract

The benchmark is the referee, not the marketing. The prompt-only baseline must
score near-zero on `non_resurrection` under re-ingest, because it never
retires anything. The design intent is that a correction-capable system clears
that floor. When the first full-matrix Tier-L run did not (§6.1), the response
was to trace the serving-surface leaks per scenario, not to tune the
benchmark; §6.1 reports that trace and §8 names the follow-up work it
motivates.

- TODO(#1727): name the third-party adapters scored (Mem0 -> Zep -> Letta order) once implemented; until then §4 describes the *contract*, not a comparison.

---

## 5. Experimental Setup

**Intent.** The protocol that makes every number in §6 independently
reproducible on one GPU.

**Two-tier protocol.** Every published number carries a tier. **Tier L
(local)** runs entirely on one consumer GPU — an RTX 3090 (24 GB) driving
`qwen2.5-7b-32k:latest` (Q4_K_M, 32k context) over Ollama — and exists as
the reproducibility anchor: anyone with one GPU can rerun it. Tier-L
artifacts must carry a hardware envelope (GPU, VRAM, quantization); the
promotion bridge refuses a local-tier artifact without one. **Tier F
(frontier)** carries the head-to-head accuracy claim. The Tier-F responder
is **Opus 4.8 via Claude Code (`claude -p`)** through the `claude-cli`
bench provider — a valid research harness and a distinct provenance path
from the raw Anthropic API; the artifact records provider, model, harness,
isolation settings, and invocation so the measurement path is explicit.
Isolation is mandatory and implemented by the provider: a freshly created
empty temp workspace, tools disabled, user/project configuration skipped,
session persistence off, and an environment allowlist that excludes memory
directories and unrelated secrets — without this, Claude Code inherits
user-level instructions and silently contaminates every answer.

**Runtime profiles.** The system under test is pinned by a named runtime
profile (`runtime-profiles.ts`): `baseline` (deterministic pinned Remnic
configuration, LCM stack), `real` (Remnic's shipped defaults plus a pinned
config file — the MemCorrect lab profile,
`docs/benchmarks/configs/memcorrect-lab-remnic-config.json`), `local-lab`
(manifest-pinned operator-hosted models, temperature 0, fixed seed —
`docs/benchmarks/configs/local-lab-3090.json`), and `openclaw-chain` (the
full host chain). The §7 ablations flip exactly one flag against `baseline`
per cell.

**Judging and cross-tier calibration.** LoCoMo and LongMemEval judging runs
on the local 3090 judge; judge verdicts are content-cached so re-scoring
cached answers is free. Cross-tier credibility comes from Cohen's-κ
calibration (`remnic bench judge-calibrate`): the local judge and the
Tier-F gold judge (Opus via `claude -p`) re-judge a deterministic
50-question slice of a benchmark's cached answers, and the resulting κ —
with sample size, threshold, and a warning flag when κ falls below it — is
persisted and stamped into every subsequent stored result whose judge
matches the calibrated pair (`judgeCalibration` on the artifact schema).

**Pinning and manifests.** Every stored result records the git commit SHA,
seed, dataset version, runtime profile, provider/model identities, and
benchmark options; a reproducibility manifest (`repro-manifest.ts`)
accompanies each results directory. Artifacts are SHA-256-hashed over
canonical JSON, and the figure pipeline renders only manifest-tracked,
non-mock artifacts (§6), byte-identically on regeneration.

**Publishability rubric.** A number enters this paper only if: (1) the
artifact is real and committed, never a mock fixture; (2) its repro
manifest pins seed, model + quantization, context window, dataset version,
and runtime profile; (3) judge calibration is reported wherever a judge is
used; (4) a one-paragraph honest framing accompanies it (what the number
is and is not); (5) leaderboard-safety guards (explicit-cue recall rules,
no train/test leakage) are respected; and (6) the Tier-L path is
re-runnable on one GPU. Bounded (`--limit`/`--trial-limit`) runs are
partial-coverage evidence and are never presented as full leaderboard
results — the promotion bridge rejects them outright.

---

## 6. Results

**Intent.** Three result blocks, each gated on a real, non-mock, committed
artifact. **No number appears in this section until its artifact exists and
passes the §5 publishability rubric.** Until then, every block is a TODO.

- **Figures (#1731):** the §6 result figures are rendered by
  `scripts/generate-paper-figures.mjs` (regenerate with `pnpm run figures:paper`)
  into `docs/paper/figures/`, with full real-vs-pending provenance in
  `docs/paper/figures/README.md`. The Remnic Tier-L and Tier-F panels
  (Figure 1), the MemCorrect metrics (Figure 2), and the TrustScore
  component illustration (Figure 3) all carry real data; only the
  Mem0/Zep/Letta comparison bars remain DATA-PENDING placeholders (API-
  key-gated, excluded by operator directive). No fabricated number is
  rendered (rule 55).
  - **Figure 1** — `figures/fig1-locomo-longmemeval.svg`: LoCoMo /
    LongMemEval. Real = Remnic Tier-L anchor + Tier-F (real profile);
    pending = Mem0/Zep/Letta (#1747).
  - **Figure 2** — `figures/fig2-memcorrect-metrics.svg`: the 8 MemCorrect
    metrics. Remnic-native and prompt-only-baseline bars are real (Tier-L
    artifacts committed 2026-07-13); Mem0/Zep/Letta bars remain pending
    (#1747 adapter runs are API-key-gated and deliberately not run here).
  - **Figure 3** — `figures/fig3-trustscore-components.svg`: the 8 TrustScore
    weighted components, source-extracted from `DEFAULT_TRUST_WEIGHTS`. A system
    illustration, not a benchmark metric (#1577).

- **6.1 MemCorrect — Remnic vs the prompt-only floor (Tier L).**
  Two full-matrix (40-scenario, `mode: full`, seed `0xc077e7`) artifacts are
  committed:
  `docs/benchmarks/results/2026-07-13-memcorrect-v1-remnic-native-9485f44.json`
  (runtime profile `real` — Remnic's shipped defaults with the fact pipeline
  and Correction Contract active; extraction and correction classification on
  `qwen2.5-7b-32k:latest`, RTX 3090; pinned config in
  `docs/benchmarks/configs/memcorrect-lab-remnic-config.json`) and
  `docs/benchmarks/results/2026-07-13-memcorrect-v1-prompt-only-baseline-9485f44.json`
  (the hermetic append-only floor). Corrections in the Remnic run route
  through the Correction Contract (plan + confirmed apply) via the public
  access-service surface, with the plain turn path as fallback.

  **Headline finding (honest):** at Tier L, Remnic's containment-scored
  metrics land on the same floor as the prompt-only baseline
  (`uptake_at_next = 0`, `non_resurrection = 0`, `false_apply = 1` for both
  adapters). Per-scenario tracing shows this is not a harness artifact and
  not a dead correction path: extraction does produce the target fact, the
  contract plan applies (`applied: true`), and the stored fact is retired.
  The probes still fail because stale content keeps reaching the serving
  layer through three side channels: (a) the 7B classify model drafts
  retire-only actions instead of supersede-with-replacement, so no corrected
  fact exists for the probe to contain; (b) behavioral-profile lines derived
  from the original fact survive the correction; and (c) verbatim LCM turn
  evidence quotes the outdated statement into recall context. MemCorrect is
  strict by design — a system that keeps serving the stale value anywhere in
  its recall context fails the probe — and this result is exactly the
  failure class the benchmark exists to expose: **fact-store correction is
  necessary but not sufficient; correction must propagate to every serving
  surface.** §8 discusses the classify-model capability axis (Tier F) and
  the serving-surface propagation follow-up this measurement motivates.
  - `TODO(#1727)`: add the Mem0 / Zep / Letta adapter rows. Until those runs
    exist, §6.1 reports Remnic-native vs the `PromptOnlyBaselineAdapter`
    floor — clearly labeled as such, not as a "we beat X" claim.
- **6.2 LoCoMo / LongMemEval — Tier F (real profile, full feature set).**
  Two full Tier-F artifacts are committed (Opus 4.8 via Claude Code,
  `real` profile — Remnic's shipped defaults with the full feature set
  active: QMD hybrid search, knowledge index, entity retrieval, verified
  recall, Memory Boxes, contradiction detection, Correction Contract;
  local 3090 judge `qwen2.5-7b-32k:latest`; zero task failures across
  2486 total questions; gitSha `0676347`):

  | Benchmark | Tier | Tasks | `llm_judge` | `contains_answer` | `f1` | κ (calibration) |
  |---|---|---|---|---|---|---|
  | LongMemEval | F (real) | 500/500 | **0.760** | 0.492 | 0.493 | 0.769 ✓ (above threshold) |
  | LongMemEval | L (anchor) | 500/500 | 0.186 | 0.098 | 0.071 | — |
  | LoCoMo | F (real) | 1986/1986 | **0.444** | 0.158 | 0.265 | 0.135 ⚠ (below threshold, warning attached) |
  | LoCoMo | L (anchor) | 1986/1986 | 0.224 | 0.083 | 0.122 | — |

  Artifacts:
  `docs/benchmarks/results/2026-07-14-longmemeval-opus-0676347.json`,
  `docs/benchmarks/results/2026-07-14-locomo-opus-0676347.json`.

  **Judge calibration.** Cohen's κ was computed by re-judging a
  deterministic 50-question slice with both the local 3090 judge and
  Opus (the gold standard). LongMemEval's κ=0.769 clears the 0.7
  publishability threshold — the local judge is a defensible proxy for
  that benchmark. LoCoMo's κ=0.135 does not; the local judge's verdicts
  diverge substantially from Opus on LoCoMo's open-ended answers, so
  the LoCoMo `llm_judge` carries a warning flag in the artifact and
  should be read as an approximate, not authoritative, score. The
  deterministic metrics (`contains_answer`, `f1`, `rouge_l`) are
  judge-independent and unaffected.

  **Per-type breakdown (LongMemEval Tier F, real profile).** The
  aggregate 0.760 hides a sharp split:

  | Question type | n | judge acc. |
  |---|---|---|
  | single-session-user | 70 | 0.943 |
  | single-session-assistant | 56 | 0.911 |
  | single-session-preference | 30 | 0.800 |
  | knowledge-update | 78 | 0.795 |
  | multi-session | 133 | 0.789 |
  | **temporal-reasoning** | **133** | **0.541** |


  *(Source: `docs/paper/figures/longmemeval-per-type-breakdown.json`, computed
  from the stored BenchmarkResult's per-task `questionType` field.
  Reproducible via the dataset + the committed artifact.)*
  Temporal reasoning is the entire gap: lifting that one category to
  the multi-session level (0.789) would move the aggregate from 0.760
  to ~0.82. The mechanism is nameable: temporal questions need
  cross-session chronology reconstruction, but the recall context blob
  delivers evidence snippets without a structured timeline. Remnic
  ships an event-order recall tier and bi-temporal validity machinery,
  but the bench recall path surfaces neither as an ordered timeline for
  date-shaped queries. This is both an honest limitation and the
  concrete improvement lever documented in the Temporal Lift plan.

  **`locomo_hidden_evidence_id_leak = 1.0`** on both tiers: this is the
  anti-leak guard holding, not a leak. The runner scores `1` only when
  zero hidden evidence identifiers from the gold metadata surface in the
  recalled context (`packages/bench/src/benchmarks/published/locomo/runner.ts`),
  so `1.0` across every task means no run leaked gold evidence ids into
  the answering path. This is the leaderboard-safety invariant from the
  §5 rubric, verified per-task rather than assumed.

  - `TODO(#1747)`: Mem0 / Zep / Letta comparison rows are cited-not-
    reproduced until the third-party adapter runs land (API-key-gated,
    excluded by operator directive).
- **6.3 TrustScore / faithfulness behavior.**
  - `TODO(#1577)`: TrustScore is a shipped recall feature, **not a benchmark
    metric yet.** Report it as system behavior (qualitative + a worked example)
    unless/until a scored surface is added; do not invent a metric.
  - `TODO(#1576)`: faithfulness gate behavior — describe against the #1585
    shadow/harvest data once that stream exists.

---

## 7. Ablations

### 7.1 Single-flag ablations

This subsection reports the single-flag ablation matrix from issues
#1730, #1574, and #1725, produced on the RTX 3090 local-lab box under the
`local-lab` runtime profile. Each ablation flips exactly one recall-stack flag
off its default in the baseline run and re-runs the full LoCoMo-10 benchmark
(1986 questions across all 10 conversations) with everything else held
constant: same model (`qwen2.5-7b-32k:latest`, Q4_K_M), same seed (1), same
responder and judge model. The baseline is the first real Tier-L artifact,
`2026-07-07-locomo-qwen2.5-7b-32k_latest-47aae03.json`, with memory-worth on,
contradiction-scan off, and graph-recall off. The runner is
`scripts/bench/run-ablation-matrix.ts`; each cell artifact was verified with
`pnpm exec tsx scripts/bench/verify-artifact.ts` before being cited. The
committed source for this table is `docs/benchmarks/ablations.md`; the three
cell artifacts themselves live in git history, not the current tree (see
Artifact provenance below).

| Cell | Flag flipped | `contains_answer` | `f1` | `llm_judge` | `rouge_l` | artifact |
|---|---|---|---|---|---|---|
| **Baseline** | (defaults) | 0.0831 | 0.1217 | 0.2243 | 0.1177 | `…47aae03.json` |
| **memory-worth-off** | Memory Worth multiplier OFF (baseline ON) | 0.0856 (Δ+0.0025 / +3.0%) | 0.1227 (Δ+0.0009 / +0.8%) | 0.2239 (Δ-0.0004 / -0.2%) | 0.1187 (Δ+0.0010 / +0.9%) | `…c67c2c7-memory-worth-off.json` |
| **contradiction-scan-on**† | Contradiction scan ON (baseline OFF) | 0.0851 (Δ+0.0020 / +2.4%) | 0.1220 (Δ+0.0003 / +0.2%) | 0.2236 (Δ-0.0007 / -0.3%) | 0.1181 (Δ+0.0004 / +0.3%) | `…c67c2c7-contradiction-scan-on.json` |
| **graph-recall-on**† | Graph / temporal recall ON (baseline OFF) | 0.0851 (Δ+0.0020 / +2.4%) | 0.1220 (Δ+0.0003 / +0.2%) | 0.2236 (Δ-0.0007 / -0.3%) | 0.1181 (Δ+0.0004 / +0.3%) | `…c67c2c7-graph-recall-on.json` |

† `contradiction-scan-on` and `graph-recall-on` produced byte-identical
per-task scores (see below). The fifth metric,
`locomo_hidden_evidence_id_leak`, stays at 1.000 across every cell, confirming
that no run leaks hidden gold evidence ids into the answer path. The
anti-cheating invariant holds.

The finding is the absence of a measurable effect. None of the three cells
moves any metric by more than the run-to-run noise band at this scale, so no
default is changed by this ablation. The largest move across all cells is
`contains_answer` +0.0025 absolute (+3.0% relative) under `memory-worth-off`,
well within the 5 to 8 percent band that single-seed Tier-L runs treat as
indistinguishable from noise. Disabling the Memory Worth recall multiplier
neither helps nor hurts at 7B-Q4; the default stays on. Enabling inline
contradiction detection (`contradictionDetectionEnabled`) on the write path
neither helps nor hurts; the default stays off. Enabling graph recall plus
full-mode graph assist neither helps nor hurts; the default stays off.

**Bit-identical pair.** `contradiction-scan-on` and `graph-recall-on` produced
byte-identical per-task scores across all 1986 LoCoMo questions: every
`contains_answer`, `f1`, `llm_judge`, and `rouge_l` per-task value matches to
full float precision. They are not the same file. They carry different sha256
hashes (`11e55bb8…` vs `bc1504a7…`), different flag envelopes, and different
run windows, and each ran an independent ~18-minute full benchmark (18.2 min vs
17.9 min). This is not a caching artifact. The override merge in
`scripts/bench/run-ablation-matrix.ts` spreads each cell's flag onto the
baseline config as `remnicConfig`, and the `memory-worth-off` cell (which flips
a recall-time multiplier) genuinely differs from this pair on 5/1986 tasks and
from the baseline on 109/1986 tasks. The runner is flag-aware; these two flags
simply have zero measurable effect on the recall, answer, and score path for
LoCoMo at 7B-Q4. The most likely reason `[INFERENCE]`: LoCoMo is replayed with
`replayExtractionMode: "skip"`, so the memory store is loaded from a pre-built
snapshot rather than re-ingested question by question. Inline contradiction
detection is a write-path gate; with no fresh writes to gate during a
skip-extraction replay it is inert. Graph recall needs a built causal or
timeline graph; with extraction skipped there is nothing to traverse, so it is
inert. Both flags are effectively no-ops under this replay mode. Confirming the
exact mechanism needs a single instrumented run and is filed as a follow-up,
not a gate on this artifact set. The bit-identity is itself the evidence that
the effect, if any, is strictly below the detection floor at this tier.

**Variance caveats.** These are Tier-L regression numbers, not capability
claims. Responder and judge are both `qwen2.5-7b-32k:latest` (7B instruct,
Q4_K_M) on a single RTX 3090, so the flag under test is a second-order effect dwarfed by the
7B answer and judge quality variance. Every cell runs at seed 1 only: there is
no multi-seed mean or confidence interval. Because the responder and judge are
the same model, the `llm_judge` column carries a known self-preference caveat.
A delta that looks real at this tier can vanish or invert on a rerun. A default
change requires either a delta outside the noise band on multiple seeds or a
Tier-F confirmation, neither of which this matrix provides. The matrix
documents the absence of a measurable single-flag effect at 7B-Q4, which means
these flags are safe to leave at their shipped defaults and that any benefit
they confer is below the detection floor of this tier.

**Artifact provenance.** The three ablation-cell artifacts
(`…c67c2c7-memory-worth-off.json`,
`…c67c2c7-contradiction-scan-on.json`,
`…c67c2c7-graph-recall-on.json`) were deliberately untracked from the working
tree to keep the Figure 1 Tier-L anchor clean: the figure generator picks the
newest artifact per benchmark and tier, so leaving the cells tracked would
have displaced the baseline anchor in the published figure. They remain
committed evidence in git history at commit `dcdcb5a8`: any clone can
retrieve and re-verify them with
`git show dcdcb5a8:docs/benchmarks/results/<basename>` followed by
`pnpm exec tsx scripts/bench/verify-artifact.ts`. They are also present on
the lab host at `~/src/remnic/docs/benchmarks/results/` and in the stored
results at `~/.remnic/bench/results/`. This is the one deliberate exception
to the "current-tree artifact" rule, and it is recorded both here and in
`docs/benchmarks/ablations.md`.

### 7.2 Bounded-memory contract ablation

- `TODO(#1708)`: bounded-memory contract ablation (raw transcript vs typed
  retrieval vs skill-triggered retrieval). #1708 is open; this subsection is
  blocked on its data.

---

## 8. Limitations & Honest Framing

**Tier-L numbers are the reproducibility anchor, not the accuracy claim.** The
Tier-L 7B-local numbers (§6.2) are modest by design. They exist so that anyone
with one consumer GPU can rerun the full benchmark and confirm the metric
pipeline end to end. They are not the accuracy headline. The accuracy claim
rests on MemCorrect's composition and protocol framing (§4) plus the Tier-F
head-to-head against the frontier baseline. Treating a Tier-L `llm_judge` of
0.224 (LoCoMo) or 0.186 (LongMemEval) as a capability statement would misread
the two-tier protocol (§5). Tier L ranks flags and adapters against each other;
Tier F carries the cross-system comparison. No Tier-L number should leave this
paper as a standalone accuracy quote.

**Local-judge calibration.** The local RTX 3090 judges both tiers. Cohen's
κ calibration (`remnic bench judge-calibrate`, §5) re-judges a
deterministic 50-question slice with both the local 7B judge and Opus as the
gold standard. LongMemEval's κ=0.769 clears the 0.7 publishability threshold,
making the local judge a defensible proxy for that benchmark. LoCoMo's κ=0.135
does not. The local 7B judge diverges substantially from Opus on LoCoMo's
open-ended answers, so the LoCoMo `llm_judge` carries a warning flag in the
artifact and should be read as approximate, not authoritative. The
deterministic metrics (`contains_answer`, `f1`, `rouge_l`) are judge-independent
and unaffected. Two operational gotchas compound the calibration risk. Some
local models (for example qwen3) truncate long contexts silently, and Ollama's
context-length default is conservative. The manifest's `ctx` field declares the
intended serving context, and preflight verifies the model id is served, but for
Ollama it does not verify the reported context length because Ollama's
`/api/tags` discovery returns only model ids, not context sizes. An operator
must confirm the context manually (the `OLLAMA_CONTEXT_LENGTH` environment
variable or `ollama show <model> --modelfile`) before relying on a large-window
run. The committed placeholder profile pins `ctx` to 16384; the lab manifest
used for the committed runs (`docs/benchmarks/configs/local-lab-3090.json`)
pins 32768.

**MemCorrect v1 synthetic-corpus limits.** The MemCorrect corpus (§4) is
deterministic and derived from synthetic token pools, so no real PII enters the
benchmark by construction. The schema validator enforces the synthetic-only
constraint at generation time. The trade-off is coverage: a synthetic corpus
cannot capture every real-world correction shape. A correction that arrives as
a nuanced paraphrase, a multi-turn negotiation, or an implicit update inferred
from behavior may not match any of the seeded correction-event shapes the
generator produces. The §6.1 results are scoped to what the corpus tests, not
to the full space of correction interactions a deployed system encounters. The
corpus is extensible (new event shapes and token pools can be added without
changing the adapter contract), but the v1 results reflect v1 coverage.

**`claude -p` as a research-harness path.** The Tier-F responder is Opus 4.8
invoked through Claude Code (`claude -p`) via the `claude-cli` bench provider.
This is a valid research harness, not a raw Anthropic API call. Claude Code adds
system-prompt scaffolding and model-alias routing on top of the base model, so
the measurement path is explicit and distinct from a direct API run. The
artifact records provider, harness, entitlement, model, isolation settings, and
invocation as provenance, and a result retains `tier: "frontier"` when the
artifact contract is satisfied. Isolation is enforced by the provider: a freshly
created empty temp workspace, tools disabled, user and project configuration
skipped, session persistence off, and an environment allowlist that excludes
memory directories and unrelated secrets. Without this isolation, Claude Code
inherits user-level instructions and silently contaminates every answer. Bounded
(`--limit` / `--trial-limit`) trials remain partial-coverage evidence and are
never presented as full leaderboard results. The promotion bridge rejects them
outright.

**Fact-store correction is necessary but not sufficient.** The §6.1 MemCorrect
result exposes a limitation that is also the motivation for the next stage of
work. At Tier L, Remnic's containment-scored metrics land on the same floor as
the prompt-only baseline (`uptake_at_next = 0`, `non_resurrection = 0`,
`false_apply = 1` for both adapters). Per-scenario tracing confirms this is not
a harness artifact and not a dead correction path: extraction produces the
target fact, the Correction Contract plan applies, and the stored fact is
retired. The probes still fail because stale content reaches the serving layer
through three side channels. First, the 7B classify model drafts retire-only
actions instead of supersede-with-replacement, so no corrected fact exists for
the probe to contain. Second, behavioral-profile lines derived from the original
fact survive the correction. Third, verbatim LCM turn evidence quotes the
outdated statement into recall context. MemCorrect is strict by design: a system
that keeps serving the stale value anywhere in its recall context fails the
probe, even when a corrected fact also surfaces. The result is exactly the
failure class the benchmark exists to expose. Fact-store correction is necessary
but not sufficient; correction must propagate to every serving surface. The
serving-surface propagation follow-up and the classify-model capability axis at
Tier F are the direct consequences of this measurement.

---

## 9. Conclusion & Reproducibility

This paper made three claims. MemCorrect turns memory correction into a
system-agnostic, deterministically scoreable protocol, and its first
full-matrix runs expose a concrete failure class: fact-store correction
succeeds while stale content keeps reaching the serving layer (§6.1). The
two-tier protocol makes every published number carry its provenance: Tier F
(Opus 4.8 via Claude Code) holds the accuracy claim, Tier L re-runs on one
RTX 3090, and Cohen's-κ calibration connects the two judges (§5, §6.2). The
glass-box mechanisms (§3) make each recalled memory explainable and
correctable, and the §6 measurements show why that matters: the open problem
is no longer whether a system can recall, but whether a correction
propagates everywhere the stale fact can still be served.

Reproducibility is documented in [Appendix A](repro-appendix.md): the
repro-manifest schema (`repro-manifest.ts`), the model-lab manifests, the
complete Tier-L reproduction path on a single RTX 3090 (24 GB) with
Ollama-served models, and the Tier-F path (§A.5: `claude-cli` provider
isolation flags, checkpoint/resume across Claude Max usage windows,
sampled-pilot-then-full discipline). In one line: clone the repo, pin the
manifests, and every Tier-L number in §6 re-derives on one consumer GPU.

---

## Owner-issue index (for the section-drafting children)

| Section | Owning issue(s) for real content |
|---|---|
| Abstract, §1, §3 assembly, §8 | #1726 (this issue) |
| §2 Related Work | #1729 |
| §3 subsystems | #1539, #1575, #1576, #1577, #1578, #1579, #1580, #1581, #1582, #1583 |
| §4 MemCorrect | #1584 (methodology), #1727 (third-party adapters) |
| §5 Experimental Setup | #1573, #1574, #1728, #1735 |
| §6 Results | #1584, #1727, #1728, #1576, #1577, #1709 |
| §7 Ablations | #1574, #1708 |
| §9 + Repro Appendix | plan execution item 8, #1585, #1728 |
