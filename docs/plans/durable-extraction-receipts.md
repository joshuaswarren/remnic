# Durable extraction receipts

## Contract before implementation

A receipt identifies exact observed input using a content digest, chunk bounds/version,
message digest, authenticated principal, resolved namespace, session and resolved scope.
All extraction pieces are registered before any piece is queued. Receipt members travel
with durable buffer turns; merged extraction batches retain every member. Context-only
turns do not establish coverage. Extraction never silently truncates a receipt piece.

Admission, transcript persistence, queue settlement, caller cancellation and force flush
are not extraction coverage. A receipt is complete only when every registered member has
a writer-confirmed durable outcome or an explicitly validated successful empty extraction.
Proposed candidates, filtered candidates, pending review and failed/invalid provider
responses do not establish coverage. Every artifact kind participates, including memory,
entity, relationship, question, profile, identity and auxiliary artifacts.

Attempts fence each member independently. A stale attempt cannot finish newer work.
Storage writes are journaled before application and confirmed only after awaited writer
success. An interrupted journal is ambiguous and cannot automatically complete coverage.
Reconciliation requires matching actual persistent provenance; otherwise retry remains
at-least-once and can produce duplicates. The API does not promise exactly-once effects.
Receipt reads authorize both namespace and authenticated owner before returning metadata;
receipt identifiers never grant authority. Receipts contain no source text.

## Scenario matrix

| Scenario | Required outcome |
| --- | --- |
| Single exact input, all writes confirmed | Every member durable; complete |
| Input exceeds extractor turn limit | Preregister all pieces; one piece cannot cover parent |
| Several receipts merged into one run | Preserve all processed memberships and confirmed evidence |
| Disjoint members run concurrently | Independent generation fences |
| Retry races old run | Old generation cannot confirm or finish |
| Restart after admission | Membership and exact identity retained |
| Restart after prepare / before confirm | Ambiguous journal; incomplete |
| Failure after some writes | Preserve confirmed IDs; incomplete |
| Provider failure returning empty arrays | Failed/retry; incomplete |
| Valid provider response with no candidates | Explicit empty_success only |
| Candidates all filtered or awaiting review | Deferred; incomplete |
| Deduplicated candidates | Existing actual artifacts verified; never candidate counts |
| Flush / compaction / reset / session end | Normal writer rules; no implicit coverage |
| Caller cancellation during persistence | Writer settles independently; no caller-derived terminal status |
| Foreign owner / namespace reads | Denied without revealing receipt contents |
| Repeated admission / replay | Stable identity and membership; no implicit success |

## Integration readiness

Backfill consumers must require coverageComplete, not status alone, and retain original
input until every member is covered. An unresolved write journal requires reconciliation
or explicit retry; automatic coverage from a prewrite record is prohibited.

## Implemented checkpoint and remaining integration

The default-off `extractionReceiptsEnabled` config flag gates receipt admission.
The opt-in observe descriptor registers exact text pieces before durable ingestion.
Membership survives copied/reloaded buffer turns and merged extraction batches.
Authenticated receipt reads use the existing memory-read capability and require both
namespace authorization and exact receipt ownership. Provider payload validation runs
before normalization; failure, malformed output, candidate filtering, output caps,
and pending review cannot establish complete coverage.

New memory, entity, question and auxiliary artifact writes can supply confirmed IDs.
The writer syncs their actual files and ancestor directories before confirming receipt
evidence. This ordering covers power-loss durability as well as process restart.
Void writers for profile, identity, relationships and entity activity, and chunk writes,
remain supported extraction operations but produce deferred receipts: awaited resolution
alone cannot prove they wrote anything. Cross-namespace routed effects also defer.

This checkpoint is not ready to authorize automated backfill completion. Deduplication
currently defers even if the older artifact may be correct; verified existing-ID evidence
and exact persistent provenance reconciliation are still required. Unconfirmed journals
remain ambiguous across retries and cannot complete automatically. Reconciliation must
verify exact principal, namespace, input membership, artifact identity and actual effect;
a prewrite journal alone is insufficient. No new daemon or backfill runner is included.

The implemented tests cover piece membership, restart serialization, partial writes,
valid empty versus malformed/failed results, capped outputs, void writers, owner and
namespace authorization, and real observe/buffer/flush persistence. The receipt lifecycle matrix also covers real observe admission, restart, compaction,
before_reset, session_end and completed-input replay. Provider-inferred identity rows
are explicitly skipped because receipt admission requires authenticated identity; the
existing extraction lifecycle matrix owns those identity-inference scenarios. Exact
crash provenance reconciliation coverage remains required.

## Checkpoint validation

The reviewed source/config fingerprint is
`f892be7f99ce95eb7dd6c4bbccd68150130abfd1f9685f6802882b07f32a5108`.
It hashes the 36 changed TypeScript/JSON paths in lexical order, using each
path, NUL, its SHA-256 file digest and a newline. Documentation is excluded
so recording this result does not change the source fingerprint.

