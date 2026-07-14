# Glass-Box Memory: Correctable, Provenance-Tracked Memory for User-Aware Agents

> **Status: skeleton.** This file is section headers + a short paragraph of
> intent per section + clearly-marked `TODO(#NNNN)` placeholders. It is **not**
> prose and contains **no results or numbers**. See `README.md` for the
> drafting rules (no fabricated numbers; cite only committed artifacts; lead
> with MemCorrect, not raw accuracy).
>
> **Source of truth for structure:**
> `docs/plans/2026-07-07-evidence-sprint-arxiv-outline.md` (Part 1). If this
> file and the outline diverge, the outline wins.

---

## Abstract

**Intent.** State the three contributions in one paragraph: (1) **MemCorrect**,
a system-agnostic benchmark for memory *correction and steerability* — framed
as a composition/protocol claim, **not** "first to measure correction"; (2) a
**reproducible-on-consumer-hardware** two-tier (local RTX 3090 / frontier)
evaluation protocol with committed repro manifests; (3) **glass-box trust**
mechanisms — provenance spans, a faithfulness gate, TrustScore, and
bi-temporal validity — that make recalls explainable and correctable, set
against documented time-sensitive-memory failures in closed systems. Close
with the honest scope line: Tier-L 7B-local numbers are a reproducibility
anchor, not the accuracy headline.

