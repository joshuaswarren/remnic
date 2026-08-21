# @remnic/import-claude

Optional importer for Claude.ai data exports. Ships as a separately
installable companion to the Remnic CLI.

```bash
npm install -g @remnic/import-claude
remnic import --adapter claude --file ~/claude-export/projects.json
```

## What it imports

- **Project docs** (default): every `docs[].content` becomes one memory with
  `metadata.kind = "project_doc"`.
- **Project prompt templates** (default): every non-empty
  `prompt_template` becomes one memory with `metadata.kind =
  "project_prompt_template"`.
- **Conversation summaries** (opt-in via `--include-conversations`): one
  memory per conversation summarizing the human-authored turns. Assistant
  turns are never imported verbatim.

## Input shapes

The adapter accepts either:

- `projects.json` — array of Claude projects with `docs` and `prompt_template`
- `conversations.json` — array of conversations with `chat_messages`
- A combined bundle object `{ "projects": [...], "conversations": [...] }`

Synthetic fixtures under `fixtures/` mirror the real shapes without any
personal data.

## À-la-carte contract

This package is declared as an **optional peer dependency** of
`@remnic/cli`. Installing the CLI without this package produces a
friendly install hint — never `MODULE_NOT_FOUND`.
