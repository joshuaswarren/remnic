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

The tombstone store reads legacy sources from hot, cold, and archive storage.

It reads source IDs in bounded batches and completes every available batch before publishing its index.

The source resolver scans paths lazily. It caches the complete ID map when direct filename lookup cannot resolve a frontmatter ID.

Unavailable sources remain unversioned. A later load retries them after the source becomes available.

Malformed JSONL prevents a migration rewrite. The store preserves every malformed row byte-for-byte.

The migration preserves an explicit `contentHashSource` identity because the stored body cannot prove a distinct external identity.

The fact-hash index rebuild replaces a verified legacy body hash with the current body hash.

It derives current body hashes for old files that have no stored hash.

Ambiguous legacy hashes never suppress a current Unicode write.

Entity repair re-runs the tombstone gate with the final entity reference and structured attributes.

## Deduplication strategy

Duplicate comparison tokenizes Unicode letters, marks, and numbers.

It supports scripts without whitespace, including Japanese and Korean.

Only punctuation embedded between letters or numbers separates a phrase identity.

Terminal sentence punctuation remains compatible with normalized exact matches.

## Verification state

The focused migration and non-resurrection suite passes 105 tests.

The core type check and build pass.

`preflight:quick` and the 339-test entity hardening gate pass.

The first complete workspace run found one stale normalizer-version expectation. Its focused test now passes.

The complete workspace test rerun is pending.
