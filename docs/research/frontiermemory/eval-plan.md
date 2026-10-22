# FrontierMemory 1.0 evaluation plan

## What the benchmark measures

[FrontierMemory](https://www.frontiermemory.com/blog/v1/) measures whether memory learned from prior agent work helps an agent finish new tasks. Its score is downstream full-pass rate, rather than recall accuracy or the number of memories written.

The design has two stages:

1. A memory system reads the supplied trajectories during the dream stage and produces a memory folder. Keep each appended `# Verifier result` message and its `PASS` or `FAIL` line.
2. A fixed task agent uses that folder to attempt 15 targets. The published model comparison uses Letta Code with Opus 5.5 or GPT-6 Sol. Harness comparisons also include each system's native task agent.

The published board reports the better full-pass rate of the two task models at maximum effort. Keep each task-model score separate in any submission. Do not compare a startup check or memory count with a downstream score.

## What is available

The [dream corpus card](https://huggingface.co/datasets/letta-ai/frontier-memory-corpus) describes 674 trajectories: 184 passing and 490 failing. Its files include 558 JSON and 116 JSONL trajectories. Public metadata identifies revision `67250357405072066498c061f9af0eccfdac20c0`.

The card defines the corpus digest as the SHA-256 of `SHA256SUMS`:

```text
c7d31214ed20af4f14f46c4b9a838ebc9aa35a9491dfbce0fa50f7aa456eedd1
```

Access is gated. The terms restrict use to evaluation and prohibit training, fine-tuning, or republication outside a gated repository. The data has a training canary. Do not copy the canary, trajectories, or derived memory contents into this public repository. The root `.gitignore` excludes reserved corpus and memory output directories. The actual attempt used a separate temporary directory outside the checkout.

The card links to a `letta-ai/frontier-memory` GitHub repository and tells users to install `frontier-memory` from it. No usable runner checkout was obtained. Task descriptions and board results are public, but the 15 adapted task environments, hidden filename mapping, and FrontierMemory verifiers were not obtained. The [submission page](https://frontiermemory.com/submit/) directs contributors to `research@letta.com`. No contact message was sent.

## Verified corpus download

The initial unauthenticated attempt failed with HTTP 401. An authenticated attempt remained gated with HTTP 403. Access was then granted outside this run. The successful download used the existing authentication state, pinned revision, and one worker:

```bash
hf download letta-ai/frontier-memory-corpus --repo-type dataset \
  --revision 67250357405072066498c061f9af0eccfdac20c0 \
  --local-dir "$RUN_ROOT/corpus" --max-workers 1
```

All 677 repository files downloaded. `sha256sum --check --strict SHA256SUMS` passed for all 674 trajectories. The manifest's SHA-256 matched the digest above. Independent parsing verified 184 PASS and 490 FAIL outcomes, including each terminal verifier message. The corpus contains 558 JSON and 116 JSONL trajectories, totaling 314,063,575 input bytes. Download wall time was 125.11 seconds.

Structural inspection exposed only field names, types, and counts. It found 537 ATIF `steps` documents, 21 `messages` documents, and 116 JSONL streams. No trajectory or canary content was printed or committed. This run performed no HF login, terms acceptance, upload, push, or repository creation.

The ingestion controller preserves the complete source text, including tool records and verifier lines. It splits oversized inputs into consecutive 400,000-character parts without omissions and appends the verified PASS/FAIL line to each part. Each part uses a distinct trajectory/part session key. The controller calls normal `observe`, then awaits `extractionForceFlush`. Input is historical source data, not instructions for the extractor.

The ingestion-only `extractionMaxTurnChars` setting is 450,000, above the maximum wrapped part length. This avoids the default 4,000-character truncation. Recall settings retain their defaults. Source grounding remains enabled. At most two subscription calls run concurrently, including auxiliary calls.


## Remnic source and isolated configuration

The smoke used core/server `10.0.7`, from main commit `4cd7e54c70e94b1899ead3cd95285c183ca8638a`. Node.js was `v22.23.1`; the workspace pins `pnpm@10.32.1`.

An isolated standalone daemon started from this worktree's source. Its config placed `memoryDir`, `workspaceDir`, and `oramaDbPath` under the temporary root. The child received a minimal environment, a separate local-only token, and isolated `HOME` and XDG directories. It bound only `127.0.0.1:14319`.

QMD was unavailable. The smoke used built-in Orama, which supports lexical search without an embedding provider. It did not use any existing QMD index. All recall scope, budget, result-count, planner, and deadline settings retained their defaults.

The initial startup-only smoke disabled every extractor. The current extraction configuration uses the subscription chain:

```json
{
  "modelSource": "gateway",
  "openaiApiKey": false,
  "localLlmEnabled": false,
  "taskModelChain": {
    "primary": "codex-subscription/gpt-6.1-sol"
  },
  "taskLlmTimeoutMs": 300000,
  "extractionMaxTurnChars": 450000,
  "extractionSourceGroundingEnabled": true
}
```

The direct Codex CLI runner failed a real request with `invalid_refresh_token`, despite a successful ChatGPT login-status check. A private eval adapter instead calls the pane's existing `openai-codex/gpt-6.1-sol` subscription through OMP. It registers on Remnic's existing `setCodexCliFallbackRunnerForProcess` seam before starting the standalone server. No core provider or persistent auth configuration was changed.

The adapter disables context-file providers, tools, LSP, extensions, skills, rules, session persistence, model fallback, context promotion, and compaction. It passes requests through stdin, accepts only the exact requested provider/model, and records usage without transcript content. It captures the completed assistant event before stopping the child. CLI linger after a completed response is not counted as a model timeout.

The request uses `--service-tier priority`. Upstream [Codex discussion](https://github.com/openai/codex/issues/32191) identifies `priority` as the Fast-mode request encoding, but also describes backend downgrades. OMP does not expose the effective backend tier here, so that field remains unverified. The adapter never claims verified Fast service.

The private corpus controller runs in this form:

```bash
node --conditions=remnic-source --import tsx \
  "$EVAL_SCRIPTS/cos400-corpus-dream.mjs" "$RUN_ROOT"
```

`EVAL_SCRIPTS` refers to private session artifacts, not a packaged repository command. The controller calls the real `startServer`, `service.observe`, and `service.extractionForceFlush` APIs. It creates fresh temporary state and stops the server afterward. It does not insert prewritten memories.

No API fallback was used: the pane-native subscription route returned real extraction JSON. The approved $20 API fallback remains conditional on failure of that route; no API key was requested, loaded, or billed.

## Subscription and dream-stage outcome

The earlier local-model probes failed and are historical diagnostics only. Local endpoints are now excluded from extraction.

Three synthetic normal-pipeline smokes completed subscription requests but failed the assertion that a fact had persisted:

| Smoke | Input tokens | Output tokens | Provider time, ms | Persisted facts |
| --- | ---: | ---: | ---: | ---: |
| Initial policy fixture | 3,014 | 947 | 28,254 | 0 |
| Concrete project policy | 3,015 | 995 | 30,274 | 0 |
| Boundary diagnostic | 3,018 | 964 | 24,613 | 0 |

These calls consumed 11,953 reported tokens in total. They used no corpus inputs and are not dream-stage results. The final diagnostic observed two facts and one entity after normalization and sanitization, then zero of each at finalization. Source grounding removed the candidates before persistence. That explains this smoke's empty store; it does not establish that every corpus trajectory would behave the same way. No grounding rule was disabled to force a pass.

Separate setup smokes covered the direct CLI auth failure, two context-inflated OMP attempts, a context-disabled JSON completion, and the private adapter itself. Some earlier diagnostics lack a complete usage record; the three-row table covers only independently recorded normal-pipeline calls and is not a total for all setup activity.

The real corpus dream stage started after integrity verification. Its aggregate progress and final measurements belong in [STATUS.md](STATUS.md) and the result exports. No downstream score exists.

The run retains grounding and records empty output as an actual result. It does not substitute the earlier synthetic failures for corpus measurements. The intended handoff is the resulting private memory folder, with counts and a local checksum. Its contents remain outside this repository.

## Published board baselines

These rates come from [Letta's release report](https://www.frontiermemory.com/blog/v1/). They were not reproduced locally.

| Memory harness | Opus pair | Sol pair |
| --- | ---: | ---: |
| Letta Dream | 73.3% | 60.0% |
| OpenAI Agents SDK | Not reported | 40.0% |
| Claude Managed Agents | 33.3% | Not reported |
| Hermes Agent | 26.7% | 20.0% |
| Prime Agent | 60.0% | 13.3% |

No Remnic or local no-memory score exists. All 15 downstream task rows remain `not_run` in the result export.

## Public source-task self-check

Two source tasks can be identified from public descriptions without the hidden trajectory mapping:

- [SkillsBench: dapt-intrusion-detection](https://www.skillsbench.ai/tasks/dapt-intrusion-detection), also available in its [public task directory](https://github.com/benchflow-ai/skillsbench/tree/main/tasks/dapt-intrusion-detection). Its DAPT2020 packet analysis matches the public network-analysis task family.
- [DeepSWE: awilix-async-container-initialization](https://deepswe.datacurve.ai/data/tasks/awilix-async-container-initialization). It requests dependency-aware async container initialization, matching the public Awilix task family.

These identify source families, not equivalence with FrontierMemory's adapted targets or repaired verifiers. No hidden mapping was reconstructed. No public source task was executed or used as a substitute score. Keep these pages out of dream and task-agent input.

## What a scored run needs

A scored run requires the verified corpus, a working extraction model, and the resulting memory export. It also requires Letta's runner/task/verifier access or a submission through the published contact route. The task agent must use the official fixed configuration and permitted inputs. Reproduce a matched no-memory condition with the same task model and effort.

Do not invent task commands, replacement verifiers, or numeric scores. The existing submission contact has not authorized any outbound message from this evaluation.

## Cost and runtime estimate

No metered API fallback or downstream trial ran. Corpus extraction uses Codex subscription quota. Dream-stage usage comes from completed provider events; partial failed requests can leave unreported usage.

Letta reports a six-hour maximum for memory generation. That is a benchmark limit, not a measured Remnic runtime. A serial 674-trajectory pass has an average allowance of about 32 seconds per trajectory within that limit. The earlier synthetic provider calls took 24.6 to 30.3 seconds each, but they do not estimate corpus throughput. Corpus runtime will be reported separately.

The selected route uses subscription quota, whose cost is not priced here. If that route becomes unusable, the approved metered API alternative requires a written reason and a hard $20 admission budget before any request. It must reserve each request's maximum input/output cost, include retries and maintenance calls, and reject work that would exceed the cap. That fallback was not activated.

The release lists mean downstream task costs of $0.77 and $2.80 for two Letta configurations, excluding dreaming. As a rough task-only estimate, 15 trials at those means cost $11.55 to $42.00. A matched Remnic/no-memory pair across 15 tasks costs an estimated $23.10 to $84.00. Generation, embeddings, sandboxes, reference reruns, and retries add cost. These figures are published-cost arithmetic, not observed Remnic prices.

For scheduling only, a 5-to-30-minute trial assumption gives 2.5 to 15 hours for 30 serial matched trials. Including the full allowed dream window gives 8.5 to 21 hours, excluding setup. This is an explicit planning assumption; no downstream runtime was measured. Task-specific estimates require Letta's manifests and a measured trial.

Keep [draft PR #3212](https://github.com/joshuaswarren/remnic/pull/3212) draft. Do not self-merge or mark it ready.
