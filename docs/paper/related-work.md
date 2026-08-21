# §2 Related Work

> Owner: issue [#1729](https://github.com/joshuaswarren/remnic/issues/1729). Part of
> the evidence-sprint epic [#1725](https://github.com/joshuaswarren/remnic/issues/1725).
> This is the standalone Related Work section referenced by the paper skeleton
> (`docs/paper/main.md` §2). It is self-contained and mergeable independently of
> the skeleton.
>
> **Sourcing policy (rule 55).** Every claim about a third party cites its public
> paper, preprint, or vendor artifact. Every claim about Remnic/MemCorrect cites an
> in-repo artifact or issue. No accuracy number appears without a source. Where the
> Remnic side has no committed measurement yet (the MemCorrect lab run is GPU-gated,
> see `docs/benchmarks/memcorrect.md` "Status"), this section makes **no** accuracy
> claim — only structural/definitional claims.

## 2.1 Positioning in one paragraph

MemCorrect is a **write-time correction benchmark** built on a
**system-agnostic adapter contract** and a **deterministic synthetic corpus**. Its
claim is *compositional*, not "first to measure memory correction": the individual
behaviors it scores (uptake, non-resurrection, collateral safety, scope precision,
write-path false-apply, revocation) each have antecedents in the knowledge-editing,
staleness, and agent-memory literatures. The contribution is that **no prior work
combines all of these in one system-agnostic protocol with a hermetic corpus**, and
that several of the metrics it introduces (`uptake_latency`, `reassertion`,
`provenance_fidelity`, namespace-twin `scope_precision`, anti-event `false_apply`)
have no direct prior expression. We state the antecedents explicitly below so the
novelty claim survives a reader who already knows the closest relatives.

## 2.2 Weight-editing ancestors (the lineage MemCorrect imports onto a new substrate)

Knowledge *editing* of model weights is the historical home of "change one fact and
measure the consequences." Three benchmarks define that substrate:

- **RippleEdits** (Cohen et al., arXiv:[2307.12976](https://arxiv.org/abs/2307.12976);
  TACL 2024) is a diagnostic benchmark of 5K factual edits with six evaluation
  criteria — Logical Generalization, Compositionality I/II, Subject Aliasing,
  **Relation Specificity (RS)**, and **Preservation (PV)**. PV asks whether an edit
  damages unrelated facts; RS asks whether it stays specific to the target relation.
  MemCorrect's `collateral_delta` is the retrieval-substrate descendant of PV, and
  `scope_precision` is the namespace-twin descendant of RS — except both are measured
  *behaviorally over recall* rather than as likelihood shifts on edited weights.
- **MQuAKE** (Zhong et al., arXiv:[2305.14795](https://arxiv.org/abs/2305.14795))
  shows that weight editors recall the edited fact but "fail catastrophically" on
  multi-hop questions whose answers should ripple from the edit (datasets
  MQUAKE-CF-3K and MQUAKE-T, k ∈ {2,3,4}). Its memory-based baseline MeLLo stores
  edits externally — the same "external store, not weight surgery" move MemCorrect
  assumes of every adapter.
- **TOFU** (Maini et al., arXiv:[2401.06121](https://arxiv.org/abs/2401.06121)) and
  **MUSE** (Shi et al., arXiv:[2407.06460](https://arxiv.org/abs/2407.06460)) define
  machine *unlearning* evaluation: TOFU with 200 synthetic author profiles and a
  forget/retain split scored by Forget Quality and Model Utility; MUSE with six
  desiderata over real-world corpora. Their forget/retain framing maps onto
  MemCorrect's retired-fact-must-stay-retired requirement (`non_resurrection`),
  but they edit weights whereas MemCorrect measures whether a *retrieval*
  store keeps a retired fact dead under re-ingest.

The substrate shift matters: in a retrieval/consolidation memory the "edit" is an
observed turn, the "weight" is a stored passage plus a lifecycle decision, and the
adversary is **re-ingest of the original establishing transcript** — a failure mode
that has no analogue in the weight-editing setting, where there is no separate
write path to re-trigger resurrection. Citing these as ancestors therefore
*strengthens* rather than dilutes the claim: the metrics travel, the substrate does
not.

## 2.3 The closest relatives: correction- and staleness-oriented benchmarks

These are the works a reviewer will reach for first. We address each head-on.

**StateBench** (Parslee / Liotta; vendor white papers
"[Beyond Conversation: A State-Based Context Architecture for Enterprise AI
Agents](https://github.com/Parslee-ai/statebench/blob/main/docs/state-based-context-architecture.pdf)"
2025 and
"[Memgine: A Deterministic Memory Engine](https://github.com/Parslee-ai/statebench/blob/main/docs/memgine-deterministic-memory-engine.pdf)"
2026; code at [github.com/Parslee-ai/statebench](https://github.com/Parslee-ai/statebench))
is the **closest relative**. It is a conformance test for stateful agents with 13
tracks and 1,400+ scenarios, six failure classes (Resurrection, Hallucination,
Scope Leak, Stale Reasoning, Authority Violation, Temporal Decay), and a headline
metric **SFRR — Superseded Fact Resurrection Rate** — that is structurally
identical to MemCorrect's `non_resurrection` (both ask: after a fact is
superseded, does the system ever serve it again?). StateBench exposes baseline
"strategies" (`state_based`, `fact_extraction_with_supersession`,
`transcript_latest_wins`, …) and reports its own engine Memgine at 95.8–97.3%
decision accuracy with SFRR in the 23–37% band across model configurations
([StateBench README, v1.1 leaderboard](https://github.com/Parslee-ai/statebench)).
The overlap is real and we do not hide it. StateBench is **not peer-reviewed**
(vendor artifact) and its published results are its own engine plus ten in-tree
baselines — but it is *not* closed to third-party scoring: the harness exposes a
`MemoryStrategy` interface (`process_event`, `build_context`,
`get_system_prompt`, `reset`) that you register in the harness and run via
`statebench leaderboard --baseline my_strategy`
([StateBench README, "Adding Your Implementation"](https://github.com/Parslee-ai/statebench#adding-your-implementation)).
So the differentiator is *not* "open vs. closed." It is **adapter shape** and
**adversary**: a `MemoryStrategy` is an *in-harness* strategy — you reimplement
context-building (`build_context`) inside the StateBench Python process — whereas
MemCorrect's `MemCorrectSystemAdapter` wraps an *external* memory system
(Mem0/Zep/Letta-shaped) behind `ingestTurn` / `recall` / `correct` /
`runMaintenance`, scoring it as a black box over its own write/read path with no
in-harness context reimplementation. StateBench's SFRR also does not combine the
**re-ingest adversary** (re-feeding the original establishing transcript) with
maintenance cycling the way `non_resurrection` does, nor does StateBench score
write-path `false_apply`, scoped `scope_precision`, `reassertion`, or
correction-event `provenance_fidelity`.

> Disambiguation: a separate **STATE-Bench** was announced by Microsoft Open Source
> in May 2026 ([blog](https://opensource.microsoft.com/blog/2026/05/19/introducing-state-bench-a-benchmark-for-ai-agent-memory/)).
> It is a different artifact from Parslee's StateBench and is not the close
> relative discussed here; we mention it only to prevent citation confusion.

**STALE** (Chao et al., arXiv:[2605.06527](https://arxiv.org/abs/2605.06527),
May 2026) is, in scope, the **closest** framing of the problem among the staleness benchmarks (arXiv preprint; no peer-reviewed venue as of this writing). It defines
three probing dimensions — **State Resolution** (detect a prior belief is
outdated), **Premise Resistance** (reject queries that falsely presuppose a stale
state), and **Implicit Policy Adaptation** (apply the updated state downstream) —
over 400 expert-validated conflict scenarios (1,200 queries, contexts up to 150K
tokens). Its headline finding is the field's strongest motivation for this work:
even the best evaluated frontier model achieves only **55.2%** overall accuracy,
and models "often accept outdated assumptions embedded in a user's query."
Premise Resistance is conceptually adjacent to MemCorrect's `false_apply` (both
catch the system acting on a cue it should not), but STALE measures it at
**read/answer time over a fixed memory**, whereas MemCorrect measures whether a
**write-path** mutation occurred after an anti-event (quoting-others /
hypothetical / third-party-correction). Its prototype CUPMem strengthens
write-time revision — independently supporting the design direction Remnic's
Correction Contract ([#1580](https://github.com/joshuaswarren/remnic/issues/1580))
and tombstones ([#1579](https://github.com/joshuaswarren/remnic/issues/1579)) take.

**MemSyco-Bench** (Xiang et al., arXiv:[2607.01071](https://arxiv.org/abs/2607.01071),
July 2026) sits at the **opposite end of the pipeline**: it benchmarks
memory-induced *sycophancy* — when retrieved memory should influence a decision,
and how valid memory should be used — across five tasks (reject memory as factual
evidence, respect its scope, resolve memory-vs-objective-evidence conflicts, track
updates, use valid memory for personalization). The clean axis split is the point:
MemSyco-Bench asks "did the agent *reason correctly given* the memory it
retrieved?"; MemCorrect asks "did the memory *store itself correctly* when a
correction or an anti-event arrived?" The two are complementary — a system could
pass one and fail the other — and we cite MemSyco-Bench precisely to bound our
scope rather than claim to cover read-time sycophancy.

**MemStrata / Temporal-Validity** (Yadav, arXiv:[2606.26511](https://arxiv.org/abs/2606.26511),
June 2026) implements a `non_resurrection`-like property with a **deterministic
(subject, relation, object) supersession rule** in a bi-temporal ledger: when a
fact's value is contradicted, the stale value is retired without a similarity
threshold or an LLM call. On six local benchmarks with a 7B model, MemStrata ties
RAG on static knowledge and reaches 0.95–1.00 accuracy on evolving knowledge where
RAG reaches 0.20–0.47; its central result is driving the **stale-fact-error rate**
from RAG's 15–40% down to ~0%. This is strong evidence the *property* is achievable
and is a conceptual ally of Remnic's own bi-temporal work
([#1578](https://github.com/joshuaswarren/remnic/issues/1578)). The differentiator:
MemStrata is **self-evaluated against generic RAG only**, exposes **no adapter
contract** for scoring third-party memory systems, and does not measure collateral
damage, scope precision, or write-path false-apply. It is a system, not a
shared-eval protocol.

**MemoryAgentBench** (Hu, Wang, McAuley, arXiv:[2507.05257](https://arxiv.org/abs/2507.05257);
ICLR 2026) identifies four core memory competencies — accurate retrieval,
test-time learning, long-range understanding, and **selective forgetting** — and
is the broadest multi-turn agent-memory benchmark. Its selective-forgetting
competency is structurally closest to MemCorrect's `uptake_at_next` *alone* (a
single post-correction snapshot asking whether the new fact is present and the old
absent). It does not decompose that snapshot into latency, does not re-ingest the
establishing transcript, and does not probe scoped twins or anti-events. We treat
`uptake_at_next` as a **borrowed, attributed** metric and cite MemoryAgentBench as
its origin.

**LongMemEval** (Wu et al., arXiv:[2410.10813](https://arxiv.org/abs/2410.10813))
is the canonical long-term-memory benchmark — 500 questions across five abilities
(information extraction, multi-session reasoning, temporal reasoning, **knowledge
updates**, abstention) embedded in scalable multi-session chat histories, with a
reported ~30% accuracy drop for commercial assistants and long-context LLMs. Its
knowledge-update category is the prior art MemCorrect's motivation section
(`docs/benchmarks/memcorrect.md`) already cites as the closest *recall* benchmark:
LongMemEval tests whether the newest fact wins at answer time (strongest systems
~70–90%, not ceiling); it does not measure how *fast* a correction takes effect,
whether it *resurrects*, whether it *damages* unrelated memories, whether it
*respects scope*, or whether the system *falsely applies* third-party cues — the
gaps MemCorrect exists to fill.

## 2.4 Memory systems and architectures (the competitor landscape)

The production memory systems a practitioner reaches for today — **Mem0**, **Zep**,
and **Letta (MemGPT)** — compete on extraction quality, retrieval latency, and
context management. We position MemCorrect on the axes they do not address:
**correction, provenance, and faithfulness**.

- **Mem0** (Chhikara et al., arXiv:[2504.19413](https://arxiv.org/abs/2504.19413);
  [docs.mem0.ai](https://docs.mem0.ai/)) is a memory-centric architecture that
  extracts salient facts from conversations and maintains consistency via LLM-driven
  ADD/UPDATE/DELETE/NOOP tool calls, with a graph variant (Mem0g) storing memories as
  labeled directed graphs. Its UPDATE/DELETE operations are the conceptual home of
  "correction," but Mem0's published evaluation is on extraction/retrieval quality
  and token reduction (~90% per its docs), not on adversarial non-resurrection under
  re-ingest, collateral safety across scopes, or write-path false-apply. MemCorrect's
  adapter contract is deliberately shaped so a Mem0 adapter can be scored on exactly
  those axes (`docs/benchmarks/memcorrect.md`, "Submitting third-party results").
- **Zep** (Rasmussen et al., arXiv:[2501.13956](https://arxiv.org/abs/2501.13956)),
  powered by the **Graphiti** temporally-aware knowledge-graph engine, is the
  closest production system to Remnic's bi-temporal posture: every edge carries a
  validity interval `(t_valid, t_invalid)`, conflicts are resolved by temporal
  metadata that *invalidates but does not discard* outdated facts, and Cypher queries
  (not LLM-generated queries) write the graph. Zep reports 94.8% on the DMR benchmark
  (vs MemGPT's 93.4%) and up to 18.5-point improvements on LongMemEval with ~90%
  latency reduction. Its "invalidate but do not discard" is precisely the property
  `non_resurrection` and Remnic tombstones ([#1579](https://github.com/joshuaswarren/remnic/issues/1579))
  operationalize — but Zep does not publish a correction-stress benchmark or an
  adapter contract, and its eval is recall-accuracy-oriented, not
  resurrection-under-reingest-oriented.
- **Letta / MemGPT** (Packer et al., arXiv:[2310.08560](https://arxiv.org/abs/2310.08560))
  treats the LLM "as an operating system": a two-tier memory (fixed-size **core**
  memory writable only via function calls, plus **archival** memory backed by
  vector search) with **self-editing** via tool calls and heartbeat-driven
  multi-step loops. Self-editing means an agent *can* correct its own memory, but
  the self-edit is unconstrained and evaluated on conversation coherence, not on
  whether a retired fact survives re-ingest or whether an anti-event causes a spurious
  write. The axis Letta owns (autonomous memory management) is orthogonal to the axis
  MemCorrect owns (whether the resulting state is correction-correct).

**Concept influences already productized in Remnic** (from
`docs/research/paper-mapping.md`, which maps shipped feature families to their
inspirations and is explicit that the mapping is historical, not a roadmap):
HiMem-style episodic/stable separation, SwiftMem-style query-aware temporal
prefiltering, TiMem-style time-bucket summaries, MAGMA/SYNAPSE-inspired bounded
graph traversal, MemoryOS-style promotion/stale/archive lifecycle policy, and
ACON-style bounded compression-guideline learning. These position Remnic's
*substrate* in the literature; they are not correction-specific and are listed for
completeness. The correction-specific Remnic surfaces MemCorrect measures are the
glass-box epic ([#1572](https://github.com/joshuaswarren/remnic/issues/1572)):
provenance ([#1575](https://github.com/joshuaswarren/remnic/issues/1575),
`provenance.ts`), the extraction faithfulness gate ([#1576](https://github.com/joshuaswarren/remnic/issues/1576),
`extraction-faithfulness.ts`), bi-temporal valid-time tracking ([#1578](https://github.com/joshuaswarren/remnic/issues/1578)),
tombstones ([#1579](https://github.com/joshuaswarren/remnic/issues/1579),
`lifecycle/`), the Correction Contract ([#1580](https://github.com/joshuaswarren/remnic/issues/1580),
`correction/`), passive corrections ([#1581](https://github.com/joshuaswarren/remnic/issues/1581)),
recall handles ([#1582](https://github.com/joshuaswarren/remnic/issues/1582),
`recall-handles.ts`), and the chat correction surface ([#1583](https://github.com/joshuaswarren/remnic/issues/1583),
`chat/`).

## 2.5 What is genuinely new, and what is borrowed

To make the novelty auditable, Table 1 attributes every MemCorrect metric to its
closest prior expression. "Borrowed/attributed" means the *idea* exists in prior
work and we say so; "new" means no prior work we found expresses it directly. The
substrate (retrieval/consolidation, with a re-ingest adversary) is new for all rows.

### Table 1 — Metric-by-metric differentiation

| MemCorrect metric | Dir. | Prior expression | Attribution | Why it is not the same |
|---|---|---|---|---|
| `uptake_at_next` | ↑ | MemoryAgentBench selective-forgetting competency (single post-correction snapshot) | **Borrowed** — [arXiv:2507.05257](https://arxiv.org/abs/2507.05257); also LongMemEval knowledge-update category [arXiv:2410.10813](https://arxiv.org/abs/2410.10813) | Those measure "newest fact wins at answer time"; `uptake_at_next` is one probe in a multi-phase protocol that also scores latency, resurrection, and scope. |
| `uptake_latency` | ↓ | *None found* — prior work reports accuracy, not turns-to-first-correct-recall | **New** | First metric to score *how fast* a correction takes effect as a censored turn-latency distribution. Censored count carried in `uptake_latency_censored` (`packages/bench/src/.../memcorrect/metrics.ts`). |
| `non_resurrection` | ↑ | StateBench **SFRR** (Superseded Fact Resurrection Rate); MemStrata stale-fact-error rate | **Borrowed** — StateBench [README](https://github.com/Parslee-ai/statebench); [arXiv:2606.26511](https://arxiv.org/abs/2606.26511) | Prior versions check "did the stale value get served?". `non_resurrection` adds the **re-ingest of the original establishing transcript** *and* K maintenance cycles as a combined adversary — a failure mode with no weight-editing analogue. |
| `collateral_delta` | →0 | RippleEdits **Preservation (PV)** | **Borrowed** — [arXiv:2307.12976](https://arxiv.org/abs/2307.12976) | PV is a likelihood-based edit-safety check on weights; `collateral_delta` is behavioral recall over an explicitly seeded unrelated-fact probe set, target-zero (signed after−before), deliberately excluded from directional verdicts (`runner.ts` `MEMCORRECT_LOWER_IS_BETTER`). |
| `scope_precision` | ↑ | RippleEdits **Relation Specificity (RS)** (conceptually); StateBench "Scope Leak" failure class | **Partly new** — specificity concept [arXiv:2307.12976](https://arxiv.org/abs/2307.12976); StateBench scope-leak testing [Parslee](https://github.com/Parslee-ai/statebench) | The **namespace-twin** design (seed an identical fact in namespace B, verify a namespace-A correction leaves B intact) is new; it turns a weight-editing specificity idea into a multi-tenant recall probe. Grounded in Remnic's scoped write path (`access-service.ts` `resolveWritableNamespace`). |
| `false_apply` | ↓ | STALE **Premise Resistance** (adjacent); MemSyco-Bench scope-respect task | **Partly new** — [arXiv:2605.06527](https://arxiv.org/abs/2605.06527), [arXiv:2607.01071](https://arxiv.org/abs/2607.01071) | Those measure *reasoning* over fixed memory at answer time. `false_apply` measures whether a **write-path mutation** occurred after an anti-event (quoting-others / hypothetical / third-party-correction), detected behaviorally via a `shouldNotAppear` token. Taxonomy mirrors [#1581](https://github.com/joshuaswarren/remnic/issues/1581). |
| `reassertion` | ↑ | *None found* — no prior benchmark scores the revocation path (user re-asserts an earlier value after a correction) | **New** | First metric for the "actually, we went back to X" path: after a correction and a re-assertion event, is the original value recallable again? Without it, a system could trivially maximize `non_resurrection` by never un-retiring. |
| `provenance_fidelity` | ↑ | *None found as a correction metric* — provenance is discussed (Zep/Graphiti edges carry validity intervals) but not scored as "corrected state *cites the correction event*" | **New** (n/a for systems without provenance) | First metric tying correction to citation: corrected state must surface the correction event as its provenance source. Returns `null` for adapters that expose no provenance (`metrics.ts`). Backed by Remnic provenance [#1575](https://github.com/joshuaswarren/remnic/issues/1575). |

Source for metric definitions and directionality:
`docs/benchmarks/memcorrect.md` (Table under "Metrics") and the implementation in
`packages/bench/src/benchmarks/remnic/memcorrect/{metrics.ts,runner.ts,schema.ts,types.ts}`.

### Table 2 — Axis comparison: MemCorrect vs. the closest correction/staleness benchmarks

Axes are the behaviors MemCorrect combines. "—" = the benchmark does not target that
behavior (some may surface it incidentally as a failure class without scoring it).

| Benchmark | Correction uptake timed? | Non-resurrection under **re-ingest**? | Collateral safety? | Scope precision (multi-tenant twin)? | Write-path false-apply? | Revocation / re-assertion? | Provenance of correction? | System-agnostic adapter contract? | Deterministic synthetic corpus? | Peer-reviewed? |
|---|---|---|---|---|---|---|---|---|---|---|
| **MemCorrect** (this work, [#1584](https://github.com/joshuaswarren/remnic/issues/1584)) | ✅ `uptake_latency` | ✅ `non_resurrection` | ✅ `collateral_delta` | ✅ `scope_precision` | ✅ `false_apply` | ✅ `reassertion` | ✅ `provenance_fidelity` | ✅ `MemCorrectSystemAdapter` | ✅ seeded, hash-stable | — (artifact, not paper) |
| StateBench (Parslee) | — (snapshot accuracy) | ◐ SFRR (no re-ingest adversary) | — | ◐ "Scope Leak" class, no twin | — | — | — | ◐ MemoryStrategy plug-in (in-harness) | ✅ generated | ✗ vendor white paper |
| STALE [2605.06527](https://arxiv.org/abs/2605.06527) | — | ◐ State Resolution (no re-ingest) | — | — | ◐ Premise Resistance (read-time) | — | — | — | ✅ expert-validated | ✗ (preprint, May 2026) |
| MemSyco-Bench [2607.01071](https://arxiv.org/abs/2607.01071) | — | — | — | ◐ scope-respect task (read-time) | ◐ read-time only | — | — | — | ✅ | ✗ (preprint, Jul 2026) |
| MemStrata [2606.26511](https://arxiv.org/abs/2606.26511) | — | ◐ stale-fact-error vs RAG (no re-ingest) | — | — | — | — | ◐ bi-temporal ledger (not scored as correction-cite) | — (self-eval vs RAG) | ✅ calibrated | ✗ (preprint, Jun 2026) |
| MemoryAgentBench [2507.05257](https://arxiv.org/abs/2507.05257) | ◐ selective-forgetting snapshot | — | — | — | — | — | — | — | ✅ | ✅ (ICLR 2026) |
| LongMemEval [2410.10813](https://arxiv.org/abs/2410.10813) | ◐ knowledge-update category (answer-time) | — | — | — | — | — | — | — | ✅ curated chats | ✅ (ICLR 2025) |
| RippleEdits [2307.12976](https://arxiv.org/abs/2307.12976) | ◐ edit applied (weight surgery) | — | ✅ PV | ◐ RS (relation-level, not tenant) | — | — | — | — (weight editors) | ✅ 5K edits | ✅ (TACL 2024) |

Legend: ✅ = explicitly defined and scored; ◐ = conceptually present / adjacent but
not scored the same way; — = not targeted.

## 2.6 Summary of the contribution boundary

MemCorrect does not claim to be the first to observe that memories go stale, that
corrections must propagate, or that edits can damage unrelated facts — RippleEdits,
MQuAKE, TOFU/MUSE, StateBench, STALE, MemStrata, MemoryAgentBench, and LongMemEval
each own part of that observation. The contribution is the **protocol**: a single
system-agnostic adapter contract, a hermetic hash-stable corpus, and an eight-metric
bundle that, for the first time, scores correction *uptake latency*, adversarial
*non-resurrection under re-ingest*, *collateral* safety, *scope* precision across
namespaces, *write-path* false-apply, *revocation*, and *provenance* of the
correction event together. Of these, three (`uptake_at_next`, `non_resurrection`,
`collateral_delta`) are borrowed-and-attributed from named ancestors; two
(`scope_precision`, `false_apply`) are partly new; three (`uptake_latency`,
`reassertion`, `provenance_fidelity`) are, to our knowledge, new. The honest claim
is a **composition and protocol** claim, not a "first to measure memory correction"
claim.

---

### References

1. Cohen et al., "Evaluating the Ripple Effects of Knowledge Editing in Language
   Models," TACL 2024. arXiv:[2307.12976](https://arxiv.org/abs/2307.12976).
2. Zhong et al., "MQuAKE: Assessing Knowledge Editing in Language Models via
   Multi-Hop Questions," 2023. arXiv:[2305.14795](https://arxiv.org/abs/2305.14795).
3. Maini et al., "TOFU: A Task of Fictitious Unlearning for LLMs," 2024.
   arXiv:[2401.06121](https://arxiv.org/abs/2401.06121).
4. Shi et al., "MUSE: Machine Unlearning Six-Way Evaluation for Language Models,"
   ICML 2024. arXiv:[2407.06460](https://arxiv.org/abs/2407.06460).
5. Packer, Wooders, Lin, "MemGPT: Towards LLMs as Operating Systems," 2023.
   arXiv:[2310.08560](https://arxiv.org/abs/2310.08560).
6. Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive
   Memory," ICLR 2025. arXiv:[2410.10813](https://arxiv.org/abs/2410.10813).
7. Chhikara et al., "Mem0: Building Production-Ready AI Agents with Scalable
   Long-Term Memory," 2025. arXiv:[2504.19413](https://arxiv.org/abs/2504.19413).
   Docs: [docs.mem0.ai](https://docs.mem0.ai/).
8. Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent
   Memory," 2025. arXiv:[2501.13956](https://arxiv.org/abs/2501.13956).
   Graphiti: [github.com/getzep/graphiti](https://github.com/getzep/graphiti).
9. Hu, Wang, McAuley, "Evaluating Memory in LLM Agents via Incremental Multi-Turn
   Interactions" (MemoryAgentBench), ICLR 2026.
   arXiv:[2507.05257](https://arxiv.org/abs/2507.05257).
10. Chao et al., "STALE: Can LLM Agents Know When Their Memories Are No Longer
    Valid?," 2026. arXiv:[2605.06527](https://arxiv.org/abs/2605.06527).
11. Yadav, "Temporal Validity in Retrieval Memory: Eliminating Stale-Fact Errors for
    AI Agents over Evolving Knowledge" (MemStrata), 2026.
    arXiv:[2606.26511](https://arxiv.org/abs/2606.26511).
12. Xiang et al., "MemSyco-Bench: Benchmarking Sycophancy in Agent Memory," 2026.
    arXiv:[2607.01071](https://arxiv.org/abs/2607.01071).
13. Parslee / Liotta, "Beyond Conversation: A State-Based Context Architecture for
    Enterprise AI Agents" (2025) and "Memgine: A Deterministic Memory Engine for
    Stateful AI Agents" (2026). StateBench:
    [github.com/Parslee-ai/statebench](https://github.com/Parslee-ai/statebench).
    *(Vendor white papers; not peer-reviewed.)*
14. Microsoft Open Source, "Introducing STATE-Bench: A benchmark for AI agent
    memory," May 2026.
    [blog](https://opensource.microsoft.com/blog/2026/05/19/introducing-state-bench-a-benchmark-for-ai-agent-memory/).
    *(Distinct from Parslee's StateBench; cited only for disambiguation.)*

### In-repo sources cited

- `docs/benchmarks/memcorrect.md` — MemCorrect benchmark definition, metric table,
  adapter contract, sanity contract. Issue [#1584](https://github.com/joshuaswarren/remnic/issues/1584).
- `packages/bench/src/benchmarks/remnic/memcorrect/metrics.ts` — metric function
  definitions (`uptakeLatency`, `nonResurrection`, `collateralDelta`,
  `scopePrecision`, `falseApply`, `reassertion`, `provenanceFidelity`).
- `packages/bench/src/benchmarks/remnic/memcorrect/runner.ts` —
  `MemCorrectSystemAdapter` contract, `MEMCORRECT_LOWER_IS_BETTER`,
  multi-phase protocol including re-ingest + maintenance cycling.
- `packages/bench/src/benchmarks/remnic/memcorrect/generator.ts` — scoped-twin and
  re-assertion scenario generation (grounds `scope_precision`, `reassertion`).
- `packages/bench/src/leaderboard-export.ts` — `MemCorrectLeaderboardRow`.
- `docs/research/paper-mapping.md` — Remnic feature-to-concept-influence mapping.
- Glass-box epic [#1572](https://github.com/joshuaswarren/remnic/issues/1572):
  provenance [#1575](https://github.com/joshuaswarren/remnic/issues/1575)
  (`provenance.ts`), faithfulness [#1576](https://github.com/joshuaswarren/remnic/issues/1576)
  (`extraction-faithfulness.ts`), bi-temporal [#1578](https://github.com/joshuaswarren/remnic/issues/1578),
  tombstones [#1579](https://github.com/joshuaswarren/remnic/issues/1579)
  (`lifecycle/`), Correction Contract [#1580](https://github.com/joshuaswarren/remnic/issues/1580)
  (`correction/`), passive corrections [#1581](https://github.com/joshuaswarren/remnic/issues/1581),
  recall handles [#1582](https://github.com/joshuaswarren/remnic/issues/1582)
  (`recall-handles.ts`), chat [#1583](https://github.com/joshuaswarren/remnic/issues/1583)
  (`chat/`).
