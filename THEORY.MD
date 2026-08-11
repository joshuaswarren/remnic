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

The tombstone store upgrades bounded legacy entries from known source memories.

It records the migration version when a source is unavailable. Later loads do not repeat the same failed scan.

The migration preserves an explicit `contentHashSource` identity as the primary hash.

It also stores current body hash and normalized aliases when the source body is known.

Source reconstruction retains persisted structured attributes because default writes include them in the content identity.

The fact-hash index rebuild treats legacy hashes as authoritative only when the current body proves the same identity.

Ambiguous legacy hashes never suppress a current Unicode write.

Entity repair re-runs the tombstone gate with the final entity reference and structured attributes.

## Deduplication strategy

Duplicate comparison tokenizes Unicode letters, marks, and numbers.

It supports scripts without whitespace, including Japanese and Korean.

Only punctuation embedded between letters or numbers separates a phrase identity.

Terminal sentence punctuation remains compatible with normalized exact matches.

## Verification state

The focused migration and non-resurrection suite passes 90 tests.

The core type check passes.

`preflight:quick` and `test:entity-hardening` pass after the final migration-source fix.

The complete workspace suite passes 18,422 tests, with 43 skips.

An adversarial branch review found no remaining branch-introduced defect.
