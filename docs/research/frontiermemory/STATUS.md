# FrontierMemory 1.0 status

The dream stage is blocked by gated corpus access and an unverified local extraction model. Downstream scoring also requires Letta's task environments and verifiers. No task score exists.

- Draft PR: [#3212](https://github.com/joshuaswarren/remnic/pull/3212), on `docs/frontiermemory-1-0`.
- Previous draft: [#3211](https://github.com/joshuaswarren/remnic/pull/3211), closed as superseded without merging.
- Plan: [eval-plan.md](eval-plan.md).
- Results: [Markdown](results-2026-10-22.md) and [JSON](results-2026-10-22.json).

## Corpus access and verification

`hf auth whoami` returned `Not logged in`. A one-worker `hf download` attempt returned `GatedRepoError: 401`. It downloaded the README only: zero trajectory files and no `SHA256SUMS` were present. No login or terms acceptance was attempted.

The card describes 674 trajectories, with 184 pass and 490 fail. The expected manifest digest is:

```text
c7d31214ed20af4f14f46c4b9a838ebc9aa35a9491dfbce0fa50f7aa456eedd1
```

The digest and file checksums remain **unverified**. No corpus file, canary, or generated memory content was committed. Reserved in-repository corpus and memory paths are ignored; the attempt used temporary storage outside the checkout.

## Isolated daemon and dream output

A separate source daemon started on a non-default loopback port with temporary memory, workspace, and Orama paths. The authenticated health request returned `ok: true`, `searchBackend: orama`, no pending turns, and no extraction timestamp. The daemon stopped after the smoke check.

Two existing local development endpoints returned empty model lists. Both four-token completion probes timed out after 10 seconds with no response. No new model server started. Local probe token usage is unavailable.

| Dream measurement | Result |
| --- | --- |
| Trajectories ingested | 0 of 674 |
| Extraction calls | 0 |
| Dream runtime and token use | Not measured; dream stage did not start |
| Generated memories, corrections, entities | Unmeasured; no dream output |
| Empty smoke directory counts | 0 facts, 0 corrections, 0 entities |
| Task-agent memory export | Not produced |
| Dream provider charge | $0.00 |

No production daemon, shared memory, shared QMD index, or fleet model router was used. If direct OpenAI extraction replaces the unavailable local route, it requires `OPENAI_API_KEY` for the OpenAI provider. That variable is absent. No key was requested or retrieved.

## Downstream scores and remaining requirements

All 15 Remnic and no-memory task rows remain `not_run`, with `null` scores. The published 13.3% to 73.3% range is external reference data; it does not rank this run.

The [plan](eval-plan.md) records the two-stage design, public source-task references, all named board baselines, and cost assumptions. A full evaluation needs gated corpus access, verified checksums, a working extractor, and Letta's scoring access or a submission. No contact message was sent.

The dream limit is six hours; no Remnic dream runtime was measured. Published task-cost means give a provisional $23.10 to $84.00 for 15 matched Remnic/no-memory pairs, before dream generation and other costs. These are estimates, not charges incurred.

## Publication checks

The branch-shape check accepts `docs/frontiermemory-1-0`. `npm run check:pre-push` passed all cheap CI gates after the rename. The push published the branch, but shared git-config locking prevented upstream-tracking setup. No lock was removed or check bypassed.

Keep the PR draft. Do not self-merge or mark it ready.
