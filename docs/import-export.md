# Import, export, and backup

Remnic stores memory as plain markdown + YAML files. This guide covers portable
export/import and safe backups through the `openclaw engram` gateway CLI, plus
the bulk-import and training-export pipelines.

> Importing memory *from another platform* (ChatGPT, Claude, Gemini, mem0,
> Supermemory, lossless-claw, WeClone)? See [Memory importers](importers.md).

## Export

```bash
openclaw engram export --format json --out /tmp/engram-export
openclaw engram export --format md --out /tmp/engram-md
openclaw engram export --format sqlite --out /tmp/engram.sqlite
```

Options:
- `--include-transcripts` includes `memoryDir/transcripts` in the bundle (default: off).
- `--namespace <ns>` exports a namespace root when namespaces are enabled (v3.0+).

Formats:
- `json`: directory bundle with `manifest.json` and record files.
- `md`: directory copy of the memory directory (plus `manifest.json`).
- `sqlite`: single file export for analysis/import.

## Import

```bash
openclaw engram import --from /tmp/engram-export --format auto
openclaw engram import --from /tmp/engram.sqlite --format sqlite
openclaw engram import --from /tmp/engram-md --format md
```

Options:
- `--conflict skip|overwrite|dedupe` (default: `skip`)
- `--dry-run` validates without writing
- `--namespace <ns>` imports into a namespace root when namespaces are enabled (v3.0+)

## Backup

Backups are timestamped directory copies of the memory store:

```bash
openclaw engram backup --out-dir /tmp/engram-backups --retention-days 14
```

Notes:
- Backups are intended to be driven by your scheduler (OpenClaw cron, launchd, systemd, etc.).
- Use `--include-transcripts` only if you are comfortable backing up full transcripts.

## Bulk Import (issue #460)

Remnic can bootstrap a memory store directly from WeClone-preprocessed chat
exports (Telegram, WhatsApp, Discord, Slack) instead of waiting for organic
memory to accumulate. The import runs each batch of turns through Remnic's
extraction pipeline, so the resulting memories are the same shape as
organically captured ones.

The pipeline lives in `@remnic/core` (generic) with format-specific
adapters in separate packages. Today the WeClone adapter
(`@remnic/import-weclone`) is shipped; importing that package registers the
`weclone` source with the core registry as a side effect.

### Prerequisites

