# Migrating from lossless-claw to Remnic

[lossless-claw](https://github.com/martian-engineering/lossless-claw) (LCM —
*Lossless Context Management*) is an OpenClaw plugin that replaces native
conversation compaction with a SQLite-backed message archive plus a
hierarchical summary DAG. Remnic ships its own LCM mode that uses an
almost-identical schema. This guide explains what each system does, when
to switch, and how to run the migration.

## Should you switch?

You can also **run both at once**.

| | lossless-claw | Remnic LCM mode |
|---|---|---|
| OpenClaw plugin slot | `contextEngine` | `memory` |
| What it preserves | Verbatim turns + summary DAG | Verbatim turns + summary DAG |
| Replaces native compaction? | Yes | No — complements it |
| Surfaces facts / entities / extraction? | No | Yes (Remnic's main job) |
| Storage | `~/.openclaw/lcm.db` | `<memoryDir>/state/lcm.sqlite` |
| Search | FTS5 (BM25) | FTS5 (BM25) + Remnic recall pipeline |

Because the slots are different, **a single OpenClaw config can run both
plugins side-by-side**. Useful if you want lossless-claw to keep doing
compaction substitution while Remnic builds up extracted-fact memory.

If you want Remnic to own context management end-to-end, run the importer
to migrate session history, then disable the lossless-claw plugin.

## Coexistence (no migration)

In your `openclaw.json`:

```jsonc
{
  "plugins": {
    "slots": {
      "memory": "remnic",
      "contextEngine": "lossless-claw"
    }
  }
}
```

Both subsystems read and write their own SQLite databases; they do not
share storage. No additional configuration needed.

## Switching to Remnic LCM mode

### 1. Enable Remnic's LCM mode

In your `openclaw.json` (or whatever config file the Remnic plugin reads):

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "lcmEnabled": true
        }
      }
    }
  }
}
```

The plugin entry is `openclaw-remnic`; the legacy id `openclaw-engram` is
still honored as a fallback for existing installs.

See [`docs/guides/lossless-context-management.md`](guides/lossless-context-management.md)
for the full LCM configuration reference.

### 2. Run the importer

The importer ships as a separate optional package:

```bash
npm install -g @remnic/import-lossless-claw
# or:
pnpm add @remnic/import-lossless-claw
```

Then run:

```bash
remnic import-lossless-claw --src ~/.openclaw/lcm.db
```

Common flags:

- `--src <path>` — required; the lossless-claw SQLite file
- `--dry-run` — count what would be imported without writing
- `--session-filter <id>` — repeatable; restrict to specific resolved session IDs
- `--memory-dir <path>` — override the resolved Remnic memory directory

The importer is idempotent: re-running it inserts zero new rows for
already-imported messages and summaries.

### 3. Disable lossless-claw (optional)

Once the import succeeds and you are confident Remnic's LCM mode is
serving your traffic, remove `contextEngine: "lossless-claw"` from
`plugins.slots` in your OpenClaw config. OpenClaw will fall back to its
built-in compaction strategy, which Remnic LCM is designed to complement
rather than replace.

## What migrates and what is lost

### Migrates 1:1

| lossless-claw | Remnic LCM |
|---|---|
| `messages.role, content, token_count, created_at` | `lcm_messages.role, content, token_count, created_at` |
| `messages.seq` (per-conversation) | `lcm_messages.turn_index` (session-global) — original `seq` preserved in `metadata.source_seq` |
| `summaries.summary_id, depth, content, token_count` | `lcm_summary_nodes.id, depth, summary_text, token_count` |
| `MIN/MAX(messages.seq)` per summary (via `summary_messages`) | `lcm_summary_nodes.msg_start, msg_end` |
| `conversations.session_id` (or `conversation_id` fallback) | `lcm_messages.session_id` |

### Migrates with degradation

- **Multi-parent summary nodes**: lossless-claw's summary DAG can attach
  one summary to several parents. Remnic's `lcm_summary_nodes.parent_id`
  is a single foreign key. The importer keeps the lowest-`ordinal`
  parent (lexicographic tie-break) and reports the collapse count. Most
  summary DAGs produced by default `summaryRollupFanIn = 4` are
  single-parent in practice; this only matters if the DAG was
  hand-stitched.
- **Conversation titles**: stored in the message `metadata` JSON blob
  (`{ "title": "...", "source": "lossless-claw" }`) since Remnic LCM
  has no per-conversation table.
- **Message parts**: imported into `lcm_message_parts` when the source
  database includes `message_parts`. Tool names and file paths are kept
  in indexed columns so file-aware and tool-history recall can find them
  without relying on rendered transcript text.

### Does not migrate (no Remnic LCM analog)

- `large_files` — spilled blobs and their `exploration_summary`. If you
  rely on these for recall, run the importer after first round-tripping
  the relevant exploration summaries through Remnic's normal extraction
  path so they end up in `facts/` instead of LCM.
- `conversation_compaction_telemetry`, `conversation_compaction_maintenance`
  — prompt cache / activity tracking owned by lossless-claw's
  compaction loop, not portable to Remnic.

## Import-boundary marker

For each session that gains data, the importer writes one row to
`lcm_compaction_events` with `tokens_before == tokens_after`. This
encodes "import boundary" rather than a real compaction — Remnic's own
compaction telemetry will start from this anchor. A consumer that needs
to distinguish real compactions from import boundaries can detect the
equality.

## Idempotency and safety

- Source database is opened **read-only** (`fileMustExist: true`,
  `readonly: true`).
- Inserts use natural-key existence checks (`session_id, turn_index` for
  messages; `id` for summaries) so a second run is a no-op.
- The destination database keeps its existing data — the importer only
  appends. Remnic's normal compaction will operate on the merged data.
- `--dry-run` runs every read and transformation but skips all writes.

## Troubleshooting

- **`Source database is missing lossless-claw tables: …`** — the file
  passed to `--src` does not have the lossless-claw schema. Confirm you
  pointed at `~/.openclaw/lcm.db` (or wherever your `LCM_DATABASE_PATH`
  override points).
- **`better-sqlite3 is unavailable`** — the native module needs a
  rebuild for your Node version. Run
  `pnpm rebuild better-sqlite3` (or `npm rebuild better-sqlite3 --build-from-source`).
- **Multi-parent collapse counts are higher than expected** — your
  source DAG is not a tree. The importer picks deterministic single
  parents but if you rely on the multi-parent edges for recall in
  lossless-claw, that signal will not survive the migration. Consider
  running both plugins in coexistence mode instead.

## Related documents

- [Lossless Context Management (Remnic)](guides/lossless-context-management.md) — full LCM mode reference
- [`packages/import-lossless-claw/`](../packages/import-lossless-claw/) — importer source code
