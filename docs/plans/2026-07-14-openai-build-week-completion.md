# OpenAI Build Week 2026 completion plan

Status: active
Owner: Joshua Warren
Competition deadline: July 21, 2026 at 5:00 PM PT
Track: Developer Tools
Submission: MemCorrect / Remnic Bench

## Outcome

Ship a judge-runnable, one-command memory evaluation product whose in-window
contribution is unmistakable: a generic MCP memory adapter, GPT-5.6 grading
through the OpenAI Responses API, a deterministic offline report card, a
provenance-locked GPT-5.6 benchmark run, and a five-minute installation/demo
path. Close the remaining repository backlog in dependency order after the
submission-critical path is safe.

Remnic predates the submission window. Judges evaluate only meaningful work
added after July 13, so every submission claim must point to an in-window Codex
session, dated commit, test receipt, or committed benchmark artifact.

## Competition acceptance contract

- Submit by July 21 at 5:00 PM PT in the Developer Tools category.
- Demonstrate a working, non-trivial product built with Codex and GPT-5.6.
- Keep the public demo video below three minutes; audio must explain how Codex
  and GPT-5.6 were used.
- Provide a repository, English description, installation instructions,
  supported platforms, a judge-test path that requires no rebuild, and the
  `/feedback` Codex session ID for the main implementation thread.
- Document the prior-work/in-window boundary in `HACKATHON.md` and the README.
- Optimize equally for technological implementation, coherent design,
  credible impact, and idea quality.

## Product and claim decisions

1. Enter as **MemCorrect: benchmark any AI agent memory** in Developer Tools.
2. Lead with correction acceptance and stale-memory harm, not generic recall.
3. Claim compatibility with **conforming MCP memory servers through explicit
   tool mapping**. Do not name arbitrary backends as supported until their MCP
   surfaces pass conformance.
4. The judge/demo path must exercise `--adapter mcp`; the current plain quick
   run demonstrates mostly pre-existing work and is insufficient evidence of
   the Build Week delta.
5. Package a deterministic demo MCP server or fixture that supports a cold,
   keyless, networkless judge run.
6. Resolve #1871 provenance before spending credits: use the raw Responses API
   for a reproducible Tier-F artifact, or label a Codex CLI run as a
   research-harness result rather than a frontier headline. Never combine the
   two classifications.
7. Every metric in prose must grep back to a committed result and manifest.

## Delivery sequence

### Phase 0 — stabilize and preserve evidence

- [x] #1875: replace the TombstoneStore scheduling race with a deterministic
  inter-process handshake and stress the test repeatedly.
- [x] Create a current-main integration branch without modifying the stale
  `docs/hackathon-scope` branch whose work already merged in #1874.
- [ ] Record the final `/feedback` session ID and retain unsquashed in-window
  commits as competition evidence.

### Phase 1 — independent product surfaces

These three issues run in parallel with disjoint primary ownership.

- [x] #1869, MCP specialist, high reasoning: implement stdio and streamable
  HTTP transports, explicit/default tool mapping, conformance preflight,
  namespace isolation, failure-vs-empty result types, CLI wiring, and a
  packaged deterministic demo server. The demo command must produce a score
  through `--adapter mcp`.
- [x] #1870, OpenAI/provider specialist, high reasoning: implement a sibling
  Responses API provider with default `gpt-5.6`, schema-validated verdicts,
  versioned MemCorrect rubrics, retry/error categorization, safe telemetry,
  config plumbing, and run/manifest provenance.
- [x] #1872, product-design/export specialist, medium-high reasoning: extend
  the existing HTML export into one byte-deterministic offline report card
  with dimension context, correction spotlight, backend-unusable state, and
  provenance receipts. Reuse the existing publish path.

Integration checkpoint:

- [x] Review every diff and ensure agents did not cross package boundaries.
- [x] Run targeted tests for each surface, then `npm run preflight:quick`.
- [x] Run the MCP demo end to end and inspect the generated report card.
- [x] Commit the three tightly coupled bench surfaces as one integrated contract
  change; their shared CLI, result schema, and manifest plumbing make a split
  commit misleading even though implementation and adversarial review had
  separate owners.

### Phase 2 — measured evidence

- [ ] #1877: pin the judge calibration set and add a larger slice and/or
  bootstrap confidence interval before interpreting headline LLM-judge scores.
  Retain deterministic metrics and manually review a stratified sample.
- [ ] Decide and document #1871's provider/tier classification.
- [ ] Smoke GPT-5.6 end to end before a paid run.
- [ ] Run LongMemEval real profile and the full MemCorrect matrix with complete
  provider, harness, model, judge, rubric, isolation, cost, token, dataset,
  seed, argv, and git provenance.
