# FrontierMemory 1.0 status

All 674 trajectories and 1,183 source parts were attempted. One part remains provider-blocked; 673 trajectories finished without a provider refusal. The run produced a private native Markdown handoff. No downstream task ran.

Keep [draft PR #3212](https://github.com/joshuaswarren/remnic/pull/3212) draft. Do not merge or mark ready.

## Final dream measurements

The run started at 15:46:31 UTC and stopped at 20:34:00 UTC on 2026-10-22. Wall time includes startup, restarts, and diagnostic pauses. Download and earlier synthetic setup are separate.

| Measurement | Observed value |
| --- | ---: |
| Trajectories fully attempted | 674 of 674 |
| Trajectories without refused parts | 673 |
| Trajectories with a refused part | 1 |
| Source parts attempted | 1,183 |
| Parts completed without provider failure | 1,182 |
| Provider-refused parts | 1 |
| Provider requests | 1,184 |
| Failed provider requests | 2, for the same part |
| Administrative queued-part cancellations | 5 |
| Recorded ingestion errors | 7 |
| Wall time | 17,249.368 seconds (4h 47m 29.368s) |
| Reported input tokens | 131,040,618 |
| Reported output tokens | 1,631,388 |
| Reported total tokens | 132,672,006 |
| Fact files | 9 |
| Correction files | 5 |
| Entity files | 33 |
| Native Markdown handoff files | 60 |
| Handoff content bytes | 33,869 |
| Metered API spend | $0 |

Token totals cover reported successful completions. Failed requests may have unreported usage. Subscription quota is not priced here. File counts do not measure downstream accuracy or unique semantic memories.

## Exact extraction blocker

One source part failed twice. The first error lacked a recorded classifier. The second carried OMP error ID `53248` (`0xD000`), identifying account-policy and content-block flags. Its HTTP status was unreported. The read-only usage report did not show subscription exhaustion.

After classification, the run retained that refusal without rewriting or retrying the part. It attempted the remaining unchanged parts. The completion ledger and resume cursors account for every source part, including the refusal. No model switch or metered fallback occurred.

Full successful extraction needs the mandated provider route to accept that unchanged part. This run did not bypass the provider policy.

## Verified corpus

Revision: `67250357405072066498c061f9af0eccfdac20c0`. All 677 repository files downloaded with one worker. All 674 trajectory checksums passed. Parsing verified 184 PASS and 490 FAIL outcomes, across 558 JSON and 116 JSONL inputs. Input files total 314,063,575 bytes.

The SHA-256 of `SHA256SUMS` matched:

```text
c7d31214ed20af4f14f46c4b9a838ebc9aa35a9491dfbce0fa50f7aa456eedd1
```

This run performed no HF login, terms acceptance, upload, push, or repository creation. Corpus files, memory contents, and the canary remain outside this public repository.

## Extractor and handoff

The private transport used `omp/18.12.6` and the existing `openai-codex/gpt-6.1-sol` subscription. Earlier requests used priority. Post-reset requests used `--service-tier default`, with Fast mode off. The effective backend tier was not recorded.

Six independent standalone instances used separate memory, workspace, and Orama directories. Provider events proved a peak of six concurrent calls. Each instance retained its normal serial extraction queue. Grounding stayed enabled. Recall settings retained their defaults.

The handoff contains native Markdown trees from the original store and six worker stores. Its 60 files include the 47 fact/correction/entity files above. No cross-store consolidation or semantic deduplication is claimed. File-copy checks matched the source bytes. The handoff excludes corpus input files and runtime databases.

Each archive part entered normal observe/extract/flush as one user replay message. Original role labels and tool records remained inside the source text. Consecutive parts contained at most 400,000 source characters; the ingestion-only turn limit was 450,000 characters. No source part was silently truncated.

All owned instances stopped. Their evaluation ports had no listeners after shutdown. Private state and execution scripts remain available for inspection or an authorized resume. No production service, shared QMD index, other extractor, or other model endpoint was used.

## Downstream scoring

All 15 downstream rows remain `not_run`, with `null` Remnic and no-memory scores. The external 13.3% to 73.3% range does not rank this run. Scoring requires Letta's task environments and verifiers or a submission. No contact message was sent.

See [eval-plan.md](eval-plan.md), [the result report](results-2026-10-22.md), and [the JSON export](results-2026-10-22.json). Earlier synthetic diagnostics remain separate from corpus measurements.
