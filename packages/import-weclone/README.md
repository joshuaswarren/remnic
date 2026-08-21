# @remnic/import-weclone

Bootstrap a [Remnic](https://github.com/joshuaswarren/remnic) memory store from
[WeClone](https://github.com/xming521/weclone)-preprocessed chat exports
(Telegram, WhatsApp, Discord, Slack) instead of waiting for memory to accumulate
through daily AI-tool usage.

This is an **optional companion** package, installed separately. Importing it
registers the WeClone adapter with Remnic's core bulk-import registry as a side
effect — no explicit setup needed.

## Install

```bash
npm install @remnic/import-weclone
```

WeClone already handles the hard parts of chat ingestion — platform-specific
export parsing, PII detection and redaction, and deduplication. Rather than
duplicate that, this package consumes WeClone's preprocessed JSON and maps it
into the bulk-import contract defined by `@remnic/core`.

## CLI usage

WeClone import runs through the orchestrator-backed `bulk-import` command in
`@remnic/core`, exposed under the `openclaw engram` command namespace (Remnic's
hosted CLI surface):

```bash
# Dry-run: parse, validate, and report counts without persisting.
openclaw engram bulk-import \
  --source weclone \
  --file ./preprocessed_telegram.json \
  --platform telegram \
  --dry-run

# Persist: run extraction over the export and write memories to disk.
openclaw engram bulk-import \
  --source weclone \
  --file ./preprocessed_telegram.json \
  --platform telegram
```

Persistence flows through the Remnic orchestrator's extraction pipeline, so each
batch is extracted the same way an organic conversation would be. Memories land
under the orchestrator's default-namespace root (`memoryDir/facts/` by default)
tagged `trustLevel: "import"`. Use `--dry-run` to validate an export before
committing to the extraction cost.

> The generic `remnic import --adapter <name>` command covers the ChatGPT,
> Claude, Gemini, Mem0, and Supermemory importers. WeClone uses the core
> bulk-import source registry instead, which is why it runs through
> `bulk-import` rather than `remnic import`.

## Supported platforms

| Platform  | `--platform` value |
|-----------|--------------------|
| Telegram  | `telegram`         |
| WhatsApp  | `whatsapp`         |
| Discord   | `discord`          |
| Slack     | `slack`            |

The parser defaults to `telegram` when no platform is given. Unknown platforms
are rejected.

## Input schema

The parser accepts either a wrapper object with a `messages` array or a raw array
of messages. Required per-message fields: `sender`, `text`, `timestamp`
(ISO-8601); optional: `message_id`, `reply_to_id`.

```json
{
  "platform": "telegram",
  "messages": [
    { "sender": "Alice", "text": "hello", "timestamp": "2025-01-10T08:00:00.000Z" }
  ]
}
```

## Programmatic use

The adapter registers automatically on import; look it up from the core registry,
or drive the pipeline stages directly:

```ts
import { readFileSync } from "node:fs";
import { parseWeCloneExport } from "@remnic/import-weclone";
import { getBulkImportSource, runBulkImportPipeline } from "@remnic/core";

const adapter = getBulkImportSource("weclone");
const source = parseWeCloneExport(
  JSON.parse(readFileSync("./export.json", "utf8")),
  { platform: "telegram" },
);

// dryRun never calls the batch callback; real persistence supplies an
// ingest callback wired to the orchestrator (see `openclaw engram bulk-import`).
const result = await runBulkImportPipeline(
  source,
  { batchSize: 20, dryRun: true, dedup: true, trustLevel: "import" },
  async () => ({ memoriesCreated: 0, duplicatesSkipped: 0 }),
);
```

Tests that call `clearBulkImportSources()` can re-register the adapter via
`ensureWecloneImportAdapterRegistered()`.

## Further reading

- Import/export guide: [docs/import-export.md](https://github.com/joshuaswarren/remnic/blob/main/docs/import-export.md)
- Monorepo: [github.com/joshuaswarren/remnic](https://github.com/joshuaswarren/remnic)

## License

MIT
