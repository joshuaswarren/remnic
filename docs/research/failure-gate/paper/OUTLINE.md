# Paper outline and claims map

Working title: **When to Remember: A Preregistered Study of Failure-Memory
Delivery Timing in an LLM Coding Agent**

Scope discipline: the title, abstract, and claims describe ONE open-weight
model on synthetic TypeScript repair tasks under a registered protocol. No
claim generalizes across models, languages, or real repositories; the paper
offers the protocol and dataset as the generalization path.

Author: Joshua Warren (Warren Applied Labs). Single author.
Target: arXiv preprint, cs.AI primary, cs.SE cross-list. 10-12 pages plus
appendices.

## Claims map (every claim -> evidence -> section)

| # | Claim | Strength | Evidence | Section |
|---|---|---|---|---|
| C1 | The unassisted agent re-executed the known failed approach in 119 of 269 valid NO_MEMORY episodes (44.24%) — a descriptive, episode-level rate on this task set | Descriptive | R1 NO_MEMORY arm | 5.2 |
| C2 | Turn-start failure memory failed its registered compound support rule: repeated-failure benefit was positive but small (+4.81 pp [0.74, 10.00]), and the task-pass estimate favored matched SUCCESS wording (-6.30 pp [-15.56, +0.74], compound p 0.9393) — a mixed result, not a pure null | Confirmatory (REJECTED hypothesis) | R1 H6-content, 18 tasks | 5.1 |
| C3 | The identical fact delivered at the proposed action eliminated repetition of the known failure: +35.56 pp [16.67, 55.93], RRR 100%, p=0.0019 | Confirmatory (SUPPORTED) | R2 H6-timing, 18/18 tasks, PASS | 5.1 |
| C4 | The timing effect replicated across three measurements (pilot +37.78, R1 exploratory +38.04 on 17 complete tasks, R2 confirmatory +35.56) | Triangulation | pilot v10, R1, R2 | 5.1 |
| C5 | Removing repeated failures did not measurably improve task completion (+1.48 pp [0.00, 4.44], p 0.507) | Bounded null | R2 task-pass | 5.3 |
| C6 | With no matching trap present, the gate produced no detectable behavior change on steps (-0.026 [-0.063, +0.0037] vs +/-2 margin); the pass-rate containment question is UNRESOLVED (90% CI [-0.74, +2.22] pp vs an unresolvable +/-2 pp margin, miss by 0.22 pp) | Diagnostic, partly unresolved | R1 no-trap study | 5.4 |
| C7 | Hash-bound preregistration is workable for agent experiments and constrained interpretation: the first registration returned NOT_ESTIMABLE under its own zero-cut rule, and estimability was restored only by a second registration whose scoring rule was fixed before new data existed | Methodological | registrations 1-2, amendment log | 6-7 |

Non-claims (must be stated): no general-learning claim, no cross-model /
cross-language / real-repository claim, no overall agent-quality claim, no
claim that turn-start memory is useless for other purposes.

## Sections

### 1. Abstract (~200 words)
Problem -> design (preregistered, two registrations, hash-bound) -> C3 + C2
headline numbers -> C5 limit -> dataset+harness released.

### 2. Introduction (~1.5 pp)
- Agents with long-term memory re-encounter their own failures; memory
  systems today inject recalled context into the prompt preamble.
- Question: is delivery timing, not content, the binding constraint?
- Trap-task intuition: six classes of "attractive wrong fixes".
- Contributions list (C1-C7 condensed to 4 bullets: confirmatory timing
  result; content null with completion cost; preregistered protocol +
  released dataset/harness; honest bounds).

### 3. Related work (~1.5 pp)
(a) memory for LLM agents; (b) learning from failure/experience;
(c) position and instruction-placement effects; (d) coding agents and
benchmarks; (e) preregistration and statistical rigor in ML eval;
(f) runtime guardrails at tool time. One paragraph each, positioning:
prior memory work varies WHAT is stored and retrieved; we hold content
fixed and vary WHEN it lands, under a confirmatory design.

### 4. Method (~3 pp)
4.1 Task corpus: 30 synthetic TypeScript repair tasks, 6 trap classes x 5, each
    with executable functional contract + offline checker as oracle;
    similarity cap 0.40 within class; 3 variants per task; frozen splits
    (12 pilot / 18 main).
4.2 Two-episode protocol: episode 1 produces the frozen failure history
    and trap fingerprint; only episode 2 is scored.
