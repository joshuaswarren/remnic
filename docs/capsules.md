# Memory capsules

Capsules are portable, versioned archives of a Remnic memory directory. They
use the V2 bundle format which carries a `capsule` metadata block alongside the
memory records. Unlike the older `export` / `import` commands (see
[import-export.md](./import-export.md)), capsules are designed for:

- **Sharing** — a capsule can be imported on a different machine or namespace.
- **Reproducibility** — the capsule manifest records SHA-256 checksums for
  every file, so imports are tamper-evident.
- **Encryption** — with the `--encrypt` flag, the archive payload is sealed
  with AES-256-GCM using the secure-store master key. Encrypted capsules can be
  transferred across machines as long as the same passphrase is available on
  the destination.

## Command surfaces

Capsule tooling is split across the two Remnic CLI surfaces, and this matters
for which binary you invoke:

- **Standalone `remnic capsule`** dispatches exactly two subcommands: `fork`
  and `lineage`. These operate directly on archive files and memory roots.
- **Hosted `openclaw engram`** owns the full capsule lifecycle
  (`capsule export`, `import`, `merge`, `list`, `inspect`) plus the
  `secure-store` and `backup` commands that encryption depends on. These run
  through the OpenClaw gateway / plugin runtime, not the standalone binary.

The rest of this page uses `openclaw engram …` for the hosted commands and
`remnic capsule …` only for `fork` / `lineage`.

Provenance: capsule V2 bundle format and encryption land in issues #676 and
#690.

---

## Quick start

### 1. Initialize a secure store (once per memory directory)

```bash
openclaw engram secure-store init
# Prompts for a passphrase; writes .secure-store/header.json
```

### 2. Unlock the store before any encrypt / decrypt operation

```bash
openclaw engram secure-store unlock
# Prompts for the passphrase; registers the key in the daemon's keyring
```

### 3. Export an encrypted capsule

```bash
openclaw engram capsule export \
  --name my-capsule \
  --encrypt
# Writes: <memoryDir>/.capsules/my-capsule.capsule.json.gz.enc
# Sidecar: <memoryDir>/.capsules/my-capsule.manifest.json
```

### 4. Import a capsule (auto-detects encryption)

```bash
openclaw engram capsule import /path/to/my-capsule.capsule.json.gz.enc
```

The import command reads the REMNIC-ENC magic header and automatically
decrypts the archive before unpacking. The secure-store must be unlocked on
the destination machine.

---

## Hosted capsule commands (`openclaw engram capsule`)

### `openclaw engram capsule export`

```
openclaw engram capsule export [options]

Options:
  --name <id>             Capsule id (alphanumeric + dashes, max 64 chars). Required.
  --out-dir <dir>         Output directory. Default: <memoryDir>/.capsules
  --since <iso8601>       Only include files modified on or after this date.
                          Accepts YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ (explicit timezone required).
  --include-kinds <list>  Comma-separated top-level subdirectory allow-list
                          (e.g. facts,entities,corrections). When set, only files
                          whose first path segment is in the list are exported.
  --include-transcripts   Include transcript files (excluded by default).
  --peer-ids <list>       Comma-separated peer id allow-list for the peers/ subtree.
  --encrypt               Seal the archive with the secure-store master key.
                          The store must be unlocked before running this command.
  --namespace <ns>        Namespace (v3.0+, default: config defaultNamespace).
```

**Output files:**

- `<name>.capsule.json.gz` — the archive (plaintext export, not encrypted)
- `<name>.capsule.json.gz.enc` — the encrypted archive (only when `--encrypt`)
- `<name>.manifest.json` — sidecar manifest for inspection without decompression

When `--encrypt` is used, the plaintext `.gz` is written first, then replaced
by the `.enc` file. A crash between the two steps leaves the plaintext `.gz`
on disk (recoverable). The `.manifest.json` sidecar is always plaintext for
cheap inspection.

### `openclaw engram capsule import`

```
openclaw engram capsule import <archive> [options]

Arguments:
  archive                 Path to a .capsule.json.gz or .capsule.json.gz.enc archive.

Options:
  --mode <mode>           Conflict resolution: skip (default), overwrite, fork.
  --namespace <ns>        Target namespace (v3.0+, default: config defaultNamespace).
```

