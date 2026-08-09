# Theory: construct harmonic memory from committed facts

Harmonic recall already reads abstraction nodes and cue anchors. Extraction now constructs those records after persistence assigns final memory IDs.

The accepted fact set is the authority. The coordinator groups active facts by target storage. It excludes pending-review and tombstone-blocked writes. Shared and profile targets receive only entity mentions backed by facts written to that target.

Construction is deterministic for fixed inputs. One micro episode summarizes up to three facts. Each extracted entity produces one meso topic or project node. Topic source links include only facts whose `entityRef` matches that entity. Stable hash suffixes separate entity names that share one sanitized path segment.

The model may supply three short cue anchors per fact. All extraction paths validate their type, length, and content. Construction also derives entity and date anchors. Anchor identity hashes the normalized type and cue.

Atomic replace and a shared mutation lock protect both record types. The in-process queue preserves local order. A filesystem lock serializes cross-process read-merge-write operations. Abstraction-node upserts keep the newest descriptive fields. They cap source links by first insertion time, so replayed old facts count as new links without refreshing duplicates. Cue-anchor upserts merge node references and tags.

Orphan pruning runs during consolidation. It deletes an anchor only when all referenced nodes are absent. Any failed scan, unreadable node, or malformed node aborts the pass before deletion.

`harmonicRetrievalEnabled` gates abstraction-node construction. `abstractionAnchorsEnabled` independently gates cue-anchor construction and pruning. Scoped namespaces use local harmonic stores. Only the default namespace uses an explicit store override. Construction failures log a warning and preserve primary memory persistence.

Focused regressions now cover input bounds, deterministic derivation, entity collisions, namespace filtering, insertion-order retention, same-process and cross-process upserts, prune safety, independent gates, routing, searchability, and fail-open writes. Remaining work is the required repository gates, review, commit, PR, and merge verification.