Validation passed: full `preflight:quick`, direct core TypeScript compilation,
352 entity-hardening tests, 44 focused tests with three documented provider
identity rows skipped, and 65 capability tests. Structural ratchets pass with
no ceiling increases. The explicit changed-file lifecycle gate covers seven
paths, retains two existing grandfathered paths and reports zero violations.
Release discipline passes for the default-off alpha flag and changeset.

Preflight uses the actual upstream base for each supported gate override.
CLI tests also require an isolated temporary OpenClaw state directory and
removal of inherited daemon-routing/auth environment variables; otherwise
ambient operator configuration contaminates the existing contract tests.
No live configuration or test expectations were changed to obtain a pass.
These checks validate the conservative checkpoint, not backfill readiness.

## Next layer: verified exact fact deduplication

An exact fact duplicate may supply receipt evidence only when the actual matched
memory is retained by the initial check or the serialized commit-window recheck.
A boolean hash hit is insufficient. Before confirmation, reread that exact path,
verify its ID, active category, normalized content, connector, entity and subject,
and sync its file and ancestor directories. Record the existing ID with
`deduplicated` disposition and a digest of the checked effect. Receipt namespace
must match the target storage namespace. Candidate quality gates still apply.

| Scenario | Required outcome |
| --- | --- |
| Initial exact match, same namespace and metadata, active fact | Verified existing ID may cover the processed members |
| Locked recheck finds a peer's committed exact fact | Preserve and verify that exact winning ID |
| Hash hit without matched memory | Deferred |
| Matched path removed, replaced or changed before confirmation | Deferred; never reuse stale evidence |
| Different namespace, connector, category, entity or subject | Deferred |
| Judge reject/defer, low importance or faithfulness pending | Deferred |
| Structured or temporal fact, chunked parent, semantic/novelty match | Deferred in this bounded layer |
| Prior unresolved journal or partial writer failure | Remains incomplete; dedup does not reconcile ambiguous writes |
| Existing match reread/sync fails | Incomplete; no terminal receipt |

Crash reconciliation and unsupported writer proofs remain separate work. This
layer must not enable automated backfill or reinterpret prior ambiguous journals.

### Exact fact reuse validation

The nine TypeScript/JSON paths changed after checkpoint `35fe00e` have source
fingerprint `4166ccfc45e3e2083685ca51309330b42cbb24b08ebb6825e543a2a465a20257`,
using the checkpoint hash recipe above. Independent review approved this bounded
layer after stored temporal, chunk and legacy artifact cases were excluded.
Read-back also checks file identity and modification metadata across artifact
sync, so replacing a file with the same body cannot supply unchecked evidence.

Full isolated `preflight:quick` passes, including package/test compilation,
structural ratchets without ceiling increases, and 352 hardening tests. The
receipt regression set has 69 tests: 66 pass and three documented provider
identity rows are skipped. Removing only the stored temporal/chunk-parent guards
in an isolated source copy makes both corresponding regression tests fail.
The explicit full-diff lifecycle check covers nine paths, keeps two existing
grandfathered paths and reports zero violations. These results do not authorize
backfill or reconcile prior ambiguous journals.

## Plain-fact crash reconciliation contract

Before persistence, the writer durably closes an immutable plan over the exact
registered member set, authenticated identity digests, validated provider candidate
identities, and each normalized fact slot. A retry must produce the same plan. A
changed plan stops before effects; it never replaces an interrupted plan. Provider
failure, filtering, unsupported output kinds, and changed input cannot authorize
recovery. Each fact slot must have its own exact durable effect proof.

The writer embeds versioned operation provenance in the same atomic fact-file
write as the effect. It binds the complete member set, original attempt and
generations, plan, journal, slot, namespace and principal/input identity digest.
The receipt WAL is not proof. Recovery reads the actual file, validates exact
provenance and effect identity, syncs file and directories, and only then confirms
the retained journal using a current generation. Existing deduplicated records
require an atomic provenance append under the memory mutation lock.

| Failure or retry | Required behavior |
| --- | --- |
| Before plan or journal | No recovered coverage |
| Prepared journal, missing fact | Deferred; no fabricated effect |
| Fact committed before sync/confirm | Exact readback and sync may recover |
| Confirm committed before finish | Same-plan retry verifies all effects |
| One of several fact slots absent | Whole affected member remains incomplete |
| Retry returns a different provider plan | Stop before persistence effects |
| Attempt generation changes during write | Old attempt cannot confirm/finish |
| Principal, namespace, membership or provenance differs | Reject recovery |
| Fact changed, removed, or legacy without provenance | Remain unproven |
| Void/entity/chunk or richer fact effects | Explicitly unsupported for recovery |

Retries remain at-least-once. This layer requires the provider to reproduce the
validated plan; provider-free recovery is separate unfinished work. The flag stays
off by default, and neither flushing nor a prewrite journal establishes coverage.

Fresh entity, question and artifact writer proofs retain the existing receipt
behavior. They do not participate in plain-fact crash reconciliation: an unresolved
unplanned effect keeps a retry incomplete even if the retry persists other output.
Canonical plan hashing removes JSON-omitted optional fields before sorting keys,
including nested objects, so equivalent provider and parsed disk records agree.