4.3 Arms and matched-injection contracts (table): NO_MEMORY,
    TURN_START_FAILURE, TURN_START_SUCCESS, PRE_ACTION_FAILURE, BOTH;
    identical fact ID / citation hash / rendered token count for the
    timing pair; Jaccard and token-gap constraints for the content pair;
    advisory gate semantics (NO_MATCH / MATCH_WARN / fail-open).
4.4 Outcomes: repeatedFailure (fingerprint match AND checker proves the
    same failure class), taskPassed (checker PASS within all caps), steps.
4.5 Model and execution: qwen3.5:35b Q4_K_M, temp 0, pinned digest; exact
    caps (12 turns, 8 tool calls, 20,480 cumulative tokens, 600 s, 180 s
    request timeout); isolation per arm (worktree/memory/session); retry
    rule (five host/API retries then pause-on-exhaustion; a returned task
    result is never rerun). ERROR_FAIL_OPEN semantics: fail-open in host
    operation, but any such row is invalid (WAIT_RULE_FAULT) in the
    experiment; none occurred.
4.6 Statistical analysis: task-level means as the unit; 10,000-draw
    grouped percentile bootstrap (95% primaries, 90% no-trap); 10,000-draw
    paired sign-flip randomization tests; statistics seed 81; content
    compound p = max(repeatedFailureP, taskPassP); Holm family of two in
    R1, one in R2; support rules verbatim; pilot-simulated timing power
    0.8364 at 18 tasks.
4.7 Preregistration and registrations: rule v12 -> NOT_ESTIMABLE via
    zero-cut on one cap-driven unclassifiable check; registration 2
    (timing-only, new seeds, worst-case scoring for VAGUE_CHECK, pilot
    evidence transfer by hash with byte-identical replay). Amendment log
    summarized; full text in appendix.

### 5. Results (~2.5 pp)
5.1 Main table: R2 confirmatory timing row + R1 confirmatory content row
    + R1 exploratory timing row, clearly labeled. Figure: paired
    task-level repetition rates (18 lines, two arms).
5.2 Descriptive arm outcomes (5-arm table from R1, 2-arm from R2).
5.3 Completion analysis: C5; pass rates low everywhere under binding caps.
5.4 No-trap diagnostic: C6, stated with the unresolved pass-rate margin.
5.5 Cost: 56.1M tokens total across registrations (43.4M + 12.7M);
    zero-model-call analysis replay.

### 6. Threats to validity (~1 pp)
Construct (synthetic traps; repeatedFailure definition is conservative:
fingerprint AND class match), internal (isolation, frozen history,
identical rendered tokens; the abandoned manifest and why it cannot bias),
statistical (task-level clustering, exact tests, zero-cut rule), external
(single model/quant/language; caps bind completion; contamination note for
the released dataset).

### 7. Discussion (~1 pp)
- Interpretation: proximity to the decision point dominates; consistent
  with position/recency effects but we did not isolate mechanism —
  candidate explanations (attention decay over distance, competition with
  task context, salience at proposal time), explicitly flagged as
  post-hoc.
- Design implication: memory systems should route failure memories to a
  just-in-time advisory delivered against the proposed action, not the
  preamble; success/semantic context can stay at turn start.
- Methodological lesson: preregistration is feasible for agent research
  and binds (our first registration died on its own rule; the fix was
  registered before new data).

### 8. Reproducibility and data availability (~0.5 pp)
- Dataset on HuggingFace (with contamination canary) and harness branch
  published BEFORE the draft is finalized; the paper states only releases
  that exist at submission time, with URLs verified.
- Registrations, decision rules, statistics, and hashes; operator-local
  raw bundles with published SHA-256 receipts; byte-identical replay
  command, INCLUDING the disclosure that the rerun replay executed under a
  newer harness (harnessProvenanceMatchesRun=false) with the decision
  artifacts untouched and the statistics reproduced byte-for-byte.

### Appendices
A. Trap class definitions with one worked example (task text, trap,
   correct fix, checker contract).
B. Injection payload templates (turn-start frame vs gate advisory frame).
C. Amendment log (2, 3, 4) and registration-2 change list, verbatim-close.
D. Full statistics tables incl. no-trap; per-task paired rates.
E. Harness integrity: manifest/hash chain, replay receipts.

## Style rules for the draft
- Plain declarative sentences; no hedging stacks; numbers with intervals.
- Every empirical number from FACTS.md only (derived totals added to
  FACTS.md first); editorial estimates (page counts) exempt.
- "We" = the author; first person singular acceptable in discussion.
- No banned-list AI slop terms; passes voice lint report mode.
- Claims C1-C7 appear verbatim-close; nothing stronger anywhere.
