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
correctable. Each subsystem is a `TODO` to its owning issue for the
mechanism description; this skeleton does not restate mechanism details.

- **3.1 Three-tier retrieval** — `TODO(#1539)`: describe the recall spine and
  the four thin-config pipeline stages, with the declared event-order budget
  fix.
- **3.2 Provenance spans** — `TODO(#1575)`: span model, storage, read surfaces.
  Cite the shipped `provenance.ts` surfaces, not orchestrator internals.
- **3.3 Faithfulness gate** — `TODO(#1576)`: extraction-time gate; shadow mode
  enables the harvest stream for the #1585 model lab.
- **3.4 TrustScore** — `TODO(#1577)`: the recall-stage trust signal
  (`trust-zones.ts`/`provenance.ts`). **Note for §3 vs §6:** TrustScore is a
  shipped *recall-stage feature*, **not yet a benchmark metric** — describe it
  as a system capability here; do not score it in §6 until surfacing work
  exists (flag in §6 TODO).
- **3.5 Correction Contract + passive detection + memory handles** —
  `TODO(#1580)` Correction Contract (4-PR order); `TODO(#1581)` passive
  correction detection; `TODO(#1582)` memory handles `[m:xxxx]`;
  `TODO(#1583)` the chat surface that exercises correction end-to-end.
- **3.6 Bi-temporal validity + tombstones / non-resurrection** —
  `TODO(#1578)` bi-temporal frontmatter + recall filter;
  `TODO(#1579)` tombstones and the 5-path resurrection matrix (the guarantee
  §4's `non_resurrection` metric measures).
- `TODO(#1726)`: assemble §3 once the subsystem issues above have merged; until
  then this section is a structural placeholder.

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
reproducible on one GPU. Lift from `docs/benchmarks/sota-readiness.md`.
Cover: the two-tier protocol (Tier L local / Tier F frontier), runtime
profiles (`runtime-profiles.ts`), the judge cache + Cohen's-κ cross-tier
calibration, repro manifests (`repro-manifest.ts`), and seed / model / dataset
/ commit-SHA pinning. State the **publishability rubric** (non-mock; repro
manifest present; judge calibration reported; honest framing attached;
leaderboard-safety / explicit-cue guards; reproducible on one GPU).

- `TODO(#1573)`: cite the local-lab harness + judge cache + calibration
  mechanism (RTX 3090 box, `local-lab` profile).
- `TODO(#1574)`: cite the runtime profiles used (baseline / real /
  openclaw-chain / local-lab) and the existing single-flag ablation profiles.
- `TODO(#1728)`: define the Tier-F responder configuration honestly —
  **Opus 4.8 via Claude Code (`claude -p`)**, `--tools ""` + `--safe-mode` +
  isolated cwd + `--append-system-prompt`, local 3090 as judge (calibrated
  against a small Opus-judged slice for Cohen's κ). State explicitly that this
  is "Opus 4.8 via Claude Code," **not** a raw-API frontier number, and that
  `tier` stays `"frontier"` with the label in the artifact `note`/model
  metadata.
- `TODO(#1735)`: gate the Tier-F description on the `claude-cli` bench
  provider landing — it is a hard prerequisite, not assumed-present.

---

## 6. Results

**Intent.** Three result blocks, each gated on a real, non-mock, committed
artifact. **No number appears in this section until its artifact exists and
passes the §5 publishability rubric.** Until then, every block is a TODO.

- **6.1 MemCorrect — Remnic vs baselines vs third-party adapters.**
  - `TODO(#1584)`: commit a real `memcorrect-v1` Tier-L artifact
    (`docs/benchmarks/results/`). As of this skeleton **no MemCorrect artifact
    is committed** — only the harness + generator + metrics exist.
  - `TODO(#1727)`: add the Mem0 / Zep / Letta adapter rows. Until the adapters
    exist, §6.1 can only report Remnic-native vs the `PromptOnlyBaselineAdapter`
    floor — clearly labeled as such, not as a "we beat X" claim.
- **6.2 LoCoMo / LongMemEval — head-to-head at Tier F, Tier L as anchor.**
  - `TODO(#1728)`: produce the Tier-F run. As of this skeleton **no Tier-F
    artifact exists.**
  - **Citable today (Tier L only, reproducibility anchor, not the accuracy
    claim):** the two committed local artifacts —
    `docs/benchmarks/results/2026-07-07-locomo-qwen2.5-7b-32k_latest-47aae03.json`
    and
    `docs/benchmarks/results/2026-07-07-longmemeval-qwen2.5-7b-32k_latest-47aae03.json`
    (`tier: "local"`, model `qwen2.5-7b-32k:latest`). Reference them by path
    in the draft; do **not** quote their metric values in the skeleton.
  - `TODO(#1727)`: reproduce-or-cite-with-caveat the Mem0 and Zep
    self-reported published numbers (per the plan doc's Part 2, item 4) via
    our harness. Those competitor figures are currently cited-from-issue-text,
    **not** reproduced by our harness — mark as cited-not-reproduced or run
    them; do not echo the literal values here until they are reproduced.
- **6.3 TrustScore / faithfulness behavior.**
  - `TODO(#1577)`: TrustScore is a shipped recall feature, **not a benchmark
    metric yet.** Report it as system behavior (qualitative + a worked example)
    unless/until a scored surface is added; do not invent a metric.
  - `TODO(#1576)`: faithfulness gate behavior — describe against the #1585
    shadow/harvest data once that stream exists.
- `TODO(#1709)`: close the `judgeCalibration` (Cohen's κ) gap before any Tier-F
  number is published.

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
- **Local-judge calibration caveats** — the local 3090 judges Tier F; κ vs an
  Opus-judged slice must be reported and is currently a gap (#1709). State the
  qwen3 truncation + ollama context-default gotchas already documented in the
  bench docs.
- **MemCorrect v1 synthetic-corpus limits** — deterministic, token-pool-derived
  (no real PII by construction), but synthetic; the corpus does not capture
  every real-world correction shape. Scope to what the corpus tests.
- **`claude -p` is not a raw-API number** — Claude Code adds system-prompt
  scaffolding + model-alias routing and is not reproducible without a Claude
  Code entitlement. Say so.
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
