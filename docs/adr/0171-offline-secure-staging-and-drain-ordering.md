# Offline plaintext stages only inside the protected memory root with inherited encryption, config values never leak through diagnostics, and the sync snapshot is built only after the impression drain commits

Status: accepted

## Context
Decryption must stage whole plaintext before yielding chunks, and `os.tmpdir()` can be world-readable, a shared tmpfs, or unencrypted storage another local process can inspect — a crash there could strand secure-store plaintext outside the store (#2033 P1). Reclaiming staging orphans risks deleting an in-flight transfer: root mtime does not prove abandonment (active transfers write nested upload files and may be older than a cutoff), and PID reuse or EPERM makes ownership checks ambiguous. A fresh staging root has no keyring header of its own. `parseConfig` embeds offending values in thrown messages and warns from its numeric-coercion path, and Node's `JSON.parse` error quotes surrounding input — so a hostile or typo'd config can place an operator secret (an API key) where a rotation number belongs and leak it through diagnostics; fields offline never consumes would otherwise throw and abort the whole parse. The daemon merges `REMINIC_HOST`/`REMINIC_PORT` over the config file, so the CLI must target the same endpoint or it hits the wrong port. The offline sync builds push snapshots while pending spills live in an excluded dir, and a configured size cap can conflict with a pending row.

## Decision
1. Decrypted plaintext stages ONLY inside the secure-store-protected memory root — never `os.tmpdir()`. Staging uses `mkdtemp` (owner-only 0700, unique directory), the content file is 0600, and the directory is removed in `finally`; a hard-crash orphan stays owner-only inside the protected root — the same trust domain as the encrypted originals. Because the whole plaintext is staged before the first chunk is yielded, the staging location is observable only inside the memory root.
2. Orphan reclaim is conservative: EPERM/unknown ownership and reused PIDs are KEEPS; age alone never proves an oversized transfer is abandoned, and root mtime never establishes orphanhood. Tampering with staged ciphertext fails the authenticated decrypt instead of yielding forged content.
3. A fresh staging root inherits the parent vault's secure-store policy (keyring header) so staged bytes are encrypted at rest with the same key — never a plaintext downgrade of the vault.
4. Config values never leak through offline diagnostics: parse errors must not stringify the offending value verbatim into thrown messages or stderr (including the numeric-coercion `console.warn` path and JSON.parse's quoted input); the redacted parse suppresses coercion diagnostics so the raw value never reaches stderr even though a warning would otherwise fire. Fields offline never consumes are DROPPED, not thrown on, so a secret-bearing invalid value in an unconsumed field still resolves rotation from the valid offline keys. A zero rotation size means "unset" — the 32 MiB writer default applies — because 0 would silently disable rotation during a pre-sync drain, the exact regression #2033 guards against.
5. The CLI resolves daemon endpoint settings exactly as the daemon does (environment merged over the file), and a placeholder token must never shadow the real environment token.
6. Impression drain ordering: the push snapshot is built AFTER the drain commits, so drained impressions fold into the snapshot instead of being stranded in the excluded pending dir and never folded — this holds for the first snapshot and for a SECOND snapshot rebuilt after a large-file direct push. A pending row that would exceed the configured cap DEFERS the spill — a configured bound must not silently fall back to rotation-off or move rows into an excluded archive. If the active ledger path is a directory so appends can never commit, the drain ABORTS before any snapshot is built or pushed, rather than shipping a snapshot that omits the durable row.
7. With persisted classifications present, the warm path skips the per-file read+parse the plain exclusion performs for every candidate.

## Consequences
Crash orphans consume protected-root space until conservative reclaim removes them. Misconfigurations fail closed without echoing secrets, at the cost of suppressing coercion warnings on the offline path. Drains serialize against snapshot building, and an unwritable ledger blocks sync entirely rather than shipping an incomplete snapshot.

## Origin comments
- `packages/remnic-cli/src/offline-generation-staging.ts:106` — "// EPERM/unknown ownership and reused PIDs are conservative keeps."
- `packages/remnic-cli/src/offline-generation-staging.ts:107` — "// Age alone never proves that an oversized transfer is abandoned."
- `packages/remnic-cli/src/offline-generation-staging.ts:162` — "// The fresh staging root has no keyring header of its own; inherit the"
- `packages/remnic-cli/src/offline-generation-staging.ts:163` — "// parent vault's secure-store policy so staged bytes are encrypted at"
- `packages/remnic-cli/src/offline-generation-staging.ts:164` — "// rest with the same key instead of plaintext-downgrading the vault."
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:9` — "// A value a hostile/typo'd config might put where a rotation number belongs. It"
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:10` — "// stands in for an operator secret (API key) that parseConfig would otherwise"
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:11` — "// stringify verbatim into its thrown error message."
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:32` — "// The writer default is 32 MiB; 0 would silently disable rotation during a"
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:33` — "// pre-sync drain, the exact regression #2033 guards against."
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:41` — "// A string where an integer is expected makes parseConfig throw a message that"
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:42` — "// embeds the offending value verbatim (`got "<value>"`), and - with no logger"
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:43` — "// installed - console.warn the same raw value from its numeric coercion path."
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:65` — "// The redacted parse suppresses parseConfig's own coercion diagnostic, so the"
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:66` — "// raw value never reaches stderr even though a warning would otherwise fire."
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:76` — "// Invalid JSON (trailing comma) whose bytes embed a secret. Node's JSON.parse"
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:77` — "// error quotes surrounding input, so the raw message can leak the secret."
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:94` — "// A field offline never consumes (`correction.maxAffected`) with an invalid,"
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:95` — "// secret-bearing value. Full parseConfig would THROW on it; the offline path"
- `packages/remnic-cli/src/offline-impression-rotation.test.ts:96` — "// must drop it and still resolve rotation from valid offline keys."
- `packages/remnic-cli/src/offline-storage-io.test.ts:290` — "// The whole plaintext is staged before the first chunk is yielded, so the"
- `packages/remnic-cli/src/offline-storage-io.test.ts:291` — "// staging dir is observable HERE - and it must live under the memory root,"
- `packages/remnic-cli/src/offline-storage-io.test.ts:292` — "// never in world-readable os.tmpdir()."
- `packages/remnic-cli/src/offline-storage-io.test.ts:624` — "// Root mtime does not establish orphanhood: an active transfer writes"
- `packages/remnic-cli/src/offline-storage-io.test.ts:625` — "// nested upload files and may be older than the former one-hour cutoff."
- `packages/remnic-cli/src/offline-storage-io.test.ts:680` — "// Tampering with the staged ciphertext fails the authenticated"
- `packages/remnic-cli/src/offline-storage-io.test.ts:681` — "// decrypt instead of yielding forged content."
- `packages/remnic-cli/src/offline-storage-io.ts:170` — "// With persisted classifications the warm path skips the per-file"
- `packages/remnic-cli/src/offline-storage-io.ts:171` — "// read+parse the plain exclusion performs for every candidate."
- `packages/remnic-cli/src/offline-storage-io.ts:316` — "// Stage the decrypted plaintext INSIDE the secure-store-protected memory"
- `packages/remnic-cli/src/offline-storage-io.ts:317` — "// root, never os.tmpdir() (#2033 P1): /tmp can be world-readable, shared"
- `packages/remnic-cli/src/offline-storage-io.ts:318` — "// tmpfs, or on unencrypted storage another local process can inspect, so a"
- `packages/remnic-cli/src/offline-storage-io.ts:319` — "// crash there could strand secure-store plaintext outside the store. mkdtemp"
- `packages/remnic-cli/src/offline-storage-io.ts:320` — "// creates an owner-only (0700) unique dir; the content file is 0600 and the"
- `packages/remnic-cli/src/offline-storage-io.ts:321` — "// dir is removed in `finally`. A hard-crash orphan stays owner-only inside"
- `packages/remnic-cli/src/offline-storage-io.ts:322` — "// the protected root - the same trust domain as the encrypted originals."
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:63` — "// Only the excluded pending spill exists — the active file does not yet. If"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:64` — "// the snapshot at index.ts:9051 were built before the drain, the recorded"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:65` — "// impression would be stranded in the excluded pending dir and never folded."
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:195` — "// A large file forces the direct-push path, so a SECOND push snapshot is"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:196` — "// rebuilt at index.ts:9222 (guarded by directPushedPaths.size > 0). The"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:197` — "// drained impression must remain folded on disk across that rebuild."
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:276` — "// The active file fits below the configured cap, but the pending row would"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:277` — "// exceed it. A configured bound must defer the spill rather than silently"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:278` — "// falling back to rotation-off or moving rows into an excluded archive."
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:344` — "// A real pending spill is present, but the active impression path is a"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:345` — "// directory, so every append attempt fails. The durable row cannot be"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:346` — "// committed, and the drain helper must abort before building a snapshot."
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:412` — "// Only the excluded lifecycle pending spill exists. If the snapshot were"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:413` — "// built before the lifecycle drain, this promotion row would be stranded in"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:414` — "// the excluded pending dir and dropped on a push-then-discard."
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:471` — "// The active ledger path is a DIRECTORY, so the fold's append fails on every"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:472` — "// attempt: the durable row can never be committed, so the drain aborts rather"
- `packages/remnic-cli/src/offline-sync-impression-drain.test.ts:473` — "// than let runOfflineSyncOnce build and push a snapshot that omits it."
