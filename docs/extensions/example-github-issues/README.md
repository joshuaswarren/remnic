# Publishing a Memory Extension

This directory is an example of a third-party Remnic memory extension.

## Directory Structure

A memory extension is a directory placed under `~/.remnic/memory_extensions/`
(or the configured `memoryExtensionsRoot`) with the following layout:

```
your-extension-name/
  instructions.md       # REQUIRED
  schema.json           # OPTIONAL
  examples/             # OPTIONAL (up to 10 .md files)
    example-01.md
  scripts/              # OPTIONAL (never read by Remnic)
    install.sh
```

## Required: instructions.md

This file tells Remnic's consolidation engine how to interpret the memories
your extension produces. Write it as if you are briefing an LLM that will be
synthesizing and merging these memories.

Include:
- What each memory represents
- How memories should be grouped during consolidation
- What information must be preserved vs. can be summarized
- Any importance signals or priority rules

## Optional: schema.json

Declares metadata about what your extension produces:

```json
{
  "memoryTypes": ["fact", "preference", "procedure", "reference"],
  "groupingHints": ["project-name", "category"],
  "version": "1.0.0"
}
```

- `memoryTypes`: Which Remnic memory categories your extension produces.
  Valid values: `fact`, `preference`, `procedure`, `reference`.
- `groupingHints`: Suggested dimensions for clustering during consolidation.
- `version`: Semantic version of your extension.

## Optional: examples/

Place up to 10 `.md` files showing example memories. These are reserved for
future use (e.g., few-shot prompting) but help document your extension.

## Naming Your Extension

The directory name must be a valid slug:
- Lowercase letters, digits, and hyphens only
- 1 to 64 characters
- Cannot start with a hyphen

## Token Budget

All extensions share a 5,000 token budget for their instructions. Keep your
`instructions.md` concise. Extensions are loaded alphabetically; if the budget
is exhausted, later extensions are omitted with a note.

## Read-Only Contract

Remnic will **never** execute or read files in your `scripts/` directory. The
discovery process only reads `instructions.md`, `schema.json`, and lists files
in `examples/`.

## Installation

Copy your extension directory into `~/.remnic/memory_extensions/`:

```bash
cp -r your-extension-name ~/.remnic/memory_extensions/
```

Verify with:

```bash
remnic extensions list
remnic extensions validate
```
