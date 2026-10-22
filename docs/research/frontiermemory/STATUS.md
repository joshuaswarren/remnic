# FrontierMemory 1.0 status

The verified corpus dream stage is running with six concurrent subscription calls and Fast mode off. Grounding remains enabled. No downstream task ran. Keep [draft PR #3212](https://github.com/joshuaswarren/remnic/pull/3212) draft; do not merge or mark ready.

## Measured checkpoint

Snapshot: 2026-10-22 at 17:51:23 UTC. These are partial dream results, not a completed benchmark.

| Measurement | Observed value |
| --- | ---: |
| Completed trajectories | 111 of 674 |
| Completed source parts | 205 |
| Ingestion errors | 5 administrative restart cancellations |
| Provider errors | 0 |
| Reported input tokens | 26,879,794 |
| Reported output tokens | 252,829 |
| Reported total tokens | 27,132,623 |
| Fact files | 1 |
| Correction files | 0 |
| Entity files | 2 |
| Metered API spend | $0 |

The canceled queued parts made no provider requests. Their ledger records remain intact, and resume retries their unfinished work. No completed parts were discarded. Final counters will replace this checkpoint after completion or a real provider limit.

## Verified corpus

Revision: `67250357405072066498c061f9af0eccfdac20c0`. All 677 repository files downloaded with one worker. All 674 trajectory checksums passed. Parsing verified 184 PASS and 490 FAIL outcomes, across 558 JSON and 116 JSONL inputs. Input files total 314,063,575 bytes.

The SHA-256 of `SHA256SUMS` matched:

```text
c7d31214ed20af4f14f46c4b9a838ebc9aa35a9491dfbce0fa50f7aa456eedd1
```

This run used existing authentication after an external access grant. It performed no HF login, terms acceptance, upload, push, or repository creation. Structural inspection exposed no trajectory content. Corpus and generated memories remain outside this public repository.

## Extractor and state

The private runner uses the existing `openai-codex/gpt-6.1-sol` subscription through OMP. Current requests use `--service-tier default`, with Fast mode off. Earlier requests used priority. The effective backend tier remains unverified. No metered API or extractor switch is permitted.

Six independent standalone instances now use separate temporary memory, workspace, and Orama directories. Provider events verified six concurrent requests. Each instance keeps Remnic's normal serial extraction queue. The handoff includes the original memory folder and all six worker folders; workers do not share learned entities or consolidate across folders. This sharded layout must remain part of any result interpretation.

Oversized inputs use consecutive 400,000-character source parts without omissions. Each part retains the verified outcome. The ingestion-only turn limit is 450,000 characters. Recall settings retain their defaults, and grounding remains on. The checked restarts retained 53 trajectories/103 parts, then 97 trajectories/183 parts.

The run uses no production service, shared QMD index, or other model endpoint. A real usage or rate-limit failure will stop new admissions, drain requests, stop the owned instances, and retain private state. No quota estimate alone triggers a pause.

## Scoring and files

All 15 downstream rows remain `not_run`, with `null` Remnic and no-memory scores. The external 13.3% to 73.3% range does not rank this run. Scoring requires Letta's task environments and verifiers or a submission. No contact message was sent.

See [eval-plan.md](eval-plan.md), [the result report](results-2026-10-22.md), and [the JSON export](results-2026-10-22.json). Earlier synthetic diagnostics remain separate from corpus measurements.
