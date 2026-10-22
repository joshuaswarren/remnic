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

## Corpus access attempt

These commands ran with the existing authentication state and one download worker:

```bash
RUN_ROOT=$(mktemp -d /tmp/remnic-frontiermemory.XXXXXX)
hf auth whoami
hf download letta-ai/frontier-memory-corpus --repo-type dataset \
  --local-dir "$RUN_ROOT/corpus" --max-workers 1
```

`hf auth whoami` returned `Not logged in`. The download obtained the README but then exited with `GatedRepoError: 401`. It reported that authenticated access was required. No sign-in or terms acceptance was attempted.

Inspection found zero trajectory files and no `SHA256SUMS`. The download progress counter did not represent 676 downloaded trajectories. Neither file checksums nor the expected corpus digest could be verified.

Once access exists, verify the manifest before ingestion:

```bash
cd "$RUN_ROOT/corpus"
printf '%s  %s\n' \
  c7d31214ed20af4f14f46c4b9a838ebc9aa35a9491dfbce0fa50f7aa456eedd1 \
  SHA256SUMS | sha256sum --check --strict
sha256sum --check --strict SHA256SUMS
```

Those checksum commands are planned and were not run against absent files. Also check the file count and PASS/FAIL totals against the card before extraction.

## Remnic source and isolated configuration

The smoke used core/server `10.0.7`, from main commit `4cd7e54c70e94b1899ead3cd95285c183ca8638a`. Node.js was `v22.23.1`; the workspace pins `pnpm@10.32.1`.

An isolated standalone daemon started from this worktree's source. Its config placed `memoryDir`, `workspaceDir`, and `oramaDbPath` under the temporary root. The child received a minimal environment, a separate local-only token, and isolated `HOME` and XDG directories. It bound only `127.0.0.1:14319`.

QMD was unavailable. The smoke used built-in Orama, which supports lexical search without an embedding provider. It did not use any existing QMD index. All recall scope, budget, result-count, planner, and deadline settings retained their defaults.

The smoke additionally set `modelSource: "plugin"`, `openaiApiKey: false`, `localLlmEnabled: false`, and `taskLlmFallback: false`. These prevent an empty startup test from using cloud or gateway fallback. No extraction model was configured because corpus access and local model probes failed. This is startup configuration, not a completed dream-stage configuration.

After writing that config, the source launch used this form:

```bash
env -i PATH=/usr/bin:/bin \
  HOME="$RUN_ROOT/home" XDG_CONFIG_HOME="$RUN_ROOT/config" \
  XDG_CACHE_HOME="$RUN_ROOT/cache" XDG_DATA_HOME="$RUN_ROOT/data" \
  REMNIC_AUTH_TOKEN="$SMOKE_TOKEN" \
  node --conditions=remnic-source --import tsx \
  packages/remnic-server/src/index.ts \
  --config "$RUN_ROOT/remnic.config.json" --host 127.0.0.1 --port 14319
```

The protected health request returned `ok: true`, `searchBackend: "orama"`, and QMD mode `not-selected`. It showed no pending turns and no extraction timestamp. The daemon then stopped. No production service, shared memory directory, external model router, or normal daemon-management command was used.

## Local model and dream-stage outcome

No standard local model service answered on the three tested standard ports. Two existing local development endpoints returned empty model lists. A four-token completion probe to each endpoint timed out after 10 seconds with no response bytes. No successful local completion or model identity was established. No new model server started.

The health field `llmReachable: true` was not accepted as proof of a working extraction model. The direct completion probes did not succeed.

The dream stage did not run. Corpus access is the first blocker. A successful local extraction route is also missing. If direct OpenAI extraction is selected instead, the exact missing variable is `OPENAI_API_KEY`, for the OpenAI provider. No cloud key was requested or retrieved.

| Measurement | Observed state |
| --- | --- |
| Trajectories downloaded and ingested | 0 and 0 |
| Extraction calls | 0 |
| Dream-stage time | Not measured; stage did not start |
| Dream input/output tokens | Not measured; stage did not start |
| Dream provider charge | $0.00 |
| Generated memories, corrections, entities | Unmeasured; no dream output |
| Empty smoke directory files: facts, corrections, entities | 0, 0, 0 |
| Task-agent memory export | Not produced |

The two local probe requests have no returned token usage. Do not report their usage as zero. Empty smoke directories are not a memory export and do not constitute benchmark results.

When access and a model become available, ingest every trajectory through Remnic's normal observe/extract path. Retain all user, assistant, and tool content plus the appended verifier message. Preserve trajectory boundaries, drain extraction, and record persistence failures before exporting. The format adapter is not implemented because no input trajectory could be read. Do not substitute manually written memories or reference-system dream output.

The intended handoff is the resulting memory folder or a supported export, with file counts and a local checksum. Keep its contents private or gated unless the benchmark authors permit publication. Record elapsed time, model identity, token usage, provider charge, and category counts. Use one worker initially and never exceed two.

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

No dream-stage provider charge was incurred. No downstream trial ran. Local probe token usage is unknown; no cloud model endpoint was called.

Letta reports a six-hour maximum for memory generation. That is a benchmark limit, not a measured Remnic runtime. For a serial 674-trajectory pass to finish inside six hours, the total average allowance is about 32 seconds per trajectory, including extraction and maintenance. Actual runtime cannot be estimated narrowly until representative extraction calls complete. No inference rate was measured here.

With a verified local model, provider API charges would be zero; local compute cost is not priced. For cloud extraction, price the measured input/output token totals at the selected provider's published rates. No token total or cloud dream-stage quote is available yet.

The release lists mean downstream task costs of $0.77 and $2.80 for two Letta configurations, excluding dreaming. As a rough task-only estimate, 15 trials at those means cost $11.55 to $42.00. A matched Remnic/no-memory pair across 15 tasks costs an estimated $23.10 to $84.00. Generation, embeddings, sandboxes, reference reruns, and retries add cost. These figures are published-cost arithmetic, not observed Remnic prices.

For scheduling only, a 5-to-30-minute trial assumption gives 2.5 to 15 hours for 30 serial matched trials. Including the full allowed dream window gives 8.5 to 21 hours, excluding setup. This is an explicit planning assumption; no downstream runtime was measured. Task-specific estimates require Letta's manifests and a measured trial.

Keep [draft PR #3212](https://github.com/joshuaswarren/remnic/pull/3212) draft. Do not self-merge or mark it ready.
