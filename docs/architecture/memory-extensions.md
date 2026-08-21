# Memory Extensions Architecture

Third-party memory extensions allow external tools and integrations to provide
structured instructions that influence how Remnic's consolidation engine
interprets, groups, and synthesizes memories.

## Directory Layout

Extensions live under the memory extensions root directory, which defaults to
`<memoryDir>/../memory_extensions/` (typically `~/.openclaw/workspace/memory/memory_extensions/`).
The root can be overridden with the `memoryExtensionsRoot` config property.

```
memory_extensions/
  github-issues/
    instructions.md      # REQUIRED: how to interpret these memories
    schema.json           # OPTIONAL: memory types, grouping hints, version
    examples/             # OPTIONAL: up to 10 example .md files
      issue-closed.md
      issue-opened.md
    scripts/              # NEVER read by Remnic (read-only contract)
      install.sh
  slack-archive/
    instructions.md
    schema.json
```

## Naming Rules

Each extension lives in a subdirectory whose name is a **slug**:

- Lowercase letters, digits, and hyphens only (`[a-z0-9-]`)
- 1 to 64 characters
- Must start with a letter or digit (not a hyphen)

Invalid slugs are skipped with a warning.

## instructions.md

The only required file. Contains free-form markdown that tells the consolidation
LLM how to interpret memories this extension produces or curates. This content
is injected into consolidation prompts wrapped in a fenced code block.

Keep instructions concise. The total token budget across all extensions is
**5,000 tokens** (estimated at ~4 chars per token). Extensions are inlined in
alphabetical order until the budget is exhausted; remaining extensions are listed
in a truncation footer.

## schema.json

Optional JSON file with the following shape:

```json
{
  "memoryTypes": ["fact", "preference", "procedure", "reference"],
  "groupingHints": ["repository", "issue-number"],
  "version": "1.0.0"
}
```

All fields are optional. Invalid fields are silently ignored; a completely
malformed file causes the schema to be `undefined` (the extension still loads).

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `memoryTypes` | `string[]` | Which memory categories this extension produces. Valid values: `fact`, `preference`, `procedure`, `reference`. |
| `groupingHints` | `string[]` | Suggested grouping dimensions for consolidation clustering. |
| `version` | `string` | Semantic version of the extension. |

## Examples Directory

Up to 10 `.md` files in `examples/` are collected (sorted alphabetically) and
made available as `examplesPaths` on the discovered extension object. These are
not currently injected into prompts but reserved for future use (e.g., few-shot
examples for extraction).

## Read-Only Contract

Remnic **never** reads or executes files under any extension's `scripts/`
directory. The discovery process only touches:

- The extension root directory listing
- `instructions.md`
- `schema.json`
- `examples/*.md` file listing

## Token Budget

The total budget for all extension instructions combined is 5,000 tokens
(constant `REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT`). Token estimation uses the
4 chars = 1 token heuristic.

Extensions are rendered in alphabetical order. Once the budget is exhausted,
remaining extensions are listed by name in a truncation footer but their
instructions are not included.

## Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `memoryExtensionsEnabled` | `boolean` | `true` | Master switch for extension discovery. |
| `memoryExtensionsRoot` | `string` | `""` | Override root directory. Empty = derive from `memoryDir`. |

## Injection Points

- **Semantic consolidation** (`semantic-consolidation.ts`): Full extensions block appended to the synthesis prompt.
- **Causal consolidation** (`causal-consolidation.ts`): Full extensions block appended to the causal context.
- **Day summary** (`day-summary.ts`): One-line footer only (`Active extensions: ext1, ext2`).
- **Summary snapshot** (`summary-snapshot.ts`): One-line footer only.

## CLI Commands

```
remnic extensions list        # List discovered extensions
remnic extensions show <name> # Print instructions.md content
remnic extensions validate    # Validate all, exit non-zero on error
remnic extensions reload      # No-op stub, reserved for future caching
```

The `remnic daemon status` command also shows a memory extensions summary line.
