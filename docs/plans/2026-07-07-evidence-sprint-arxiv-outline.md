# Evidence Sprint — arXiv Paper Outline, Benchmark Methodology & Eval Rubrics

**Created:** 2026-07-07 · **Owner:** Joshua Warren · **Horizon:** Q3 2026 (July benchmarks → August paper → September visibility)

**Alignment (read first).** This plan builds on epic **#1572 "Glass-Box Memory"** and does **not** redo finished work. Already DONE and cited, not re-run: W0 benchmark lab (#1573, #1574 — the RTX-3090 Tier-L harness + runtime profile; note the committed `docs/benchmarks/results/` currently holds only the `2026-04-20-*-mock000.json` placeholders, so producing and committing a real Tier-L/Tier-F artifact is still an open sprint task, not done), W1 accuracy flywheel (#1575–1579, #1539), W2 correction loop (#1580–1584, incl. **MemCorrect v1** in `packages/bench/src/benchmarks/remnic/memcorrect/`), W3 model lab (#1585). The harness (`@remnic/bench`), the 9-benchmark registry (`docs/benchmarks/sota-readiness.md`), `BenchmarkArtifact v1`, repro manifests, and judge cache all exist. This document adds the four things that genuinely don't exist yet: **(1) the paper outline, (2) a frontier-tier (Tier-F) run, (3) third-party Mem0/Zep/Letta adapters, and (4) the honest-framing decision.** Seeds to lift, not rewrite: `docs/benchmarks/memcorrect.md`, `docs/benchmarks/sota-readiness.md`, `docs/research/paper-mapping.md`, `docs/plans/2026-07-03-glass-box-memory-sota-plan.md`.

---

## Part 1 — The Paper (arXiv outline)

**Working title:** *Glass-Box Memory: Correctable, Provenance-Tracked Memory for User-Aware Agents.*

**Thesis / what's new (the paper must not overclaim raw accuracy — it leads with these three):**
1. **MemCorrect** — a system-agnostic benchmark for *memory correction and steerability*. **Novelty is a composition/protocol claim, NOT "first to measure correction"** — StateBench, STALE, MemSyco-Bench, MemStrata, and MemoryAgentBench's FactConsolidation each already test a slice, several published in the last ~60 days (see the Novelty findings section at the bottom). Headline it honestly as *the first benchmark to evaluate agent-memory correction as an end-to-end, system-agnostic protocol* combining adversarial non-resurrection + collateral safety + namespace-scoped precision + write-path false-apply + revocation in one deterministic, adapter-scoreable corpus.
2. **Reproducible on consumer hardware** — a two-tier (local RTX 3090 / frontier) protocol with committed repro manifests, so results are independently reproducible on one GPU — a reproducibility posture few if any competitors match (StateBench ships a deterministic corpus, but as a vendor white paper, not an independently-rerunnable consumer-hardware leaderboard).
3. **Glass-box trust** — provenance spans, a faithfulness gate, TrustScore, and bi-temporal validity make recalls explainable and auditable, positioned against documented time-sensitive-memory failures in closed systems.

