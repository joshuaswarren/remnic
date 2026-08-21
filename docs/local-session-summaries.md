# Local AI session summary drafts

Remnic can harvest local AI session transcripts into privacy-first summary
drafts. This feature is intentionally generic: it reads JSON or JSONL files
from a directory, parses transcript-like rows with a pluggable adapter, applies
redaction, and writes only compact summaries plus metadata.

It does not store raw transcript text by default. It also does not store source
file paths or raw source session keys.

## Public adapter shape

Adapters implement `LocalSessionSourceAdapter` from `@remnic/core`:

```ts
export interface LocalSessionSourceAdapter {
  id: string;
  parseFile(
    input: {
      content: string;
      fileName: string;
      fileExtension: string;
      fileRef: string;
    },
    options?: { strict?: boolean },
  ): LocalSessionParsedFile | Promise<LocalSessionParsedFile>;
}
```

Built-in adapters:

- `generic-jsonl`
- `codex-jsonl`
- `claude-jsonl`

The built-ins are deliberately shape-based. They look for common transcript
fields such as `role`, `sender`, `content`, `text`, `message`, `timestamp`,
`sessionKey`, `conversation_id`, and `thread_id`. They do not know any
install-specific transcript paths.

## Programmatic use

```ts
import { runLocalSessionSummaryCliCommand } from "@remnic/core";

await runLocalSessionSummaryCliCommand({
  inputDir: "./local-transcripts",
  source: "generic-jsonl",
  memoryDir: "./remnic-memory",
  write: true,
});
```

Without `write: true`, the runner returns a dry-run report and writes nothing.
With `write: true`, it writes JSONL summary drafts under:

```text
<memoryDir>/state/session-summary-drafts/
```

These files are draft artifacts, not durable memory files. A later importer or
review workflow can decide which summaries should become memories.

## Redaction

Default redaction rules replace:

- secret-like tokens and `KEY=value` strings
- email addresses
- private IPv4 addresses
- HTTP and HTTPS URLs
- absolute POSIX and Windows paths

Custom rules can be supplied inline or through a JSON file:

```json
{
  "rules": [
    {
      "name": "ticket",
      "pattern": "\\bABC-\\d+\\b",
      "replacement": "[REDACTED_TICKET]"
    }
  ]
}
```

Set `includeRedactedExcerpts: true` only when you want short sanitized excerpts
inside draft artifacts. The default metadata-only mode stores no transcript
excerpts at all.

## Draft privacy contract

Each `SessionSummaryDraft` records:

- hashed source session reference
- hashed source file references and file extensions
- turn counts and role counts
- first and last timestamps when available
- a generic summary string
- redaction counts and rule names

Each draft declares:

```json
{
  "storesRawTranscript": false,
  "storesLocalPaths": false,
  "storesSourceSessionKey": false
}
```

Adapters should preserve that contract. If an adapter needs source-specific
metadata, store hashes or stable public labels instead of machine-local paths,
hostnames, account names, customer names, or raw transcript payloads.
