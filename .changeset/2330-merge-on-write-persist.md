---
"@remnic/core": minor
---

Wire judge-mediated merge-on-write into the extraction write path (issue #2330). An extracted fact whose nearest neighbor scores inside `[semanticMerge.minSimilarity, semanticDedupThreshold)` is offered to an LLM merge judge; on a `merge` verdict the existing memory is updated in place — same id, same path — instead of a near-duplicate fragment being written. A merge snapshots the target as a page version under the new `semantic-merge` trigger, stamps `derived_via: merge`, bumps `reinforcement_count`, appends the incoming fact's provenance `sources`, attaches the incoming fact's suggested navigation `links` to the target (deduped on target id + link type, and a suggestion naming the surviving target itself is dropped rather than becoming a self-edge — memory linking and the merge judge both search on the incoming content, so the suggested neighbor is often the merge target; the create path stamps them on the fact it writes, and the incoming fact is never created on a merge, so without this the relationships would be permanently lost and untraversable), resyncs the fact-content hash index off the same RAW pre-citation content form the write path hashes (the configured citation form is stripped off the judge-composed merged body first, so a merged record's identity equals the ordinary write of the equivalent raw fact and exact dedup never fragments), reindexes the target, and — when verbatim artifacts are enabled, the category qualifies, and the confidence is at or above `verbatimArtifactsMinConfidence` — stores the incoming extraction's text as a verbatim artifact anchored to the merged target, so a merge never drops the anchor the normal write would have stored.

Round N+3: the merge patch also restamps the record's intent routing (`intentGoal`/`intentActionType`/`intentEntityTypes`) by recomputing it from the committed merged body with the same `inferIntentFromText` call the ordinary write runs (gated on `intentRoutingEnabled`; routing off leaves the fields untouched), so a merged record's intent compatibility always describes the body it holds rather than the target's stale pre-merge values. And a successful merge enqueues the surviving target — committed merged body as content — into the batch's harmonic construction map, so a merge-only extraction still derives its episode/abstraction nodes and cue anchors; the public `persistedIds` return stays new-fragment only.

Round N+5: the merge path also runs the create path's observer stages for the surviving target. With `multiGraphMemoryEnabled` a committed merge builds the target's graph edges (entity, time, causal) through the same `buildGraphEdge` call the create path runs, derived from the re-read committed record and its raw pre-citation merged body, fail-open like the create path's graph block. A `preference`-category merge records its `preference_affinity` event in the behavior-signal ledger, so runtime-policy learning observes preferences accepted through semantic merge.

Round N+6: the merged target's graph identity is completed and made
idempotent. The relative path used for its graph edges now comes from the
cold-aware committed record itself, so a target demoted to `cold/` records
edges at its true committed path instead of a fabricated category-directory
hot path that graph recall could never resolve. Before appending entity
edges for a re-merged target, its prior from-side entity edges are removed,
so repeated merges replace them rather than re-appending duplicates into the
append-only JSONL (duplicates that spreadingActivation summed into candidate
scores). And the merged target is enrolled in the batch's thread episode
list exactly like a freshly written memory, so a fact extracted after a
merge in the same batch chains its time/causal adjacency through the merged
target instead of skipping it.

Round N+7: the merged-target promotion is now gated on the provenance
patch — a merge whose content update committed but whose provenance patch
and rollback both failed returns `provenancePatched: false`, and the
promotion payload builder refuses that outcome (logged), so no shared or
profile copy is ever stamped from a record still holding its pre-merge
confidence, provenance, sources, and hash. After the merged-body promotion
lands, any concurrently promoted pre-merge copy of the same target (same
`sourceMemoryId`, different body — the pre-mutation copy probe can race a
concurrent writer) is superseded with `supersededBy` pointing at the current
copy, replacing it rather than adding a second active copy. The committed
merged body now carries the incoming extraction's citation marker (lifted
from the same cited string the verbatim artifact stores, so memory and
artifact share one timestamp) appended after the judge's merged text, so
incoming claims stay attributed even when the merged text embeds the
target's older citation — while the `contentHash` identity stays on the
stripped raw pre-citation body. The surviving target joins the batch's
internal temporal/tag index refresh (public `persistedIds` stays
new-fragment only), so event-order queries see the merged tokens without a
full rebuild. The merged target's prior generated graph edges are now
replaced in EVERY enabled graph type — entity from-side, time and causal
inbound — through one shared remove/restore routine that restores the prior
edges when the replacement build fails (failure leaves the old or the new
complete set, never none), and the target is recorded as the thread's
latest episode event (deduped to the end when already present) so the next
fact chains its time/causal adjacency through the merge.