- `TODO(#1584)`: land the MemCorrect one-line framing once the third-party
  adapter coverage (#1727) exists, so the comparison set is real.
- `TODO(#1728)`: replace the Tier-F qualifier with the actual frontier-model
  identity once the run lands (Opus 4.8 via `claude -p`).
- `N/A` — no numbers in the abstract until every cited metric traces to a
  committed, non-mock artifact.

---

## 1. Introduction

**Intent.** Frame the agent-memory problem from the user's side: "the tool
remembers a stale fact" is the field's #1 documented user pain, and users'
only defense today is turning memory off. Argue that **recall accuracy is
necessary but no longer the open problem** — correction durability, collateral
safety, scope precision, and explainability are. Position glass-box memory as
the response. End with an explicit **contributions list**:

1. **MemCorrect** — the first benchmark to evaluate agent-memory correction as
   an end-to-end, system-agnostic protocol combining adversarial
   non-resurrection, collateral safety, namespace-scoped precision, write-path
   false-apply, and revocation in one deterministic, adapter-scoreable corpus
   (composition/protocol novelty — see §2 for prior art).
2. **Glass-box mechanisms** — provenance spans (#1575), a faithfulness gate
   (#1576), TrustScore (#1577), bi-temporal validity + tombstones/non-
   resurrection (#1578–1579), and the Correction Contract + passive correction
   detection + memory handles `[m:xxxx]` (#1580–1583).
3. **A reproducible-on-one-GPU protocol** — two-tier (Tier L local / Tier F
   frontier) with committed repro manifests, judge cache, and Cohen's-κ
   cross-tier calibration.
4. **Results** — MemCorrect vs baselines and third-party adapters; LoCoMo /
   LongMemEval head-to-head at Tier F with Tier L as the reproducibility
   anchor; TrustScore/faithfulness behavior. *(All numeric — see §6 TODOs.)*

- `TODO(#1726)`: write the motivating paragraph once §6 results exist; do not
  assert any accuracy figure in the intro that §6 does not back with a
  committed artifact.
- `TODO(#1729)`: cross-link the §2 prior-art engagement so the novelty claim
  is defensible line-by-line (StateBench, STALE, MemSyco-Bench, MemStrata,
  MemoryAgentBench FactConsolidation, RippleEdits/MQuAKE/TOFU/MUSE).

---

## 2. Related Work

**Intent.** Seed directly from `docs/research/paper-mapping.md`
(Memory-OS, HiMem, SwiftMem, TiMem, MAGMA/SYNAPSE, MemoryOS, ACON) and the
competitor landscape (Mem0, Zep, Letta). Position Remnic on the axes
competitors ignore: **correction, provenance, faithfulness**. Engage the
prior-art named in the plan's Novelty section metric-by-metric so the
composition novelty is defensible against a reviewer or HN commenter who finds
each one.

- **This section is drafted standalone in `related-work.md`, owned by sibling
  issue #1729.** This file does not duplicate it. When #1729 lands, replace
  this block with a one-line pointer to `related-work.md` plus the
  differentiation-table reference.
- `TODO(#1729)`: produce the differentiation table (axes: correction,
  provenance, faithfulness, reproducibility, consumer-hardware).
- `TODO(#1729)`: confirm the metric-attribution split — genuinely new
  (`uptake_latency`, `reassertion`, `provenance_fidelity`, namespace-twin
  `scope_precision`, anti-event `false_apply`) vs borrowed-but-attributed
  (`collateral_delta` ← RippleEdits RS/PV, `uptake_at_next` ←
  MemoryAgentBench FactConsolidation, `non_resurrection` ← StateBench SFRR /
  MemStrata).

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

**Intent.** The field-first contribution. Describe (a) **task construction**
via the deterministic, seeded synthetic corpus generator (no real content
committed — synthetic token pools enforced by the schema validator); (b) the
**`MemCorrectSystemAdapter`** public interface, which makes the benchmark
system-agnostic; (c) the **eight metrics** with direction and the
determinism/judge split. Lift the methodology verbatim-adapted from
`docs/benchmarks/memcorrect.md`.

The adapter contract (cite the committed interface in
`packages/bench/src/benchmarks/remnic/memcorrect/adapters.ts`, do not
re-derive):

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

The eight metrics (`uptake_at_next`, `uptake_latency`, `non_resurrection`,
`collateral_delta`, `scope_precision`, `false_apply`, `reassertion`,
`provenance_fidelity`) — directions and definitions live in
`docs/benchmarks/memcorrect.md`; the paper restates them, it does not invent
new ones.

- `TODO(#1584)`: lift the metric table and the four correction-event shapes +
  anti-event taxonomy from `docs/benchmarks/memcorrect.md`.
- `TODO(#1584)` **[claim already corrected — keep guard]**: `docs/benchmarks/
  memcorrect.md` no longer says LongMemEval KU is "near ceiling"; it now reads
  *"the strongest systems score roughly 70–90%, not ceiling"* and frames KU as
  answer-time-only. The §4 draft must preserve this corrected framing; do not
  re-introduce the old wording.
- `TODO(#1727)`: name the third-party adapters scored (Mem0 → Zep → Letta
  order) once implemented; until then §4 describes the *contract*, not a
  comparison.

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

  **`locomo_hidden_evidence_id_leak = 1.0`** on both tiers: the
  responder always echoes the hidden evidence identifier embedded in
  the recalled context. This is a known harness interaction (the IDs
  are in the LCM evidence text the responder reads), not a Remnic
  mechanism failure; it is reported honestly rather than suppressed.

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

**Intent.** Two ablation families, each lifted from its owning issue — no new
runs invented here.

- **7.1 Single-flag ablations** — `TODO(#1574)`: Memory Worth multiplier,
  contradiction scan, graph recall. Report as on/off deltas with the runtime
  profile + seed pinned per the §5 manifest.
- **7.2 Bounded-memory contract ablation** — `TODO(#1708)`: raw transcript vs
  typed retrieval vs skill-triggered retrieval. **#1708 is open** — coordinate
  rather than duplicate; this section is blocked on its data.
- `TODO(#1726)`: assemble the ablation table once both families' artifacts are
  committed; until then this section lists the axes only.

---

## 8. Limitations & Honest Framing

**Intent.** The credibility section. State plainly, with no hedging that
softens into overclaim:

- **Tier-L 7B-local numbers are modest and are *not* the accuracy claim.** They
  are the reproducibility anchor (one-GPU, re-runnable). The accuracy headline
  is MemCorrect (composition) + the Tier-F head-to-head.
- **Local-judge calibration** — the local 3090 judges Tier F; Cohen's κ
  vs an Opus-judged slice is now measured and reported (LongMemEval
  κ=0.769 above threshold; LoCoMo κ=0.135 below — the LoCoMo
  `llm_judge` carries a warning). The low κ on LoCoMo is a genuine
  limitation: the local 7B judge diverges from Opus on open-ended
  answers, so LoCoMo's `llm_judge` is approximate. State the qwen3
  truncation + ollama context-default gotchas already documented.
- **MemCorrect v1 synthetic-corpus limits** — deterministic, token-pool-derived
  (no real PII by construction), but synthetic; the corpus does not capture
  every real-world correction shape. Scope to what the corpus tests.
- **`claude -p` is a valid research-harness path distinct from raw API.**
  Claude Code adds system-prompt scaffolding and model-alias routing; record
  the harness, entitlement, model, isolation, and invocation details as
  provenance. A result may retain `tier: "frontier"` when the artifact
  contract is satisfied; bounded trials remain partial-coverage results.
- `TODO(#1726)`: no drafting blocker — write the prose from the bullets above
  once §5/§6 are populated; do not add limitations that imply un-run
  experiments.

---

## 9. Conclusion & Reproducibility

**Intent.** Restate the three contributions; point at the reproducibility
appendix as the proof that the protocol is one-GPU-rerunnable. The appendix
itself is a sibling file (`repro-appendix.md`, owned by the plan's execution
item 8) and is not created in this skeleton.

- `TODO(plan-exec-item-8)`: produce `docs/paper/repro-appendix.md` containing
  the repro-manifest reference (`repro-manifest.ts`), the model-lab manifests
  (#1585), and the one-GPU (RTX 3090) reproduction instructions. Until it
  exists, §9 carries only the pointer.
- `TODO(#1728)`: include the Tier-F repro instructions (claude-cli provider
  from #1735, isolation flags, checkpoint/resume across Claude Max windows,
  sampled-first → full).
- `TODO(#1726)`: when the appendix lands, replace this block with a one-line
  pointer and a "reproduce on one GPU" summary.

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
