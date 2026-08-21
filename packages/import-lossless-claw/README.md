# @remnic/import-lossless-claw

Migrate a [lossless-claw](https://github.com/martian-engineering/lossless-claw)
LCM SQLite database into Remnic's LCM mode.

## Why this exists

Remnic ships its own *lossless context management* mode whose schema is
near-isomorphic to lossless-claw's. This package is a SQLite→SQLite
importer for users who want to switch from lossless-claw to Remnic without
losing session history.

For coexistence (running both side-by-side) and the full migration story,
see [`docs/lcm-to-remnic-migration.md`](../../docs/lcm-to-remnic-migration.md).

## Install

```bash
npm install -g @remnic/import-lossless-claw
# or
pnpm add @remnic/import-lossless-claw
```

The CLI command lives in `@remnic/cli`; this package is loaded lazily on
demand via the à-la-carte loader (CLAUDE.md gotcha #57).

## Usage

```bash
remnic import-lossless-claw --src ~/.openclaw/lcm.db
remnic import-lossless-claw --src ~/.openclaw/lcm.db --dry-run
remnic import-lossless-claw --src ~/.openclaw/lcm.db --session-filter sess-A
```

The destination is `<memoryDir>/state/lcm.sqlite`, which Remnic creates
automatically when `lcmEnabled: true` is set in plugin config.

## Programmatic API

```ts
import {
  importLosslessClaw,
  openSourceDatabase,
} from "@remnic/import-lossless-claw";
import { ensureLcmStateDir, openLcmDatabase } from "@remnic/core";

const sourceDb = openSourceDatabase("/path/to/lcm.db");
await ensureLcmStateDir("/path/to/memoryDir");
const destDb = openLcmDatabase("/path/to/memoryDir");

const result = importLosslessClaw({
  sourceDb,
  destDb,
  dryRun: false,
  sessionFilter: new Set(["sess-A"]),
  onLog: (line) => console.log(line),
});

sourceDb.close();
destDb.close();
```

## Idempotency

Re-running the importer inserts zero new rows. Messages dedupe on the
source identity stored in metadata: `(session_id, conversation_id,
source_seq)`. Destination `turn_index` values are assigned
session-globally as rows are appended, so they remain stable for already
imported source messages but are not the dedupe key. Summary nodes dedupe
on `id`.

## What's lossy

- Multi-parent summary DAG → single-parent (lowest `ordinal` wins,
  lexicographic tie-break). Count reported in result.
- `large_files` and compaction telemetry — no Remnic LCM analog, skipped
  silently.

`message_parts` is imported when present, including indexed `tool_name`
and `file_path` columns for structured recall.

See the migration doc for the full mapping table.

## License

MIT