Round N+8: the merged-target reconciliation now runs for EVERY written
promotion target, not only when a shared copy landed. `promoteMemoryToShared`
returns the id of the last copy it actually wrote — the shared copy when
shared promotion ran, otherwise the profile copy — so a profile-only
auto-promotion plan (profile target selected, `serverShared` not) also
supersedes a concurrently published pre-merge copy instead of leaving both
active. A graph append failure during the merged-target edge rewrite now
propagates from `GraphIndex.onMemoryWritten` (logged, then rethrown) so the
restore routine actually executes and the prior edge set is never silently
lost; the create paths keep failing open by catching, unchanged. Citation
canonicalization strips every recognized form before hashing: a body
carrying BOTH the default marker and the current custom template's marker
(the config changed between writes) hashes as the raw body. And
`semanticMerge` config presence is own-property presence — a
present-but-`undefined` field throws per reject-on-invalid, and keys
inherited through the prototype chain never apply; only an absent key
defaults.

Round N+9: a merge whose committed record would carry an effective
`entailed` faithfulness verdict bypasses the merge entirely (see above) —
the verdict was rendered over the target's pre-merge body, and re-running
the gate inside the merge's compare-and-swap window would cost a per-merge
LLM call, so the create path runs instead and persists the verdict it
computed for the incoming fact alone. The post-batch temporal/tag index
refresh now resolves persisted ids through the cold-aware id lookup when
the hot-tier scan misses them, so a merge into a target living under
`cold/` refreshes its `index_time` row and event-order queries see the
merged tokens without a full rebuild. And two facts merging into the SAME
target in one batch now coalesce to a single harmonic-construction entry —
the latest committed (cumulative) body replaces the earlier snapshot and
the cue anchors union across merges — instead of deriving an episode whose
summary concatenates both snapshots and whose inserted-at metadata key
collides.

Round N+10: the merged-target reconciliation now runs even when NO
replacement promotion is written. A merge that downgrades the committed
record below the profile/shared promotion minimum (the min(incoming,
target) confidence the merge stamps) leaves the promotion returning no
copy, and a degraded merge yields no payload — in both cases a pre-merge
copy published concurrently after the probe used to survive active. The
reconciliation re-reads the committed record when no promoted body is at
hand (so a target replaced mid-flight compares copies against the newer
body) and supersedes stale copies onto the committed target itself,
leaving exactly one current copy or none when none is warranted. The
embedding-fallback reindex after a merge is now cold-aware: the id lookup
behind it was hot-tier-only, so a surviving target living under `cold/`
resolved to nothing and the fallback index kept serving the pre-merge
text; it now falls back to the same cold-aware lookup the merge path uses
(retired records stay out via the active-status gate). And a graph rebuild
failure cleans up after itself: when the entity append succeeds but a
later time/causal append fails, the rows the failed build already appended
are removed before the prior edge set is restored, so failure leaves
EXACTLY the old edges instead of old plus partial-new rows that
spreadingActivation double-counted.

Round N+11: only still-ACTIVE promoted copies block a merge — the
promotion-namespace copy scan now filters the corpus with the
lifecycle-active predicate, so a namespace holding nothing but a superseded
copy linked by `sourceMemoryId` no longer makes `targetHasPromotedCopies`
reject every later judge-approved merge (the updates accumulated as new
fragments instead). A committed merge also persists the surviving target
into the thread's durable episode-set file, and the merge's page version
snapshot is staged WITHOUT pruning.

Round N+12: the cap-based prune finalizes only after the COMPLETE
content-and-metadata transaction commits — both compare-and-swaps, not the
content one — so a rejected frontmatter patch (or its successful rollback)
leaves version history untouched; a degraded success deliberately keeps the
full history for the recovery path. The promoted-copy probe and the
post-merge reconciliation enumerate EVERY resolvable profile layer
(`readOrder`/resolved `layers`), not only today's `promotionTargets`: a
namespace that received copies while its layer was selected keeps serving
them after the operator deselects the layer, and those historical copies
stay detectable and get reconciled. The merged-target graph rebuild is
revision-guarded end to end: a writer committing a newer body between the
committed-body check and the final edge install aborts the stale writer's
install instead of clobbering the newer merge's edges with edges derived
from the older body. And the durable thread-episode persist is
move-to-end: a re-merged target already earlier in the thread moves to the
tail, matching the batch-local ordering, so after the next extraction
reloads the thread the target stays inside the recent-episode window
(the public `persistedIds` return stays new-fragment only).

