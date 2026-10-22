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

## Caveat: output is anomalously thin (diagnosis, 2026-10-22)

Treat the stored output as a pipeline defect, not a measurement of what the corpus contains. Across 1,182 completed parts, the run kept 9 fact files, 5 correction files, and 33 entity files, using 132,672,006 reported tokens. Downstream scores stay `null` until Letta's task environments and verifiers are available. Nothing in this run ranks Remnic.

**Cause: source grounding discarded almost everything the extractor returned.** The extractor produced memories with verbatim source quotes. Remnic's grounding filter (`extractionSourceGroundingEnabled: true`, `extraction.spanMode: "off"`) then rejected nearly all of them. It checks the model's paraphrased `content` against the source text and ignores the `quote` field unless span mode is `on`.

Evidence, from a read-only pass over the retained private state and a fresh isolated store:

- **The count is correct.** A recursive walk of the original store and all six worker stores finds exactly 9 fact, 5 correction, and 33 entity files. The daemon logged 51 `persisted:` lines, and their totals match the files on disk. Persistence-stage gates removed almost nothing: 1 dedup, and no importance, judge, or redaction rejections.
- **Most extractions ended empty before persistence.** There were 1,189 observes and 11 extraction failures (7 network, 3 schema rejection, 1 empty). Only 35 of 1,183 parts appear as a source on any stored memory.
- **The extractor did return content.** Matching provider events to parts by timestamp worked for 1,006 of 1,184 calls. Parts that stored nothing had a median of 1,414 output tokens, and 678 of them had at least 1,000. Raw responses were not logged, because the eval runner discarded them.
- **Replay reproduces the stored output exactly.** Three parts were re-extracted with the same extractor in a fresh store, using 3 model calls: trajectories 300 (FAIL), 376 (PASS), and 118 (FAIL), part 1 each. Output-token counts were within 8% of the original calls. The extractor returned 13 facts, 4 entities, 2 profile updates, and 3 relationships, and all 13 fact quotes were exact substrings of the source. The pipeline kept 0, 0, and 1 fact plus 2 profile updates, which matches what the original run stored for those three parts.
- **Each item was checked offline against Remnic's grounding code, with no model calls.** Grounding kept 1 of 13 facts, 0 of 4 entities, and 0 of 3 relationships, and it kept both profile updates. Normalization and sanitization dropped nothing. Even with the verbatim quote used as the content, grounding kept only 6 of 13 against the JSON-escaped source and 8 of 13 against decoded text. Simulating `spanMode: "on"` did not change the content gate.

The prompt, the JSON parsing, the storage paths, the namespace, and replay extraction mode were not the cause. Extraction ran on every part (`extraction=true`). Survivors were mostly short statements copied nearly word for word, which is the shape this filter lets through.

**Confidence:** high for the mechanism. Three of three replayed parts matched exactly. The thin output across the full run is consistent with this mechanism, but it is not proven per part, because raw outputs from the original run were not retained.

**Recommended fix before any rerun:**

1. Remnic code PR: quote-anchored grounding. Accept a fact when its `quote` is an exact substring of one assertion-source turn and its `content` is grounded against a window around that quote rather than the whole transcript. Apply the same rule to entity facts and relationships, and stop sentence splitting from breaking a matched quote at `;`. Unrelated or hallucinated quotes still fail.
2. Runner change: keep raw model responses in private run state, so grounding changes can be re-applied offline without new model calls. Optionally render trajectory JSON as plain-text turns before ingestion.
3. Not recommended as the fix: turning grounding off. It would keep these items but drop the faithfulness guard. It is useful only as an offline comparison once raw outputs are logged.

**Cost of a corrected run:** after a pilot on 20 parts (about 2.2M tokens), a full rerun costs about the same as this one. That is about 1,183 extraction calls, about 133M reported tokens, and roughly 4h 47m at six concurrent calls on the same Codex subscription, with no metered spend. The one content-blocked part stays blocked. Per-part caps (12 facts and 6 entities) bound the maximum yield.

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
