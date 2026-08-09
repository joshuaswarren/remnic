# Theory: construct harmonic memory from committed facts

Harmonic recall reads abstraction nodes and cue anchors. Extraction constructs those records only after persistence assigns final memory IDs.

The accepted fact set is the authority. The coordinator groups active facts by target storage. It excludes pending-review and tombstone-blocked writes. Shared and profile targets receive only entity mentions backed by facts written to that target. Multi-target episodes derive titles from the facts routed to each target.

Construction is deterministic for fixed inputs. One micro episode summarizes up to three facts. Each extracted entity produces one meso topic or project node. Topic source links include only facts whose `entityRef` matches that entity. Stable hash suffixes separate entity names that share one sanitized path segment.

The model may supply three short cue anchors per fact. All extraction paths apply one validation contract. Construction rejects unsafe display text in facts, titles, tags, entity references, mentions, and cues. It also derives entity and date anchors. Anchor identity hashes the normalized type and cue. Each node reference records its retained source memory IDs, so lifecycle filtering removes inactive cue provenance without hiding a mixed node's active sources.

Atomic replace and a shared mutation lock protect both record types. The in-process queue preserves local order. A filesystem lock serializes cross-process read-merge-write operations. Lock acquisition confirms the token under the stale-reclaim guard before any mutation starts. Crashed reclaim guards recover after verified staleness. Failed confirmation removes only the caller's matching token. Abstraction-node upserts scan once, merge duplicate IDs, retain canonical records, and cap source links and display metadata. Cue-anchor upserts merge bounded live node references, tags, and source attribution.

Recall projects source-backed nodes from active authoritative memories before scoring. It also applies the primary recall policy for expired validity intervals. Projection always rebuilds titles, summaries, tags, entities, and source links from retained sources. It strips storage-only attribute suffixes from projected content. It then admits only anchors attributed to those projected sources. A legacy anchor without attribution remains eligible only when every node source is eligible. Source-less nodes remain eligible.

Consolidation prunes orphan anchors in the default store and a rotating, bounded set of writable namespace stores. Any failed scan, unreadable record, or malformed record aborts that store's pass before deletion. A failed namespace does not block independent stores.

`harmonicRetrievalEnabled` gates abstraction-node construction. `abstractionAnchorsEnabled` independently gates cue-anchor construction and pruning. Scoped namespaces use local harmonic stores. Only the default namespace uses an explicit store override. Construction failures log the affected store and preserve primary memory persistence.

Focused regressions cover bounds, deterministic derivation, entity collisions, lifecycle projection, source-scoped anchors, namespace pruning, insertion retention, concurrent upserts, prune safety, independent gates, routing, searchability, and fail-open writes. The executable lifecycle subject drives harmonic persistence through all nine canonical rows. Local gates pass. The repository package shard still has the independent timeout tracked by issue #2324 and PR #2338.