**Conflict modes:**

| Mode | Behaviour |
|------|-----------|
| `skip` | Existing files are left untouched; the record is reported as skipped. |
| `overwrite` | Existing files are snapshotted via page-versioning, then overwritten. |
| `fork` | Records are rebased under `forks/<capsule-id>/` so the original tree is never modified. |

**Encryption auto-detection:**

The import command checks the first bytes of the archive file for the
`REMNIC-ENC` magic header. When found, it decrypts in-memory before unpacking.
The secure-store must be unlocked on the destination machine before importing.

### `openclaw engram capsule merge`

Three-way merge a capsule archive into the current memory directory.

- Files that **exist only in the archive** are always written.
- Files that are **byte-identical** (same SHA-256) are skipped silently.
- Files that **differ** are conflicts, resolved by `--conflict-mode`.

```
openclaw engram capsule merge <archive> [options]

Arguments:
  archive                   Path to a .capsule.json.gz (or .enc) archive.

Options:
  --conflict-mode <mode>    Conflict resolution: skip-conflicts (default), prefer-source, prefer-local.
```

**Conflict modes:**

| Mode | Behaviour |
|------|-----------|
| `skip-conflicts` | Keep local file; skip the archive entry; continue processing. |
| `prefer-source` | Snapshot the local file via page-versioning, then overwrite with the archive content. |
| `prefer-local` | Keep the local file; skip the archive entry (explicitly chosen, not just a fallback). |

**Example:**

```bash
# Merge a peer's capsule, keeping your local changes on conflict
openclaw engram capsule merge shared.capsule.json.gz --conflict-mode prefer-local

# Merge and take the incoming version on conflict (with local snapshot)
openclaw engram capsule merge update.capsule.json.gz --conflict-mode prefer-source
```

### `openclaw engram capsule list`

List all capsule archives in the capsule store directory. Reads each sidecar `.manifest.json` for metadata — no decompression needed.

```
openclaw engram capsule list [options]

Options:
  --dir <path>     Override the capsule store directory. Default: <memoryDir>/.capsules
  --format <fmt>   Output format: text (default), markdown, json.
```

**Example output (text):**

```
daily-backup  [2026-04-26] [47 files]  Daily backup capsule
weekly-facts  [2026-04-21] [12 files]  Facts only
shared-bundle [2026-04-15] [83 files]
```

**Example output (json):**

```json
{
  "capsules": [
    {
      "id": "daily-backup",
      "archivePath": "/path/to/.capsules/daily-backup.capsule.json.gz",
      "manifestPath": "/path/to/.capsules/daily-backup.manifest.json",
      "createdAt": "2026-04-26T00:00:00.000Z",
      "pluginVersion": "9.6.22",
      "fileCount": 47,
      "description": "Daily backup capsule"
    }
  ]
}
```

### `openclaw engram capsule inspect`

Show a capsule manifest without extracting the archive. Reads the sidecar `.manifest.json` when present (cheap, no decompression); decompresses the archive only if the sidecar is absent.

The `<archive>` argument accepts:
- An absolute or relative file path to a `.capsule.json.gz` (or `.enc`) file.
- A capsule **id** — looked up as `<capsulesDir>/<id>.capsule.json.gz`.

```
openclaw engram capsule inspect <archive> [options]

Arguments:
  archive         Path to a .capsule.json.gz archive, or a capsule id.

Options:
  --format <fmt>  Output format: text (default), markdown, json.
```

**Example:**

```bash
# By id (looks up <memoryDir>/.capsules/daily-backup.capsule.json.gz)
openclaw engram capsule inspect daily-backup

# By path
openclaw engram capsule inspect /path/to/daily-backup.capsule.json.gz --format json
```

---

## Standalone capsule commands (`remnic capsule`)

The standalone binary handles capsule **forking** — deriving a new memory root
from an existing capsule archive with a recorded lineage breadcrumb.

### `remnic capsule fork`

```
remnic capsule fork <source-archive> --target <root> --fork-id <id>

Arguments:
  source-archive           Path to a .capsule.json.gz archive.

Options:
  --target <root>          Memory root to import into (required).
  --fork-id <id>           Unique fork identifier (required).
```

