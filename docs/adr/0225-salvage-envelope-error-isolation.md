# Salvage Envelope and Per-Fact Error Isolation

Status: accepted

## Context
Extraction input is machine-generated: one malformed LLM field must never
abort a whole batch, yet category is an identity field the composer keeps
fatal even in salvage mode. Extractor output also reaches model context
(profiles, questions, relationships, identity reflections), so flagged
injection content must withhold the whole entity, and system marker tags must
survive the tag cap. Provenance had its own trap: mixed import labels
previously collapsed to `user`, conflicting with the pre-#1955 rule that a
batch carries a connector only when every turn is tagged. Relative time
expressions in a buffered conversation spanning a date boundary resolve
wrongly against a batch-wide anchor.

## Decision
Rules for handling machine-generated extraction output:

- Salvage malformed extractor output instead of throwing: non-string
  attribute values, overlong tags (dropped BEFORE budgeting), and other
  field defects are repaired or dropped per field; system marker tags always
  survive the tag cap.
- A per-candidate identity defect (an unrecognized non-empty category) is a
  per-fact error: filter that fact; it must not abort the batch.
- All extraction-persist write sites go through the single compose wrapper so
  note logging cannot be forgotten; compose BEFORE the dedup gate so dedup
  hashes, contentHashSource, and supersession keys describe the SURVIVING
  fields that are actually persisted, including the envelope-surviving
  entityRef.
- Screen injection-prone rendered content: a flagged name withholds the
  whole entity (the raw name is emitted outside the snippet fence);
  question screening joins question and context; source/label/target of
  relationships are screened.
- A batch carries a connector only when EVERY turn is tagged with the same
  identity; disagreements or partial presence are a conflict, never silently
  collapsed.
- Anchor each fact's event time to its source turn's timestamp (explicit
  sourceTurnTimestamp, then earliest provenance span's observedAt, then the
  batch anchor), so "yesterday" on an early turn of a cross-date batch
  resolves correctly.

## Consequences
Salvage means stored records can differ from raw extractor output; any
consumer hashing or deduplicating must use the surviving fields, not raw
options. The whole-entity withhold is conservative by design: one flagged
field costs an entire entity. Connector conflict handling can withhold a
legitimate connector label when tags are merely inconsistent.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-envelope.ts:11` — "Extraction input is MACHINE-GENERATED: one malformed LLM field must never abort a whole batch"
- `packages/remnic-core/src/orchestration/extraction-envelope.ts:20` — "Single compose wrapper for all extraction-persist write sites, so note logging cannot be forgotten"
- `packages/remnic-core/src/orchestration/extraction-envelope.ts:36` — "System marker tags must survive the tag cap (#2014/#2017 review round)"
- `packages/remnic-core/src/orchestration/extraction-envelope.ts:44` — "Drop overlong tags BEFORE budgeting (round 3)"
- `packages/remnic-core/src/orchestration/extraction-injection-gate.ts:26` — "Salvage malformed extractor output: non-string attribute values must not throw (#1955 review)"
- `packages/remnic-core/src/orchestration/extraction-injection-gate.ts:110` — "#1955 review: the raw name is emitted outside the snippet fence — a flagged name withholds the whole entity"
- `packages/remnic-core/src/orchestration/extraction-origin-context.ts:30` — "Mirror the pre-#1955 provenance rule: batch only carries a connector when EVERY turn is tagged"
- `packages/remnic-core/src/orchestration/extraction-origin-context.ts:46` — "Conflict when identities disagree OR are only partially present; mixed import labels previously became `user`"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:400` — "// Compose BEFORE the dedup gate (#2014 round 2): salvage mode may"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:401` — "// drop or clamp attributes, and the dedup hash, contentHashSource,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:402` — "// and supersession keys below must all describe the SURVIVING"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:403` — "// fields that writeSealedMemory actually persists."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:625` — "// Compose BEFORE the dedup gate (#2014 round 2): the dedup hash, contentHashSource, and"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:626` — "// supersession keys must describe the SURVIVING fields writeSealedMemory persists."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1507` — "// Trim first (round 5): legacy writeMemory accepted \" fact \"."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1509` — "// #2014/#2017 review round: an unrecognized non-empty category from"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1510` — "// the extractor is a per-CANDIDATE defect. The composer keeps category"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1511` — "// fatal even in salvage mode (identity field), so filter here — one"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1512` — "// malformed model field must not abort the whole extraction batch."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1526` — "// #1670 — anchor each fact's event-time to its SOURCE TURN timestamp,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1527` — "// not the batch-wide latest. When a buffered conversation spans a date"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1528` — "// boundary, a relative expression (\"yesterday\") on an early-turn fact"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1529` — "// must resolve against that early turn's date. Prefer the fact's"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1530` — "// explicit sourceTurnTimestamp, then the earliest provenance span's"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1531` — "// observedAt, then fall back to the batch anchor (legacy extractors)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2880` — "// Persist entity relationships (v7.0). #1955 review: source/label/target are screened."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2923` — "// #1955 review: profile + questions render verbatim into model context — // screened; questions screen question+contex…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2924` — "// screened; questions screen question+context JOINED (routing: #2397)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2945` — "// Persist identity reflection (screened — #1955): durable namespace-local // state; identity-ONLY extraction still cou…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2946` — "// state; identity-ONLY extraction still counts as durable non-fact (NIIly)."
- `packages/remnic-core/src/orchestration/extraction-run-helpers.ts:148` — "/** * Derive a single `sourceConnector` from a batch of turns. * Returns the connector ONLY when ALL turns carry the s"
