# FrontierMemory 1.0 status

Corpus access still blocks the dream stage. The pane-native Codex subscription route returns extraction JSON. Three persistence smokes failed; no corpus run or memory export exists.

- Draft PR: [#3212](https://github.com/joshuaswarren/remnic/pull/3212), on `docs/frontiermemory-1-0`.
- Previous draft: [#3211](https://github.com/joshuaswarren/remnic/pull/3211), closed without merging.
- Plan: [eval-plan.md](eval-plan.md).
- Results: [Markdown](results-2026-10-22.md) and [JSON](results-2026-10-22.json).

## Corpus gate

The initial `hf auth whoami` returned `Not logged in`; the download returned `GatedRepoError: 401`. It obtained only the README, with zero trajectory files and no `SHA256SUMS`.

Authentication was later supplied outside this run, but dataset access still returned a reported HTTP 403 pending the gate. No new download will start before an access-granted notice. Authority is download-only. This run performed no HF upload, push, repository creation, login, or terms acceptance.

The card specifies 674 trajectories, including 184 pass and 490 fail. Those counts are not locally verified. The expected manifest digest remains unverified:

```text
c7d31214ed20af4f14f46c4b9a838ebc9aa35a9491dfbce0fa50f7aa456eedd1
```

## Extractor route

Remnic's built-in `codex-subscription` runner failed because the separate Codex CLI could not refresh its login (`invalid_refresh_token`). A private eval runner instead uses the pane's existing `openai-codex/gpt-6.1-sol` subscription through OMP. It does not inspect or copy auth material.

The runner disables context files, tools, extensions, skills, rules, sessions, model fallback, context promotion, and compaction. It requests `priority`, the Fast-mode request encoding discussed upstream. Effective backend tier is not reported and remains unverified.

The real standalone daemon used temporary memory/workspace/Orama paths and a non-default loopback port. The normal observe/extract/flush path completed subscription requests. No metered API fallback was used; the conditional $20 allowance was not activated. Local and fleet model endpoints are excluded from this route.

## Observed setup results

| Measurement | Observed result |
| --- | --- |
| Normal-pipeline synthetic requests | 3 |
| Reported input/output tokens | 9,047 / 2,906 |
| Reported total tokens | 11,953 |
| Provider time per request | 24.6 to 30.3 seconds |
| Persisted facts in each synthetic smoke | 0 |
| Persistence assertions | All 3 failed |

The final diagnostic observed two facts and one entity after normalization and sanitization, then zero of each at finalization. Source grounding removed those candidates. No grounding rule was disabled to force a pass. This result does not establish the outcome for real corpus trajectories.

Earlier setup probes and their failures appear in the plan. Some lack complete usage records. The table is not a total for all setup activity. All smoke inputs were synthetic; no corpus trajectory was used.

## Dream-stage and scoring status

Dream stage: **not run**. Trajectories ingested: **0 of 674**. Dream runtime, token totals, generated memories/corrections/entities, and memory export remain unmeasured or absent. Setup counters are not dream counters.

All 15 downstream rows remain `not_run`, with `null` Remnic and no-memory scores. The external 13.3% to 73.3% range does not rank this run. Scoring needs Letta's task environments and verifiers or a submission; no contact message was sent.

No corpus, canary, or generated memory content was committed. Reserved corpus and memory paths remain ignored. No production daemon, shared memory, shared QMD index, or fleet model router was used. Owned smoke daemons stopped.

## Next execution condition

Wait for corpus access to be granted. Then download only, verify `SHA256SUMS` and its digest, validate the 674/184/490 counts, inspect formats without exposing contents, and run all trajectories through normal ingestion. Record any ingestion-only limit adjustment; leave recall settings unchanged.

The plan records cost assumptions and the six-hour dream limit. No corpus throughput estimate is available from these tiny smokes. Keep the PR draft. Do not self-merge or mark it ready.
