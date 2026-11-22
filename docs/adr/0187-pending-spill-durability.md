# Pending spill files are drained crash-safely and never cross the plaintext/encrypted boundary

Status: accepted

## Context
A lock-timed-out append leaves its rows in a pending spill file instead of the ledger. A drain that dies between claiming a spill (rename to `.claimed`) and committing it leaves the ONLY copy of those rows in the orphaned `.claimed` file, with no live spill remaining. Secure-store deployments can produce mismatches: an encrypted spill next to a plaintext ledger, or a plaintext spill next to an encrypted ledger. The spill directory itself can hold hostile filesystem entries.

## Decision
- The pre-scan for drainable targets must include crash-orphaned `*.jsonl.claimed` files, not only live spills; `recoverOrphanedClaims` restores and re-commits them. Gating solely on live spills strands those rows forever.
- An under-lock probe must refuse to read an encrypted spill through a keyless plaintext reader (it would fold ciphertext into the ledger) and must refuse to append plaintext onto an encrypted ledger; on refusal the claim rolls back so a later keyed drain can retry.
- The guarded spill lister must skip — WITHOUT opening or following — symlinks pointing outside the spill dir, FIFOs, and subdirectories; only regular files are drained. Completing the scan at all is part of the contract (opening a FIFO would hang).
- A rewrite under `secureStoreEncryptOnWrite` with an unlocked key encrypts, regardless of the current file's plaintext header.
- Secure-store lock gates reject with a clear error rather than surfacing a cryptic SecureStoreLockedError.

## Consequences
No spill rows are ever lost to a crash or a lock timeout, and encryption state never silently degrades. The cost is claim/rollback bookkeeping and an encryption probe per spill before any plaintext I/O.

## Origin comments

- `packages/remnic-core/src/orchestration/maintenance.test.ts:2314` — "// Namespaces enabled but NO catalog storage wired: only the filesystem"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2315` — "// fallback finds this per-namespace ledger, so target.storage is absent."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2321` — "// A plaintext pending spill, exactly as a lock-timed-out append leaves it."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2370` — "// A drain that died between claiming a spill (rename to `.claimed`) and"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2371` — "// committing it leaves the ONLY copy of those rows as a crash-orphaned"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2372` — "// `*.jsonl.claimed` file — NO live `*.jsonl` spill remains. The pre-scan"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2373` — "// must still reach the recovery drain so recoverOrphanedClaims restores and"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2374` — "// re-commits it; gating solely on live spills stranded these rows forever."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2433` — "// nsA: plaintext (empty) ledger + an ENCRYPTED pending spill, exactly as a"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2434` — "// secure-store writer's lock-timeout leaves it. A keyless plaintext readFile"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2435` — "// would fold ciphertext into the ledger; the under-lock probe must refuse it."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2447` — "// nsB: ENCRYPTED ledger + a PLAINTEXT pending spill. A keyless plaintext"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2448` — "// appendFile would append plaintext onto the encrypted ledger; the under-lock"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2449` — "// append probe must refuse it and roll the claim back."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2748` — "// unlocked + encrypt-on-write ⇒ the rewrite encrypts."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2811` — "// Unsafe entries the guarded lister MUST skip WITHOUT opening/following:"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2812` — "// - a symlink to an OUTSIDE file (following it would escape the spill dir),"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2813` — "// - a FIFO (opening it for read would block until a writer appears),"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2814` — "// - a subdirectory (not a regular file)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2833` — "// Completing at all is part of the assertion: opening the FIFO would hang"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2834` — "// (caught by the test timeout) and following the symlink would escape."
- `packages/remnic-core/src/orchestration/recall-entry.ts:146` — "Secure-store lock gate... reject with clear error rather than cryptic SecureStoreLockedError."
