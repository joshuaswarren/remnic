# @remnic/import-supermemory

Import a Supermemory JSON export into Remnic.

This package is an optional companion for `@remnic/cli`. Install it only when
you want to migrate memories out of Supermemory and into Remnic's local memory
store.

## Install

```bash
npm install -g @remnic/cli
npm install -g @remnic/import-supermemory
```

If you use Remnic from a project instead of globally, add both packages to the
same project:

```bash
pnpm add @remnic/cli @remnic/import-supermemory
```

## Export From Supermemory

Export or collect your Supermemory memories as JSON. The importer accepts:

- A flat JSON array of memory objects.
- An object with one of these array keys: `memoryEntries`, `memories`,
  `results`, or `data`.

Each memory can provide content in `content`, `memory`, `summary`, or `title`.
Remnic keeps Supermemory IDs, timestamps, container tags, source metadata, and
the source file path when they are present.

If your Supermemory export is paginated, combine the pages into one flat array
or into an object like this:

```json
{
  "memories": [
    {
      "id": "mem_123",
      "content": "The user prefers short release notes.",
      "updatedAt": "2026-05-05T12:00:00Z",
      "containerTags": ["product"]
    }
  ]
}
```

## Dry Run First

Run a dry run before writing anything:

```bash
remnic import --adapter supermemory --file ./supermemory-memories.json --dry-run
```

When the count and warnings look right, run the import:

```bash
remnic import --adapter supermemory --file ./supermemory-memories.json
```

The importer writes records with `sourceLabel: "supermemory"` and
`metadata.kind: "supermemory_memory"` so you can audit where imported memories
came from later.

## Privacy

Parsing and writing run locally. If your Remnic extraction or consolidation
pipeline is configured to use a remote model provider, imported content may be
sent to that provider during normal Remnic processing. Use local model routing
or gateway settings if you need the full migration path to stay local.

## API

```ts
import { adapter, supermemoryAdapter } from "@remnic/import-supermemory";
```

Both exports expose the same Remnic importer adapter:

- `name: "supermemory"`
- `sourceLabel: "supermemory"`
- `parse(input, options)`
- `transform(parsed)`
- `writeTo(target, memories)`

## More Documentation

- Remnic importer docs: https://github.com/joshuaswarren/remnic/blob/main/docs/importers.md
- Supermemory migration guide: https://remnic.ai/guides/import-supermemory/
- Package source: https://github.com/joshuaswarren/remnic/tree/main/packages/import-supermemory