Records are imported under `forks/<source-capsule-id>/` and a lineage
breadcrumb (parent capsule id + version) is written to
`forks/<fork-id>/lineage.json`, so a fork always knows where it came from.

### `remnic capsule lineage`

```
remnic capsule lineage --root <dir> --fork-id <id>
```

Reads and prints the lineage breadcrumb for a fork — the parent capsule id,
its version, and the fork root.

---

## Backup (`openclaw engram backup`)

```bash
openclaw engram backup --out-dir /path/to/backups --encrypt
```

The `--encrypt` flag produces a single encrypted `.backup.json.gz.enc` file
instead of a plaintext timestamped directory. The secure-store must be
unlocked before running the backup.

---

## Encrypted archive format

Encrypted capsule and backup files use a simple binary format:

```
[MAGIC: 11 bytes]  "REMNIC-ENC\x00" — ASCII magic + NUL sentinel
[VERSION: 1 byte]  Format version (currently 2)
[KDF_LEN: 2 bytes] Little-endian byte length of the KDF JSON section
[KDF_JSON]         Compact JSON: { algorithm, params, salt }
[ENVELOPE: rest]   AES-256-GCM sealed envelope (cipher.ts format):
                     [VERSION:1][SALT:16][IV:12][AUTHTAG:16][CIPHERTEXT:...]
                   The ciphertext is the original .gz payload.
```

The REMNIC-ENC magic is:

- ASCII-safe — no UTF-8 confusion.
- Obviously non-JSON — will not parse as `{...}`.
- Obviously non-gzip — gzip magic is `0x1f 0x8b`; `R` is `0x52`.

The KDF algorithm, parameters, and salt are embedded in the archive header, so
the file is self-contained: any machine that knows the original passphrase can
re-derive the same key and decrypt without any external metadata.

The destination file's basename (without the `.enc` suffix) is bound into
the AES-GCM AAD. Renaming an encrypted archive triggers an authentication
failure on open.

---

## Cross-machine restore

To restore an encrypted capsule on a different machine:

1. Copy the `.enc` archive and (optionally) the `.manifest.json` sidecar to
   the destination.
2. Initialize the secure store on the destination with the **same passphrase**:
   ```bash
   openclaw engram secure-store init
   ```
   The recorded KDF is deterministic: the same passphrase plus the embedded
   KDF parameters and salt produces the same key, so you do not need to
   transfer any key material out-of-band.
3. Unlock the store:
   ```bash
   openclaw engram secure-store unlock
   ```
4. Import the capsule:
   ```bash
   openclaw engram capsule import /path/to/my-capsule.capsule.json.gz.enc
   ```

> **Important:** The passphrase must match. The key is derived from the
> passphrase using the algorithm, parameters, and salt stored inside the
> encrypted archive. A different passphrase produces a different key and
> decryption fails with an authentication error.

---

## Key requirements

- The secure-store must be **initialized** (`openclaw engram secure-store init`)
  before any encrypt or decrypt operation.
- The secure-store must be **unlocked** (`openclaw engram secure-store unlock`)
  in the currently running daemon before `capsule export --encrypt`,
  `capsule import` (on encrypted archives), or `backup --encrypt`.
- The daemon's in-memory key is **cleared on restart**. Re-run `unlock` after
  any daemon restart.
- If you lose the passphrase you cannot recover the encrypted archive. Store
  the passphrase in a password manager.

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Secure-store is locked or not initialized` | The daemon does not hold a key for this memory directory. | Run `openclaw engram secure-store unlock` (or `init` if not yet set up). |
| `authentication failed — wrong passphrase, tampered archive` | Wrong passphrase on the destination, or the archive bytes were modified. | Verify the passphrase matches the one used during `init`. If the archive was transferred, check the hash. |
| `unsupported encrypted-capsule format version N` | The archive was produced by a newer version of Remnic. | Upgrade Remnic on the destination machine. |
| `'memoryDir' is required when 'encrypt' is true` | The export API was called programmatically without providing `memoryDir`. | Pass `memoryDir` to `exportCapsule()`. |