**Section-by-section outline:**
- **1. Introduction** — the agent-memory problem; why *correction* and *explainability*, not just recall accuracy, are the unsolved parts; contributions list (MemCorrect, glass-box mechanisms, reproducible protocol, results).
- **2. Related Work** — seed directly from `docs/research/paper-mapping.md` (Memory-OS, HiMem, SwiftMem, TiMem, MAGMA/SYNAPSE, MemoryOS, ACON…) and the competitor landscape (Mem0, Zep, Letta). Position on the axes competitors ignore: correction, provenance, faithfulness.
- **3. System — Glass-Box Memory** — three-tier retrieval; provenance spans (#1575); faithfulness gate (#1576); TrustScore (#1577, the 8-factor trust signal); Correction Contract + passive correction detection + memory handles `[m:xxxx]` (#1580–1583); bi-temporal validity + tombstones/non-resurrection (#1578–1579).
- **4. MemCorrect Benchmark** — the field-first contribution. Task construction (deterministic synthetic corpus generator), the `MemCorrectSystemAdapter` interface, and the 8 metrics: uptake_at_next, uptake_latency, non_resurrection, collateral_delta, scope_precision, false_apply, reassertion, provenance_fidelity. Lift methodology from `docs/benchmarks/memcorrect.md`.
- **5. Experimental Setup** — two-tier protocol (Tier L local / Tier F frontier), runtime profiles (`runtime-profiles.ts`), judge cache + Cohen's-kappa cross-tier calibration, repro manifests, seed/version pinning. Lift from `docs/benchmarks/sota-readiness.md`.
- **6. Results** — (a) MemCorrect: Remnic vs baselines vs third-party adapters; (b) LoCoMo/LongMemEval standard suite at **Tier F** for the head-to-head vs Mem0/Zep, with Tier-L reported as the reproducibility anchor; (c) TrustScore/faithfulness behavior.
- **7. Ablations** — single-flag ablations (Memory Worth multiplier, contradiction scan, graph recall) from #1574; the #1708 bounded-memory contract ablation (raw transcript vs typed retrieval vs skill-triggered).
- **8. Limitations & Honest Framing** — Tier-L 7B-local numbers are modest and are *not* the accuracy claim; local-judge calibration caveats; synthetic-corpus limits of MemCorrect v1.
- **9. Conclusion & Reproducibility** — the reproducibility appendix (repro-manifest, model-lab manifests, one-GPU instructions).

---

## Part 2 — Benchmark Methodology (what to document vs. what to build)

**Document (lift from existing, minimal new writing):** the two-tier protocol, `BenchmarkArtifact v1` schema, `results-store.ts`/`repro-manifest.ts`, judge cache, the 9 published-benchmark registry with leaderboard-safety guards, and MemCorrect's construction. These are written already in `docs/benchmarks/*` — the paper's methodology section is largely an adaptation, not new research.

**Build (the real gaps):**
- **A real benchmark run at all.** The committed results are only `2026-04-20-*-mock000.json` placeholders — no real Tier-L *or* Tier-F artifact exists yet. The Tier-F run (Opus 4.8 via `claude -p` responder + local 3090 judge — see the Update section) produces the head-to-head numbers and closes the `judgeCalibration` (Cohen's kappa) gap noted in PR #1709; run it isolated and session-limit-aware.
- **Third-party adapters.** `MemCorrectSystemAdapter` is a public interface with only in-tree adapters (`PromptOnlyBaselineAdapter`, `createRemnicMemCorrectAdapter`). Implement **Mem0, Zep, Letta** adapters — the single highest-leverage missing piece for any "we beat X" claim.
- **Reproduce competitor claims.** Current Mem0 (LoCoMo 91.6%) and Zep (+18.5% LongMemEval) figures are their self-reported numbers cited from issue text, not reproduced by our harness. Reproduce them (or clearly mark as cited-not-reproduced).

---

## Part 3 — Eval Rubrics

**Metrics in play (already implemented):** LoCoMo/LongMemEval standard suite (`contains_answer`, `f1`, `llm_judge`, `rouge_l`, `leak`, `judge_accuracy`, `search_hits`); the 8 MemCorrect metrics; TrustScore (8-factor).

**"A result is publishable" acceptance rubric (the gate every artifact must pass before it enters the paper or a public post):**
1. **Non-mock.** Real artifact in `docs/benchmarks/results/`, not a `*-mock000.json` placeholder.
2. **Repro manifest present** — seed, model + quant, context window, dataset version, runtime profile all pinned.
3. **Judge calibration reported** — Cohen's kappa cross-tier where a judge is used (the #1709 gap must be closed for Tier-F).
4. **Honest framing attached** — a one-paragraph "what this number is and isn't" (e.g. Tier-L = 7B local, non-thinking; note the qwen3 truncation + ollama context-default gotchas already documented).
5. **Leaderboard-safety** — explicit-cue-recall guards respected (per #841–#850); no train/test leakage.
6. **Reproducible on one GPU** — the RTX 3090 path is documented and re-runnable.

This rubric is the benchmark-side analogue of the vault's *Definition of Shippable* content gate — cheap models can self-apply it before a number is published.

---

## Part 4 — Execution plan (epic + child issues, Joshua's proven format)

**Epic: "Evidence Sprint — arXiv paper (Q3)."** Children, in dependency order:

1. **Paper skeleton in-repo** (`docs/paper/` or `.tex`) — instantiate the Part-1 outline as the working draft. *(Fable-worthy: framing.)*
2. **Third-party MemCorrect adapters — Mem0, Zep, Letta** (`MemCorrectSystemAdapter`). *(Fleet: implementation. Highest leverage.)*
3. **Tier-F run** — LoCoMo + LongMemEval with **Opus 4.8 via `claude -p`** as responder and the **local 3090 as judge** (no API budget/credential; see the Update section); calibrate the local judge against a small Opus-judged slice for the kappa. *(Fleet: run, isolated + session-limit-aware.)*
4. **Head-to-head reproduction** — reproduce or cite-with-caveat Mem0/Zep published numbers via our harness. *(Fleet.)*
5. **Ablation data** — confirm/produce the #1574 single-flag ablations; coordinate **#1708** bounded-memory ablation as a paper section (don't duplicate — it's open and unclaimed). *(Fleet.)*
6. **Related Work draft** from `docs/research/paper-mapping.md`. *(Fable-worthy.)*
7. **Figures** — LoCoMo/LongMemEval chart vs Mem0/Zep/Letta; MemCorrect metric bars; TrustScore illustration. *(Fleet, using dataviz standards.)*
8. **Reproducibility appendix** — repro-manifest + model-lab manifests + one-GPU instructions. *(Fleet.)*
9. **Publish cadence hook** — each drafted section ships as a Content Engine artifact (Pillar 1) as it lands, per the Q3 arc (July numbers → August paper sections → September visibility).

**Open decisions for Joshua:**
- **Lead framing:** MemCorrect (field-first) vs reproducible-consumer-hardware vs glass-box — recommend leading with **MemCorrect**, supported by the other two. Do NOT lead with raw Tier-L accuracy.
- **Tier-F is settled** (Opus via `claude -p` responder + local 3090 judge — see Update, no API credential needed). Remaining sub-choices: the exact local judge model and the size of the Opus-judged calibration slice.
- **Adapter scope** — all three competitors, or Mem0 first (most-cited) then Zep/Letta.

**Not to redo:** anything under W0–W3 (see Alignment). Coordinate with open issues #1708, #1700/#1717, #1712 rather than reimplementing.

---

## Update 2026-07-07 — Novelty & Tier-F findings (verified)

### Novelty verdict: novel-with-caveats (composition claim only)
A prior-art sweep (live web research, 2026-07-07) confirms MemCorrect is a **genuine but narrow** contribution. Do **not** claim "first to measure memory correction." Required related-work engagement (novelty depends on it):
- **StateBench** (Parslee, vendor white paper, not peer-reviewed) — the *closest* relative: a `MemoryStrategy` adapter interface, a deterministic SHA-256-verified synthetic corpus, and **SFRR** ≈ our `non_resurrection`. **Cite it explicitly and differentiate metric-by-metric** — if a reviewer/HN commenter finds it and the paper is silent, the novelty claim collapses.
- **STALE** (arXiv:2605.06527, ~May 2026) — closest *peer-reviewed* framing (state resolution / premise resistance / policy adaptation); best system 55.2% ⇒ the problem is unsolved (supports our motivation).
- **MemSyco-Bench** (arXiv:2607.01071) — sibling benchmark probing the *opposite* end of the pipeline (read-time sycophancy vs. our write-time correction) — a clean, citable axis split.
- **MemStrata / Temporal-Validity** (arXiv:2606.26511) — implements a non_resurrection-like metric, but self-eval vs. generic RAG only, no adapter contract.
- **MemoryAgentBench FactConsolidation** (arXiv:2507.05257) — single-snapshot correction-priority via MQuAKE edits; structurally closest to `uptake_at_next` alone.
- **Weight-editing ancestors** — RippleEdits (RS/PV → `collateral_delta`), MQuAKE, TOFU/MUSE. Cite as ancestors imported into a *different substrate* (retrieval/consolidation/GC) — this **strengthens** the claim.
- Genuinely new metrics to foreground: `uptake_latency`, `reassertion`, `provenance_fidelity`, the namespace-twin `scope_precision`, the anti-event `false_apply`. Borrowed (attribute): `collateral_delta`, `uptake_at_next`, `non_resurrection`.

**Required fix before publishing:** `docs/benchmarks/memcorrect.md:8` states LongMemEval's knowledge-update category is "near ceiling" — that's the paper's stated *motivation* and it is fact-checkably wrong (KU scores span ~70–90% by system). Soften to: *"KU only checks instantaneous answer correctness, not correction durability/collateral/scope."* This is the single most checkable claim in the doc.

### Tier-F responder: `claude -p` / Opus 4.8 IS the path (no API budget)
There is no budget for a raw-API frontier run, so the Tier-F responder **is** Opus 4.8 via Claude Code headless (`claude -p`), through the `claude-cli` bench provider. **That provider is delivered by PR #1735** (`feat/bench-claude-cli-provider`, modeled on `codex-cli.ts`) and is NOT yet on `main`, so the Tier-F run (#1728) is blocked on #1735 merging first — it is a hard dependency, not an assumed-present tool.
- **Label it honestly — don't hide it.** A `claude -p` number is "Opus 4.8 via Claude Code," NOT a raw-API `tier: "frontier"` result (Claude Code adds system-prompt scaffolding + model-alias routing, and it isn't reproducible without a Claude Code entitlement). **Do not invent a new `tier` value** — `BenchmarkArtifactTier` is `local|frontier` only and `parseBenchmarkArtifact()` rejects anything else. Label it via the artifact's `note` + model metadata (e.g. model `opus-4-8-via-claude-code`) while keeping `tier: "frontier"`, or land a schema+parser+test change first if a distinct tier is truly wanted. Stated plainly, this is defensible; presenting it *as* a raw-API number is the only thing that would sink credibility.
- **Isolation is mandatory.** Run `claude -p` from a freshly-created empty temp workspace with **`--tools ""`** (the flag that actually disables built-in tools; `--allowedTools` only gates permission prompts) and Claude Code's config-skipping **`--safe-mode`** (the Claude Code equivalent of Codex's `--ignore-user-config`), or it inherits `~/.claude/CLAUDE.md`/project settings and silently contaminates every answer. The delivered `claude-cli` provider (PR #1735) does exactly this — `--tools ""` + `--safe-mode` + isolated cwd + `--append-system-prompt` for the scoring protocol — all verified against the installed `claude` CLI.

### Fitting Claude Max x20 session limits (the real constraint)
A full run (~1986 LoCoMo + 500 LongMemEval ≈ 2486 responder calls, ×2 if the judge is also Opus) will blow the 5-hour/weekly caps. To fit:
1. **Judge on the local 3090, not Opus** — the single biggest lever; keeps Opus for the responder only (halves the `claude -p` load). Calibrate the local judge against a small Opus-judged sample (Cohen's kappa) so it stays defensible.
2. **Checkpoint + resume** — persist per-item results (`results-store.ts`/`repro-manifest.ts`) and skip completed items, so a run spans multiple 5-hour windows / days.
3. **Low concurrency + usage-limit backoff** — concurrency 1; detect the usage-limit message, sleep until the window resets, resume (built into the `claude-cli` adapter).
4. **Sample first** — a stratified 200–300-item pass gives publishable July numbers + method posts cheaply; scale to full once the pipeline is proven.
5. **Judge cache** (already in the harness) — never re-judge an identical answer.

Net: responder = Opus via `claude -p` (chunked across windows, resumable, isolated); judge = local 3090 (calibrated); start sampled, then full.

### Confirmed decisions (Joshua, 2026-07-07)
- **Lead with MemCorrect** — with the honest composition framing above.
- **Tier-F on Opus 4.8 via `claude -p`** (no API budget) — labeled via the artifact `note`/model metadata while keeping the supported `tier: "frontier"` (no invented tier value), never presented as a raw-API number; local 3090 as judge to fit Claude Max x20 session limits; checkpoint/resume + sampled-first.
- **Adapter order: Mem0 → Zep → Letta.**
- **Infra:** jarvis becomes the primary Remnic host (full Linux parity verified; a GPU upgrade); macstudio failover. See `homelab-infra/docs/fleet-macstudio-spof-and-failover.md`.
