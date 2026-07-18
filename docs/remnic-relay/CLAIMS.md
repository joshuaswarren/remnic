# Remnic Relay claim ledger

This ledger is the boundary between what the submission can demonstrate and
what it would merely like to imply. Product copy, screenshots, narration, and
Devpost text should use the claim column or a narrower paraphrase.

Canonical evidence root:
`69d6f7f30d5603bcf514cea657aeb2a9bf1b6ff8b6712d5cfce6b5c33aae30be`.
Run `node scripts/relay/judge-package.mjs verify` to re-evaluate the mappings
below without package-manager lifecycle hooks.

## Product and technical claims

| Claim safe to make | Evidence | Required caveat |
| --- | --- | --- |
| Relay exposes disagreement, gates a correction on human approval, retires stale memory, propagates the replacement to a cold agent, and proves outcome recovery. | `recordings/.../events.json`, `correction.json`, `approval.json`, both memory records, `mission-receipt.json`; semantic checks in `scripts/relay/judge-package.mjs`. | Demonstrated in one sealed synthetic checkout-token mission, not a universal guarantee for every agent task. |
| The same hidden contract changed from failed to passed. | `recordings/.../tests.json`; executable hidden test in `fixtures/remnic-relay/hidden/token-policy.hidden.test.mjs`; verifier checks phase, status, and exit code. | This is a purpose-built synthetic contract test, not a production incident or broad benchmark score. |
| GPT-5.6 was load-bearing in the product demonstration. | Four `calls/*.json` artifacts retain model `gpt-5.6-terra`, role, thread, prompt/output hashes, usage, and structured output; `recording.json` fixes role order; verifier rebinds each artifact. | The replay itself makes no model call. Terra is a Codex CLI catalog alias; do not rewrite it as an API model ID. |
| Four one-shot Codex calls used four distinct threads. | `recording.json.threadIds`, each `calls/*.json.summary.threadId`, distinctness check in the judge verifier. | A thread ID proves call separation, not independent authorship or independent random sampling. |
| A transcript-free cold Builder recalled the approved replacement and not the stale decision. | Cold Builder `recallReceipt.sessionKey` is `relay:builder-cold:transcript-free`; replacement memory ID is bound across recall, output, propagation events, and receipt; `staleDecisionAbsent` is required. | “Cold” means a new Codex thread with no prior-role transcript in this runner. It does not mean an empty filesystem or no task prompt. |
| The recorded mission completed in 84.829 seconds. | Difference between first and last sealed event timestamps, recomputed by `judge-package.mjs`. | Mission event wall time; not an average, latency SLA, or end-user benchmark. |
| The mission used 5.8096 locally accounted Codex credit units. | Per-call token usage in `calls/*.json`; `credit-receipt.json`; independent Terra-rate recomputation using integer nanounits. | Harness accounting, not a machine-readable OpenAI account-balance statement or invoice. No claim about total account charges. |
| The runner bounded the run to GPT-5.6 Terra, medium reasoning, four calls, no Sol, and a 2,473-unit account cap policy. | `preflight.json`, `recording.json`, `credit-receipt.json`, runner constants/tests. | A prior rejected alias attempt was conservatively quarantined as 300 uncertain units, so the recorded effective policy budget was 2,173; the reserve is not spend. |
| Replay requires zero credentials, runtime dependencies, model calls, or external calls. | Node-built-in-only `judge-package.mjs`; loopback allow-list server; clean-room copy has no `node_modules`; clean-room server fetch checks; receipt reports `externalCalls: 0`. | The repository must already be available and Node installed. Cloning the repository is outside the replay call count. |
| The package is integrity-checked and tamper-evident. | SHA-256 per-file recording manifest, pinned recording and five-file UI roots, independently recomputed mission-receipt digest, prompt/output hashes, fixture root, UI/event binding, and coordinated-reseal plus hand-edited-frame rejection tests. | Do not call it cryptographically signed, immutable, independently notarized, or tamper-proof. The roots are reviewed and pinned in source. |
| Only synthetic Relay fixtures were used; the runner did not read production Remnic data. | Fresh run directories, isolated Remnic harness/namespace, fixture manifest, `preflight.productionDataRead: false`, recording privacy receipt, path/credential boundary tests. | This is a code-and-receipt-backed claim about the Relay runner. It is not an external privacy audit of the host machine. |
| No raw prompts, transcripts, Codex JSONL, credentials, production memories, or private ledgers are committed in the recording. | Recording manifest exact file allow-list; recording sanitizer; judge package secret/private-path scan; retained artifacts contain hashes and structured summaries. | Committed fixture prompt files are synthetic role instructions and are intentionally public; “no raw prompts” refers to captured live prompt/transcript logs. |
| The video script is under three minutes. | `DEMO-SCRIPT.md` measured block; verifier counts 326 words, 135 seconds at 145 wpm plus 30-second interaction allowance = 165 seconds. | The final recording still must be checked after editing; judges may stop at three minutes. |

## Novelty and impact language

Safe positioning:

> Remnic Relay is memory that can heal an agent team: an inspectable,
> human-governed correction protocol that carries an approved decision into a
> transcript-free cold agent and proves the downstream behavior recovered.

This is a product/architecture claim about the submitted composition. Do not
claim that Relay is the first agent-memory system, the first correction
protocol, or proven to eliminate stale-memory failures. The credible impact
claim is narrower: long-running coding-agent teams need shared decisions that
can be inspected, corrected, and verified across fresh sessions, and Relay
demonstrates that loop end to end.

## Build Week provenance

Remnic existed before the July 13, 2026 submission window. Judges should
evaluate only the new Relay extension:

| Scope | Evidence |
| --- | --- |
| Pre-existing | Remnic core memory storage, retrieval, governance, host adapters, benchmark framework, and general admin console; history before 2026-07-13. |
| New: Relay evidence contract/API | Issue #1966, PR #1970, merge `98e83cc1` on 2026-07-17; versioned events, reducer, append-only store, receipt, access/HTTP surface. |
| New: Mission Control | Issue #1967, PR #1972, merge `34f1f1bb` on 2026-07-17; dedicated conflict/lineage/approval/cold-start product surface and browser audit. |
| New: isolated live mission | Issue #1968, PR #1999, merge `a236ad07` on 2026-07-18, with dated commits beginning `386aa5f3` on 2026-07-17; bounded Codex CLI runner, synthetic harness, isolation, live GPT-5.6 recording, replay binding. |
| New: judge package | Issue #1969, PR #2012; dependency-free verifier/server, clean-room smoke, claims ledger, demo script, Devpost copy, and refreshed captures. The linked PR retains its current-head review and merge record. |

The required Codex `/feedback` session ID is intentionally left to the user,
who must select the real primary project thread before submitting. Dated Git
history and PR review history remain additional in-window evidence.

## License and third-party assets

- Repository code is offered under the root [MIT license](../../LICENSE).
- The judge server/verifier uses only Node.js built-in modules; it adds no
  runtime package or SDK.
- Mission Control HTML/CSS/JavaScript and screenshots are project-owned. It
  embeds no external font, image, icon library, music, video, or analytics.
- The synthetic checkout fixture was authored for Relay and contains no
  benchmark dataset or third-party content.
- Codex, OpenAI, and GPT-5.6 names are used textually to identify the required
  tools and recorded model; no third-party logo asset is bundled.

## Final operator checks

Before submission, the user should confirm that the final video matches this
ledger, add the real `/feedback` session ID, verify the YouTube upload is public
with audio and under three minutes, and submit before July 21, 2026 at 5:00 PM
PDT. Those actions are deliberately outside repository automation.
