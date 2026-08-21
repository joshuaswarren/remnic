# Binary File Lifecycle Management

Issue #367. Manages binary files (images, PDFs, audio, video) embedded in
the memory directory through a three-stage pipeline: mirror, redirect, clean.

## Problem

Memory directories accumulate binary files from conversations, screenshots,
and document imports. These files consume disk space but are rarely
accessed after initial extraction. The binary lifecycle feature
mirrors them to a configurable backend, rewrites inline references in
markdown, and eventually removes the local copy.

## Three-Stage Pipeline

### 1. Mirror

Scan the memory directory for binary files matching configured glob
patterns (default: `*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.pdf`,
`*.mp3`, `*.mp4`, `*.wav`). Upload each to the configured storage
backend and record the operation in a manifest.

### 2. Redirect

Scan markdown files for inline references to mirrored binaries
(`![alt](./path)` or `[text](path)`) and rewrite them to point
to the backend path.

### 3. Clean

After the configured grace period (default: 7 days), delete the
local copy of mirrored+redirected files. The manifest retains the
record so the file can be retrieved from the backend if needed.

## Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `binaryLifecycleEnabled` | boolean | `false` | Master toggle |
| `binaryLifecycleGracePeriodDays` | number | `7` | Days before local cleanup |
| `binaryLifecycleBackendType` | string | `"none"` | `"filesystem"`, `"s3"`, or `"none"` |
| `binaryLifecycleBackendPath` | string | `""` | Base path for filesystem backend |

## Storage Backends

### Filesystem

Copies binaries to a local directory tree, preserving the relative
path structure from the memory directory. Suitable for NAS, external
drives, or a second partition.

### None (no-op)

Does not persist files anywhere. Useful for dry-run testing or when
only the scan/status commands are needed.

### S3 (future)

Planned support for AWS S3 / S3-compatible object storage.

## CLI Commands

```
remnic binary scan               # Scan for untracked binary files
remnic binary status             # Show lifecycle manifest summary
remnic binary run                # Run full pipeline
remnic binary run --dry-run      # Preview what would happen
remnic binary clean --force      # Force-clean past grace period
```

## Manifest

Stored at `${memoryDir}/.binary-lifecycle/manifest.json`. Uses atomic
write (temp file + rename) per CLAUDE.md #54. Schema:

```json
{
  "version": 1,
  "lastScanAt": "2026-01-15T10:00:00.000Z",
  "assets": [
    {
      "originalPath": "images/screenshot.png",
      "mirroredPath": "images/screenshot.png",
      "contentHash": "sha256hex...",
      "sizeBytes": 12345,
      "mimeType": "image/png",
      "mirroredAt": "2026-01-15T10:00:00.000Z",
      "redirectedAt": "2026-01-15T11:00:00.000Z",
      "cleanedAt": "2026-01-22T10:00:00.000Z",
      "status": "cleaned"
    }
  ]
}
```

## Migration Path for Existing Repos

1. Enable with `binaryLifecycleEnabled: true` in config.
2. Run `remnic binary scan` to see what would be managed.
3. Configure a backend (e.g., `binaryLifecycleBackendType: "filesystem"`,
   `binaryLifecycleBackendPath: "/path/to/binary-archive"`).
4. Run `remnic binary run --dry-run` to preview.
5. Run `remnic binary run` to execute.
6. After the grace period, local copies are automatically cleaned on
   subsequent pipeline runs.

## Source Files

- `packages/remnic-core/src/binary-lifecycle/types.ts` -- interfaces and defaults
- `packages/remnic-core/src/binary-lifecycle/scanner.ts` -- directory walker
- `packages/remnic-core/src/binary-lifecycle/backend.ts` -- storage backends
- `packages/remnic-core/src/binary-lifecycle/manifest.ts` -- manifest I/O
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts` -- three-stage pipeline
- `packages/remnic-core/src/binary-lifecycle/index.ts` -- barrel export
- `tests/binary-lifecycle.test.ts` -- test suite
