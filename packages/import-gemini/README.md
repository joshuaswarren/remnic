# @remnic/import-gemini

Optional importer for Google Takeout "Gemini Apps Activity" exports. Ships
as a separately installable companion to the Remnic CLI.

```bash
npm install -g @remnic/import-gemini
remnic import --adapter gemini --file ~/takeout/My\ Activity.json
```

## What it imports

- **One memory per prompt** — every Gemini Apps activity record becomes one
  memory containing the user prompt text. Assistant responses are NOT
  imported because Google Takeout does not export them.
- Legacy "Bard" records are included (pre-rebrand exports).
- Short prompts (under 10 characters by default) are dropped because they
  rarely carry durable intent.

## Input shapes

- `My Activity.json` — Google Takeout's Gemini activity export
- A combined bundle object `{ "activities": [...] }`

Synthetic fixtures under `fixtures/` mirror the real shapes without any
personal data.

## À-la-carte contract

This package is declared as an **optional peer dependency** of
`@remnic/cli`. Installing the CLI without this package produces a
friendly install hint — never `MODULE_NOT_FOUND`.
