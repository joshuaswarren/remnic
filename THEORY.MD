# Theory: Safe Unicode Identity Migration

## Problem

Remnic used an ASCII-only normalizer for content hashes and duplicate checks.

That normalizer erased CJK and other non-ASCII text. Distinct facts could share the empty-string hash.

Equivalent Unicode forms could also miss each other without canonical composition.

Changing the normalizer fixes new writes but makes persisted identities stale.

Tombstones and fact-hash indexes must migrate without trusting lossy legacy aliases.

## Operating theory

NFC normalization makes canonically equivalent Unicode text stable.

Unicode letter, mark, and number classes retain meaningful text across scripts.

Legacy hashes are evidence only when the old and current normalized text are equal and non-empty.

An empty or changed legacy form cannot identify Unicode content safely.

The system preserves ambiguous persisted identities but does not query them as aliases for new content.

## Migration strategy

Stored content has up to three verified identity forms: raw content, cited content, and the full attributed body.

The persisted hash selects the historic identity form. The system computes a current hash only after that match.

This rule preserves explicit `contentHashSource` identities and old full-body hashes without making legacy hashes global aliases.

Tombstones can retain a current alias only when both forms come from the same source memory.

The tombstone store reads legacy sources from hot, cold, and archive storage.

It reads source IDs in bounded batches and completes every available batch before publishing its index.

Unavailable sources remain unversioned. A later load retries them after the source becomes available.

Migration or ledger-read failures leave the tombstone store unloaded.

The failed call returns the error. The next call retries before any legacy identity becomes authoritative.

Malformed JSONL rows stay byte-for-byte while valid rows migrate in place.

The fact-hash index registers every stored identity form that matches an ambiguous legacy hash.

This bounded set preserves recoverable explicit sources without making a lossy hash a global alias.

The reconcile manifest uses the same source-verified identity selection.

Ambiguous legacy hashes never suppress unrelated current Unicode content.

Entity repair re-runs the tombstone gate with the final entity reference and structured attributes.

## Deduplication strategy

Duplicate comparison tokenizes Unicode letters, marks, and numbers.

It supports scripts without whitespace, including Japanese and Korean.

Embedded punctuation records both the mark and its semantic character position.

Terminal sentence punctuation remains compatible with normalized exact matches.

## Verification state

The 110-test focused identity suite passes, including migration and ledger-read recovery.

The core type check passes.

The storage line ratchet passes at 7,314 lines, below its 7,315-line ceiling.

The mandatory preflight and entity-hardening gates passed before the final review fixes.

They require one fresh run on the final commit before merge.
