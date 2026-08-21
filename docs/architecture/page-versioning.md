# Page-Level Versioning

Issue: #371

## Overview

Page-level versioning provides snapshot-based history for memory files.
Every time a memory page (fact, entity, profile) is overwritten, the
previous content is saved as a numbered snapshot in a sidecar directory.
Users can list, inspect, diff, and revert to any prior version.

## How it differs from file rotation

| Aspect | File rotation (hygiene.ts) | Page versioning |
|--------|---------------------------|-----------------|
| Trigger | File exceeds size threshold | Every write |
| Granularity | Tail-of-file kept, rest archived | Full-page snapshot |
| Purpose | Prevent unbounded growth | Track change history |
| Revert | Manual copy from archive | `remnic versions revert` |

Both features coexist. Rotation handles growth; versioning handles history.

## Sidecar directory layout

```
~/.remnic/
  facts/
    preferences.md              <- current file
  entities/
    alice.md                    <- current entity page
  .versions/
    facts__preferences/
      manifest.json             <- version history metadata
      1.md                      <- snapshot 1
      2.md                      <- snapshot 2
    entities__alice/
      manifest.json
      1.md
      2.md
```

The sidecar key is derived from the relative path within memoryDir,
with path separators replaced by `__` and the `.md` extension stripped.

## Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `versioningEnabled` | boolean | `false` | Enable page versioning |
| `versioningMaxPerPage` | integer | `50` | Max snapshots per page (0 = unlimited) |
| `versioningSidecarDir` | string | `".versions"` | Sidecar directory name |

Example `remnic.config.json`:

```json
{
  "remnic": {
    "versioningEnabled": true,
    "versioningMaxPerPage": 100,
    "versioningSidecarDir": ".versions"
  }
}
```

## CLI commands

```bash
# List all versions of a page
remnic versions list ~/.remnic/facts/preferences.md

# Show content of a specific version
remnic versions show ~/.remnic/facts/preferences.md 3

# Diff two versions
remnic versions diff ~/.remnic/facts/preferences.md 1 5

# Revert to a previous version
remnic versions revert ~/.remnic/facts/preferences.md 3
```

All commands accept `--json` for machine-readable output.

## Storage overhead

Each version snapshot is a full copy of the page at that point in time.
For a typical memory page of 2-5 KB, 50 versions adds roughly 100-250 KB
of overhead per page. The `maxVersionsPerPage` setting automatically prunes
the oldest snapshots when the limit is exceeded.

The `.versions` directory can be excluded from search indexing (QMD, etc.)
since it contains historical data only accessed through the versioning API.

## Write triggers

Versioning hooks into these storage write paths:

- `writeMemory` / `appendToMemoryFile` -- facts and corrections
- Entity page writes (`writeEntity`)
- Profile consolidation (`writeProfile`)

Each hook snapshots the **previous** content before the overwrite occurs,
ensuring no data is lost even if the write fails.