Round N+13: an aborted merge attempt now rolls its staged page-version
snapshot back OUT of the manifest. Staging itself mutates history, so a lost
content CAS or a metadata failure whose content revert succeeded used to
leave a snapshot of an unchanged body behind; repeated failed attempts grew
history past `maxVersionsPerPage`, and a later successful merge's prune then
discarded real rollback states to make room for those duplicates (a degraded
success still keeps the staged snapshot — it is the recovery point for the
committed merge). The post-merge promoted-copy reconciliation never retires
copies off an unreadable canonical record: when no replacement promotion is
at hand and the committed source record cannot be re-read (transient
failure, missing record, or empty body), the reconciliation aborts entirely
instead of degrading the canonical body to an empty string — which had
classified every non-empty active copy as stale and superseded the whole
set. And the fact-hash restoration behind the merge repair is cold-aware:
`restoreFactHashAfterApproval` resolved the id through a hot-only scan, so
for a target living under `cold/` the repair removed the pre-merge hash and
never registered the merged one — exact dedup could admit a second copy
until a restart rebuilt the index from the corpus. It now uses the same
cold-aware id lookup the merge path itself uses.

Round N+14: the aborted install's graph rollback is now surgical. The
rebuild returns the exact rows it appended (by identity), and the rollback
removes only those — the previous node-wide sweep also deleted rows a newer
writer had appended after the stale writer's removal, rows the snapshot
restore could not bring back, leaving the memory holding the newer body
while graph recall reflected the pre-merge state. The snapshot restore is
residue-gated per graph type: a type whose file still holds node rows the
aborting writer cannot account for belongs to the newer writer's completed
rebuild and is restored over by nobody; types swept clean restore verbatim,
so a plain build failure still leaves exactly the old edge set. A build
that throws loses its row list and falls back to the sweep, unchanged
behavior absent interleaving.

Round N+15: the merged-target promotion is now revalidated against the
committed record immediately before it runs. The promotion payload is a
cache of the record as of the payload builder's read; between that read and
the promotion another writer could merge the same target again and publish
its newer copy, and promoting the cached older body would have handed
reconciliation a stale canonical body that superseded the newer writer's
current copy. The record is re-read and the cache confirmed against the
committed revision AND body — on any advance (or an unreadable record,
which cannot confirm anything) the promotion AND its reconciliation are
abandoned; the newer writer's copy stands and the next merge retries. The
reconciliation's canonical body is now ALWAYS the re-read committed record,
never the promotion's cached payload: a writer committing between another
writer's promotion and its reconciliation can no longer have its current
copy superseded off the older cached body, and when the record has moved
past the promoted body that promotion's own copies retire onto the source
target (the live canonical record) instead of lingering as duplicates. And
the version-history prune counts only COMMITTED snapshots: a staged
snapshot is marked `pending` in the manifest, the staging writer clears the
flag under the same page lock as its finalizing prune, and a prune never
counts or removes another writer's pending entry — with a full history and
two concurrent merges, the committing writer's finalize used to count the
still-pending writer's snapshot and remove one extra valid rollback point,
which the pending writer's abort then left permanently missing.

A merge carries content, category, provenance sources, and connector — a fact that also carries structured attributes, an entity ref, bi-temporal bounds, effective validity bounds the incoming fact does not carry identically (the merged body inherits the target's `valid_at`/`invalid_at`, so a target with `invalid_at` never merges and a target with `valid_at` merges only with an incoming fact carrying the same bound — a fresh unbounded claim must not inherit an expired bound), tags the target lacks, a higher importance, stronger provenance, a faithfulness verdict (shadow mode included — a contradicted or unsupported fact carries the verdict without pending_review status) whose effective value is not also the target's — one-sided verdicts included, because the gate ran on only one side: the trust stage maps `entailed` to the maximum contribution, so claims the gate never checked must not inherit an entailment rendered over the other side's claims alone — and as of round N+9 not even an EQUAL verdict survives: the target's `entailed` was rendered over its pre-merge body, never over the judge's merged text, so any merge whose committed record would keep an effective `entailed` bypasses too (both sides absent, or both present and effectively `unchecked` — no entailment signal — still merge), a subject classification whose effective value (absent = the least-privileged `user`, the same default the subject guard applies) differs from the target's effective subject (so an unclassified fact extracted with classification disabled is never merged into an `agent`-labeled memory that reinforcement could then promote), a computed episode/note `memoryKind` that differs from the target's committed kind (the merged record keeps the target's kind — the classification that drives episode-cache membership and the episode-only verification and promotion paths — so a time-specific fact is never filed as a note and a stable note never rides the episode-only paths; a fact extracted with classification disabled carries no kind and still merges), a `toolScoped: true` classification the target lacks (a tool-scoped fact must never widen into an unscoped target; an already-scoped target keeps its stricter flag), or an untrusted authority origin (per `untrustedOrigins`) offered to a trusted-origin target (the merged body would render under the target's origin at recall, so such a merge would hand untrusted text the target's unfenced authority; mismatches that never reduce fencing — equal origins, or trusted content into an untrusted target — still merge, so legacy targets with no `origin` stamp keep receiving user-origin facts) is created through the normal write instead of merged, so extraction metadata, access scope, and authority are never silently discarded or escalated. A would-be target that already has promoted shared/profile copies (linked by `sourceMemoryId`, still ACTIVE — a superseded or archived copy serves no body and does not block) also bypasses the merge — those copies are reconciled only by the normal write's promotion step, so merging would strand them at the pre-merge body; the copy scan inspects every known promotion layer and the shared namespace regardless of current write authorization or today's auto-promotion selection, so revoked permissions or a deselected layer cannot hide an existing copy. A weaker incoming provenance never rides the target's stronger tag: the merged body is retagged to the least-trusted side, because the trust stage maps the memory-level tag straight to a provenance contribution. A lower incoming confidence downgrades the merged record the same way: it keeps min(incoming, target) confidence with the tier that score maps to (an unreadable value bypasses the merge), so a low-confidence extraction can never leave a merged record — or a copy promoted from it — scoring above what the create path would have stored for that fact alone. A target with no promoted copy yet does not bypass: a successful merge runs the same shared/profile promotion the create path would have performed, anchored to the merged target id and copying the committed merged body — the exact text that `sourceMemoryId` points at — fail-open like the create path. Shadow-mode telemetry logs category, content length, and the decision reason only — never fact content, since log sinks commonly have broader access and retention than the memory store.