- [ ] Commit redacted result artifacts and manifests; update prose only from
  those files.
- [ ] If credentials or credits block the full run, publish only a clearly
  labeled bounded result and remove every full-run claim from the submission.

### Phase 3 — judge experience and submission

- [ ] #1873: verify `npm pack`/tarball or released packages from a clean
  container or temporary prefix, with no repository checkout.
- [ ] Verify global install, MCP quick run, run listing, offline HTML export,
  and the missing-optional-bench install hint.
- [ ] Add README and bench README Build Week sections, supported platforms,
  exact judge commands, Codex collaboration narrative, and GPT-5.6 role.
- [ ] Finalize `HACKATHON.md` with commit/artifact/test receipts and session ID.
- [ ] Reconcile Devpost copy with shipped reality and delete unshipped claims.
- [ ] Write and rehearse a sub-three-minute demo script: stale-memory problem,
  MCP-backed run, correction/non-resurrection result, report card, receipts,
  and explicit Codex/GPT-5.6 voiceover.
- [ ] Run voice lint, license/privacy/secret audit, and final cold-path test.
- [ ] Submit Devpost entry; close #1868 only when every child has receipts.

## Remaining open-issue program

These issues are real scope, but they must not displace the July 21 submission
critical path unless they block a truthful claim.

### Measurement and retrieval hardening

1. #1879: diagnose full-profile LoCoMo interference with category joins and
   recall X-ray receipts before changing responder behavior.
2. #1878: add support-aware abstention, then rerun all 1,986 tasks and verify
   answerable categories stay within noise.
3. #1876: design the full cross-session temporal scenario matrix, implement
   event aggregation and ingest-time indexing, run entity hardening, and
   promote only a non-regressing artifact.
4. #1880: remove the accidental shell wrapper from the issue body, record the
   honest achievable ceiling, and open separate issues only for selected
   multi-session, supersession, or multi-hop work.

### Governance and paper closeout

5. #1883: choose and test a narrow manifest-only Dependabot exception, or
   document a supported Cursor configuration/admin policy without weakening
   human-authored PR gates.
6. #1725: reconcile its stale blockers (the referenced issues are closed),
   integrate artifact-backed results, complete operator-gated comparisons,
   assemble the paper, and submit to arXiv.

## Agent allocation and review policy

- Use one specialist agent per independent subsystem only after file ownership
  is clear. Adapter, provider, and renderer may proceed concurrently.
- Use high reasoning for protocol boundaries, provenance, state isolation,
  retrieval state machines, and CI concurrency; medium-high reasoning for
  deterministic UI/export and documentation verification.
- Agents return root cause/design notes, files changed, and exact verification
  output. The primary agent reviews all changes and runs integrated tests.
- No agent pushes or opens a PR during implementation. Preserve narrow commits
  and let the primary agent perform integration and review-gate sequencing.
- Batch findings by subsystem. Run `npm run preflight:quick` before any
  review-clean claim and `npm run test:entity-hardening` for listed hardening
  files.

## Verification gates

1. Targeted unit/integration tests for each issue.
2. `npm run preflight:quick` after every integrated batch.
3. Repeated TombstoneStore stress test after #1875.
4. MCP adapter conformance tests across at least two independently shaped fake
   tool surfaces before broad compatibility wording.
5. End-to-end packaged MCP quick run with a scored result.
6. Byte-identical HTML from identical input; offline browser inspection.
7. Mocked Responses API error, refusal, malformed verdict, retry, default model,
   and override tests; operator smoke kept separate from CI.
8. Artifact secret scan and provenance audit before committing benchmark data.
9. Clean-environment global/tarball installation and missing-package fallback.
10. Final source-to-claim audit across README, `HACKATHON.md`, Devpost copy,
    video script, results, and manifests.

## Risks and stop conditions

- Deadline risk: submission-critical issues outrank accuracy/paper work.
- External dependency risk: #1871 needs operator credentials/credits. Do not
  fabricate or extrapolate results if unavailable.
- Provenance risk: do not label CLI-mediated measurements as independently
  reproducible Tier-F results without resolving the policy conflict.
- Demo risk: a quick command that bypasses MCP does not prove the core feature.
- Integration risk: adapter, provider, and renderer touch adjacent schemas;
  integrate after contracts stabilize and rerun the full bench test surface.
- Claim risk: remove any feature, backend, score, or installation claim that
  the final cold-path audit cannot reproduce.
