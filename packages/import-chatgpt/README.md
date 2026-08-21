# @remnic/import-chatgpt

Import memory from ChatGPT data exports into [Remnic](https://github.com/joshuaswarren/remnic).

This is an optional companion package for `@remnic/cli`. Install it when you
want `remnic import --adapter chatgpt` to work.

## Install

```bash
npm install -g @remnic/cli @remnic/import-chatgpt
```

## Usage

```bash
# Dry-run: preview what would be imported without writing.
remnic import --adapter chatgpt --file ./chatgpt-export/memory.json --dry-run

# Actual import.
remnic import --adapter chatgpt --file ./chatgpt-export/memory.json

# Also import a conversation summary per chat (default: off).
remnic import --adapter chatgpt --file ./chatgpt-export/conversations.json \
  --include-conversations
```

## What gets imported

- **Saved memories** (the "Memory" feature inside ChatGPT) — 1:1 mapping.
  Every entry becomes one Remnic memory with `sourceLabel: "chatgpt"` and
  full provenance (file path, timestamp, and the original memory id).
- **Conversation summaries** — only when `--include-conversations` is set.
  Each conversation is reduced to a single memory consisting of the
  user-side turns concatenated (assistant replies are not imported).

## Export shape support

Accepts all three shapes seen in ChatGPT exports from 2024-2026:

- `{ "memory": [...] }` (2026 shape)
- `{ "memories": [...] }` (2024/2025 shape)
- Top-level array of memory records (legacy)
- `conversations.json` (mapping or inline-messages form)

## Privacy

This package only reads the export file you point at. No network calls are
made. The CLI writes to your Remnic memory store per your local config.