That promotion is a copy of the committed target, not of the incoming extraction: after the merge commits, the target record is re-read (the same cold-aware id lookup the merge itself used) and the shared/profile copy is stamped SOLELY from that record — body, category, confidence, tags, entity ref, structured attributes, importance, intent fields, memory kind, bi-temporal bounds (`validAt`, `invalidAt`, `observedAt`, `eventTimeSource`), provenance strength, claim spans, subject, write-provenance label, and the tool-scope marker with its owning `sourceConnector` — so no field on the promotion path reads the incoming extraction and a copy is authority-fenced exactly like the source it points at (an unstamped legacy target promotes as `unknown`, the fence's least-privilege default; a target whose temporal bounds or attributes the incoming fact omits keeps them on the copy). The tool-scope fields matter because the withhold gate re-runs content heuristics over the MERGED body: a `toolScoped: true` target whose judge-composed text no longer mentions the tools that earned it the marker — or whose connector is simply absent from the payload — would otherwise promote an active shared copy without the scope marker, exposing connector-specific instructions to every other connector; the committed marker is authoritative and the heuristics only ever add withholding. Promotion eligibility gates on the committed target's own confidence — the downgraded min(incoming, target) value where a lower incoming fact merged in. A target that can no longer ground the promotion after the merge commits (deleted, its body replaced by another writer, or archived/superseded by a concurrent lifecycle operation — promoting from a retired record would resurrect content that operation retired) skips the promotion fail-open — the merge itself stands.

Off by default behind the new `semanticMerge` config block (`enabled`, `minSimilarity`, `maxCandidates` — `0` disables merging before any embedding lookup, and a present-but-unparseable value (`"abc"`, an object, `NaN`, or infinity) is rejected at parse time instead of silently falling back to the default — only an absent key means `3` — `categories`, `shadowMode`). With the gate off there is no lookup and no judge call. `semanticMerge.minSimilarity` must be strictly below `semanticDedupThreshold`, and a config that inverts the band is rejected at parse time whenever merging is enabled or `minSimilarity` is set explicitly — a pre-existing config that lowered `semanticDedupThreshold` and never configured `semanticMerge` keeps starting unchanged. `semanticMerge.categories` entries are validated against the mergeable memory categories (`fact, preference, entity, decision, relationship, principle, commitment, skill, rule`) — an unknown entry such as `facts` is rejected at parse time with the valid list, because no extracted memory can ever match it and the misconfiguration would otherwise silently disable merging for every category; the episodic and immutable categories (`procedure`, `reasoning_trace`, `moment`, `correction`) never merge and cannot be listed. A fact may only merge into a neighbor carrying the identical source connector, or into an unscoped neighbor when the fact itself is unscoped — an unscoped merge into a connector-owned target would rewrite the target while its `sourceConnector` frontmatter kept naming that connector (stricter than the dedup gates, which keep the broad unscoped neighborhood). The in-place update is a compare-and-swap against the body the judge was shown, and a content update whose provenance patch fails rolls back to the pre-merge body under the snapshot. Every refusal — embedding-backend outage, fabricated target id, empty or oversized merged content, judge error, inactive target, failed snapshot or update — creates the new fact as before, each with its own telemetry reason, and `shadowMode` decides without ever mutating.

Also fixes a latent page-versioning defect found while adding the trigger: `readManifest` validated snapshot triggers against a hardcoded list, so any trigger added to the `VersionTrigger` union would have produced manifests that then failed to parse. The runtime allow-list is now derived from the union.
