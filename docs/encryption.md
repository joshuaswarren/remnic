# At-rest encryption (secure store)

The secure store gives Remnic transparent AES-256-GCM encryption for memory files
on disk. Enable it when the machine holding your memory store is not fully trusted —
a laptop that can be lost or stolen, a device whose backups leave your control, or a
shared host where a `cat` of a memory file must not reveal its contents.

**Opt-in via `secureStoreEnabled` (default `false`).** A second key,
`secureStoreEncryptOnWrite` (default `true`), controls whether new writes are
encrypted once the store is enabled.

## Enable it

```json
{
  "secureStoreEnabled": true,
  "secureStoreEncryptOnWrite": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `secureStoreEnabled` | `false` | Enable the secure-fs layer for reads and writes. |
| `secureStoreEncryptOnWrite` | `true` | Encrypt new writes when `secureStoreEnabled` is true. Set to `false` to pause new encryptions while still decrypting existing files (useful during incremental migration). |

Enabling the config is only half the setup: you must also initialize a passphrase
and migrate existing files. See the CLI reference below.

## Threat model

### What at-rest encryption protects against

- **Physical disk compromise** — if the device's storage is read by an attacker
  (stolen laptop, forensic image, decommissioned SSD) the memory files are
  unreadable without the passphrase.
- **Cloud backup exfiltration** — if memory files are included in a cloud backup
  and that backup is accessed by a third party, the ciphertext is opaque.
- **Accidental exposure** — a `cat` of a memory file or a leaked backup tarball
  reveals only ciphertext.

### What it does NOT protect against

- **A running, unlocked daemon** — once the store is unlocked, the decryption key
  is held in memory. Any process that can communicate with the daemon (localhost
  MCP, HTTP, CLI) can retrieve plaintext memories.
- **Memory dumps** — the kernel or a privileged process can read the key from
  process memory. This is a fundamental limitation of software-only encryption.
- **Passphrase at rest** — the passphrase is never stored by Remnic, but if your
  passphrase manager is compromised, so is your memory store.
- **QMD search index** — the search backend indexes content in its own data store
  (BM25, vector embeddings). Index files are NOT currently encrypted by this
  module. Disable QMD, or enable the secure store with awareness of this gap.

### Scope

Only memory files in `facts/`, `corrections/`, `procedures/`,
`reasoning-traces/`, `artifacts/`, `archive/`, and `profile.md` are encrypted by
this module. Entity files, state files, JSON indexes, and continuity records are
not yet covered.

## CLI reference

Secure-store commands are hosted by the OpenClaw plugin runtime under the `engram`
command group. All of them take the `--memory-dir` flag (defaults to the configured
memory directory).

> Some Remnic error strings still reference the shorter `remnic secure-store`
> spelling for a standalone dispatch that is not yet wired (tracked by
> [#1532](https://github.com/joshuaswarren/remnic/issues/1532)); today the
> commands run as `openclaw engram secure-store <cmd>`.

### Initialize

```bash
openclaw engram secure-store init
```

Creates a `.secure-store/header.json` metadata file in your memory directory. You
will be prompted for a passphrase (twice for confirmation).

New stores use Argon2id by default. Use `--kdf scrypt` only when you need to create
a compatibility store that avoids the native Argon2id dependency:

```bash
openclaw engram secure-store init --kdf scrypt
```

**Minimum passphrase length:** 8 characters.

This command does NOT encrypt existing memory files. Run
`openclaw engram secure-store migrate` after init to encrypt existing files.

### Unlock

```bash
openclaw engram secure-store unlock
```

Derives the AES-256 key from your passphrase and stores it in the in-memory
keyring. The daemon can then read and write encrypted memory files.

**The key is never persisted to disk.** You must run `unlock` after every daemon
restart.

### Migrate existing files

```bash
openclaw engram secure-store unlock
openclaw engram secure-store migrate
```

Encrypts existing plaintext storage-managed memory files using the currently
unlocked secure-store key. Already-encrypted files are skipped, so the command is
safe to rerun. It requires the store to be initialized and unlocked.

`migrate` covers the storage roots already routed through Remnic's secure-fs layer.
Remaining sidecar coverage is tracked separately so the migration command does not
encrypt files that older code paths would still read as plaintext.

### Disable encryption

```bash
openclaw engram secure-store unlock
openclaw engram secure-store disable
```

Decrypts encrypted storage-managed files back to plaintext using the currently
unlocked key. Plaintext files are skipped, so the command is safe to rerun. It
requires the store to be initialized and unlocked.

The `.secure-store/header.json` metadata is kept in place. Use the `decrypt`
subcommand as an alias when you want the command name to describe the file
operation:

```bash
openclaw engram secure-store decrypt
```

### Lock

```bash
openclaw engram secure-store lock
```

Zeros the in-memory key and removes it from the keyring. The daemon can no longer
read or write encrypted files until `unlock` is run again.

### Status

```bash
openclaw engram secure-store status
```

Shows whether the store is initialized, locked, or unlocked. Prints no secret
material.

## Behavior when locked

When `secureStoreEnabled` is `true` and the store is locked, `recall` returns a
clear error instead of plaintext:

```text
[secure-store locked] Memory store is encrypted and locked. Unlock the
secure-store inside this daemon process, or restart the daemon through a
secure-store aware launcher that installs the key.
```

## Recovery

**Passphrase loss equals data loss.**

Remnic does not store your passphrase anywhere. There is no "forgot my passphrase"
recovery path. If you lose your passphrase:

- Your encrypted memory files cannot be decrypted.
- The only recovery path is restoring a **non-encrypted backup** taken before you
  migrated the memory directory to encrypted.

**Recommendation:** before enabling encryption, take a full backup of your memory
directory:

```bash
cp -r <memoryDir> <memoryDir>-backup-plaintext
```

Store the backup somewhere safe and non-encrypted (for example, an encrypted
external drive with a separately remembered passphrase).

## Naming disambiguation

Remnic uses the term **"secure-store"** for its at-rest encryption module. This is
intentional — it avoids collision with:

- **Obsidian vault** — an Obsidian workspace directory (`vaultId`, `obsidianVaults`
  config)
- **Key Vault** (Azure/AWS/GCP) — cloud secret stores
- **macOS Keychain** — system credential storage

When reading docs or config, `secure-store` always means Remnic's at-rest
encryption layer.

## Encryption format

**Algorithm:** AES-256-GCM (NIST SP 800-38D).

**KDF:** Argon2id by default, with scrypt retained for legacy/compatibility stores.

Argon2id defaults:

| Parameter | Value | Notes |
|-----------|-------|-------|
| memoryKiB | 65536 | 64 MiB memory cost |
| iterations | 3 | Time cost |
| parallelism | 4 | Parallel lanes |
| Output | 32 bytes | AES-256 key |

Legacy scrypt params:

| Parameter | Value | Notes |
|-----------|-------|-------|
| N | 2^17 = 131072 | CPU/memory cost |
| r | 8 | Block size |
| p | 1 | Parallelism |
| Memory | ~128 MiB | During key derivation |
| Output | 32 bytes | AES-256 key |

**On-disk format per file:**

```text
[MAGIC:10][VER:1][FLAGS:1] — 12-byte file header
[CIPHER_VER:1][SALT:16][IV:12][AUTHTAG:16][CIPHERTEXT:...] — AES-GCM envelope
```

- `MAGIC` = ASCII `"REMNIC-ENC"` (10 bytes) — sniffable without decryption.
- `VER` = `0x01` — file format version.
- `FLAGS` = `0x00` — reserved.
- `SALT` — per-file KDF salt (matches the metadata salt in normal operation).
- `IV` — random 96-bit GCM nonce, unique per write.
- `AUTHTAG` — 128-bit GCM authentication tag.
- `CIPHERTEXT` — AES-GCM encrypted content.

**Path-bound AAD:** the file path relative to the memory root is bound as GCM
associated authenticated data. Moving or renaming an encrypted file without
re-encrypting it will cause an auth failure on next read.

## Performance

Key derivation is paid once per `unlock` call, not per file read. Argon2id uses
64 MiB, 3 iterations, and 4 lanes by default; legacy scrypt stores use N=2^17.
Per-file encrypt/decrypt overhead is negligible (~microseconds) compared to disk
I/O.

## Caveats

- The search index (QMD) is not encrypted by this module — content is recoverable
  from the index even when memory files are ciphertext.
- Only the storage roots listed under **Scope** are covered; sidecar state and
  index files remain plaintext.
- You must `unlock` after every daemon restart; the key is never persisted.

## Cross-links

- [Capsules](capsules.md) — `remnic capsule export --encrypt` uses the same
  `seal()`/`open()` primitives from `secure-store/cipher.ts`.
- [Config reference](config-reference.md) — `secureStoreEnabled`,
  `secureStoreEncryptOnWrite`.
- [Operations](operations.md) — backup recommendations when using encryption.

## Provenance

The secure store shipped in issue
[#690](https://github.com/joshuaswarren/remnic/issues/690).
