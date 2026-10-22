# FrontierMemory 1.0 status

Corpus verification passed. The isolated dream stage started on 2026-10-22 at 15:46:31 UTC. Final dream counts and runtime remain pending. No downstream task ran.

- Draft PR: [#3212](https://github.com/joshuaswarren/remnic/pull/3212), on `docs/frontiermemory-1-0`.
- Previous draft: [#3211](https://github.com/joshuaswarren/remnic/pull/3211), closed without merging.
- Plan: [eval-plan.md](eval-plan.md).
- Results: [Markdown](results-2026-10-22.md) and [JSON](results-2026-10-22.json).

## Verified corpus

The pinned revision is `67250357405072066498c061f9af0eccfdac20c0`. All 677 repository files downloaded with one worker. All 674 trajectory checksums passed. Independent parsing verified 184 PASS and 490 FAIL outcomes, across 558 JSON and 116 JSONL inputs. Input files total 314,063,575 bytes.

The SHA-256 of `SHA256SUMS` matched:

```text
c7d31214ed20af4f14f46c4b9a838ebc9aa35a9491dfbce0fa50f7aa456eedd1
```

This run used existing authentication after an external access grant. It performed no HF login, terms acceptance, upload, push, or repository creation. Structural inspection exposed no trajectory content. Corpus and generated memories remain outside this public repository.

## Extractor and ingestion

A private eval runner uses the pane's existing `openai-codex/gpt-6.1-sol` subscription through OMP. The built-in Codex CLI route had failed auth refresh. The working runner does not inspect or copy auth material. It requests `priority`; the effective backend tier remains unverified. No metered API fallback was used.

The real standalone daemon uses private temporary memory, workspace, and Orama paths, plus an isolated loopback port. It uses no production service, shared QMD index, or other model endpoint. Recall settings retain their defaults. Source grounding remains enabled.

Every source file enters the normal observe/extract/flush path. Oversized files use consecutive 400,000-character parts without omitted source text. Each part retains the verified outcome. The ingestion-only turn limit is 450,000 characters, avoiding the default 4,000-character truncation. A global limit permits at most two subscription calls at once.

## Results and limits

The corpus dream stage is in progress. Final memories, corrections, entities, runtime, and usage are not yet reported. The run will record zero output if grounding rejects all candidates.

Earlier synthetic setup smokes consumed 11,953 reported tokens and wrote no facts. Those failed persistence assertions are setup diagnostics, not corpus results. The plan preserves their separate measurements.

All 15 downstream rows remain `not_run`. Remnic and no-memory scores remain `null`. The external 13.3% to 73.3% range does not rank this run. Scoring requires Letta's task environments and verifiers or a submission. No contact message was sent.

Keep the PR draft. Do not self-merge or mark it ready. Final corpus measurements will replace this in-progress status after the owned daemon stops.
