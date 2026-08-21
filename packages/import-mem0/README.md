# @remnic/import-mem0

Optional importer for memories stored in a mem0.ai account. Ships as a
separately installable companion to the Remnic CLI.

```bash
npm install -g @remnic/import-mem0
export MEM0_API_KEY=...
remnic import --adapter mem0 --rate-limit 2
```

## How it imports

- Walks the paginated REST endpoint `/v1/memories/` (follows `next` cursors)
- Default base URL `https://api.mem0.ai`; override via `MEM0_BASE_URL` for
  self-hosted instances
- `--rate-limit <rps>` throttles page-to-page requests
- One memory per mem0 record; blank / soft-deleted records are skipped

## Offline replay

You can also provide a pre-fetched JSON dump via `--file`:

```bash
remnic import --adapter mem0 --file ./mem0-export.json
```

The parser accepts both the flat `{ results: [...] }` shape and a multi-page
recording `{ pages: [...] }` used by the package's record/replay fixtures.

## À-la-carte contract

This package is declared as an **optional peer dependency** of
`@remnic/cli`. Installing the CLI without this package produces a
friendly install hint — never `MODULE_NOT_FOUND`.