Run WeClone's preprocessing pipeline first so PII filtering and platform
parsing happen upstream. Remnic consumes WeClone's preprocessed JSON
directly — see the [WeClone docs](https://github.com/xming521/weclone) for
how to produce it.

```bash
# Dry-run: parse and validate the export without writing memories
openclaw engram bulk-import \
  --source weclone \
  --file ./preprocessed_telegram.json \
  --platform telegram \
  --dry-run

# Persist: run extraction over each batch and store memories on disk
openclaw engram bulk-import \
  --source weclone \
  --file ./preprocessed_telegram.json \
  --platform telegram

# Fail on any invalid row instead of skipping it
openclaw engram bulk-import \
  --source weclone \
  --file ./preprocessed_telegram.json \
  --platform telegram \
  --strict
```

Key flags:
- `--source <name>` — required; name of a registered bulk-import adapter.
  `weclone` is registered as a side-effect of loading
  `@remnic/import-weclone`.
- `--file <path>` — required; path to the WeClone preprocessed JSON.
- `--platform <id>` — adapter-specific hint (`telegram`, `whatsapp`,
  `discord`, `slack`). Defaults to `telegram` when omitted.
- `--batch-size <n>` — turns per extraction batch (default 50). Larger
  batches trade per-turn extraction latency for extraction-pass quality;
  smaller batches give more granular progress.
- `--dry-run` — parse and validate only; does not call extraction and does
  not write memories.
- `--strict` — treat any adapter-level validation failure as fatal.
  Without `--strict`, invalid rows are dropped and the error count is
  reported.
- `--verbose` — print per-batch error messages to stderr.

Each batch is dispatched through the same extraction path organic turns
use, so buffered extraction settings (models, judges, dedup checks) apply.
Non-dryRun invocations await extraction settlement before reporting the
per-batch `memoriesCreated` count, derived by snapshotting the memory
directory before and after each batch.

Namespace routing is not yet supported: imported memories land in the
orchestrator's configured default namespace. Installations that need to
isolate imported chat history into a dedicated namespace should configure
namespaces at the orchestrator level first and switch the default before
running the import. Per-invocation namespace override for bulk-import
writes is tracked as a follow-up.

See
[`packages/import-weclone/README.md`](../packages/import-weclone/README.md)
for the adapter-specific design notes, programmatic API, and supported
input schema.

## Training-data Export (issue #459)

Remnic can emit its structured memories as a fine-tuning dataset, skipping
the noisy raw-chat-log step that format-specific trainers normally need.

The pipeline lives in `@remnic/core` (generic) with format-specific
adapters in separate packages. Today the WeClone adapter
(`@remnic/export-weclone`) is shipped; additional adapters (Axolotl, MLX,
etc.) can implement the same `TrainingExportAdapter` interface.

```bash
# Export all memories as a WeClone-compatible Alpaca JSON dataset
remnic training:export --format weclone --output ./weclone-dataset.json

# Restrict to high-confidence memories in a date window
remnic training:export \
  --format weclone \
  --output ./weclone-dataset.json \
  --since 2026-01-01 --until 2027-01-01 \
  --min-confidence 0.7

# Only a few categories
remnic training:export \
  --format weclone \
  --output ./weclone-dataset.json \
  --categories preference,fact,skill

# Generate conversational Q/A pairs instead of raw fact records
remnic training:export \
  --format weclone \
  --output ./weclone-dataset.json \
  --synthesize

# Preview only (no file written) — useful for CI
remnic training:export \
  --format weclone \
  --output /tmp/preview.json \
  --dry-run
```

Key flags:
- `--format <name>` — required; must name a registered adapter. `weclone`
  is registered as a side-effect of loading `@remnic/export-weclone`.
- `--output <path>` / `--out <path>` — required (unless `--dry-run`).
- `--memory-dir <path>` — override the resolved memoryDir.
- `--since` / `--until` — strict ISO 8601 filters on `created`; half-open
  `[since, until)` semantics (CLAUDE.md #35).
- `--min-confidence <0..1>` — inclusive lower bound on memory confidence.
- `--categories <csv>` — only export matching categories.
- `--include-entities` — also read from `entities/` (off by default).
- `--synthesize` — emit conversational Q/A pairs via the adapter's
  synthesizer (WeClone-optimised question templates, category-driven).
- `--max-pairs-per-record <n>` — when `--synthesize` is on, cap the
  number of pairs generated per memory.
- `--no-privacy-sweep` — disable the final PII redaction pass (default:
  on). Only use when you have a compensating control.
- `--dry-run` — print statistics (record count, per-category breakdown,
  redaction count) without writing the output file.

Privacy posture:
- The output file contains only the Alpaca fields (`instruction`,
  `input`, `output`). Memory IDs, confidences, and source ranges stay in
  the memory store.
- The core converter refuses to follow `.md` symlinks or hard-linked
  files under `memoryDir`, blocking exfiltration vectors.
- Date and confidence filters run before any record is materialised in
  memory.

See
[`packages/export-weclone/README.md`](../packages/export-weclone/README.md)
for the adapter-specific docs and programmatic API.

## Migration Helpers (v8.16 Task 1)

Remnic includes bounded migration helpers under `openclaw engram migrate`:

```bash
openclaw engram migrate normalize-frontmatter
openclaw engram migrate rescore-importance
openclaw engram migrate rechunk
openclaw engram migrate reextract --model gpt-5-mini
```

All migration helpers default to dry-run. Add `--write` to apply changes and `--limit <n>` to cap scanned items.

`reextract` behavior:
- Requires explicit `--model`.
- Queues requests into `state/reextract-jobs.jsonl`.
- Applies a hard queue cap for safety; it does not directly run extraction in the CLI process.
