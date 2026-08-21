# OAI-mem-citation Blocks (Issue #379)

Remnic recall responses can emit `<oai-mem-citation>` blocks that match the
Codex citation format. This enables Codex-compatible memory attribution and
usage tracking.

## Citation Block Format

```xml
<oai-mem-citation>
<citation_entries>
facts/fact-abc.md:1-5|note=[user prefers dark mode]
facts/fact-def.md:10-20|note=[project deadline is Friday]
</citation_entries>
<rollout_ids>
rollout-001
rollout-002
</rollout_ids>
</oai-mem-citation>
```

### Entry Format

Each line inside `<citation_entries>` follows:

```
<path>:<line_start>-<line_end>|note=[<short note>]
```

- **path** -- relative path to the memory file (e.g. `facts/fact-abc.md`)
- **line_start / line_end** -- line range within the file (1-indexed)
- **note** -- short human-readable description of the cited memory

### Rollout IDs

The `<rollout_ids>` section contains one ID per line. These are deduplicated
while preserving insertion order. For legacy compatibility, `<thread_ids>` is
also accepted during parsing.

## Citation Flow

```
recall request
    |
    v
Remnic recall pipeline
    |
    v
recall response + citation metadata
    |
    v
citation guidance appended to context
    |
    v
model generates reply with <oai-mem-citation> block
    |
    v
downstream hook extracts citation block
    |
    v
POST /v1/citations/observed
    |
    v
memory usage_count incremented
```

1. **Recall** -- when the `engram.recall` MCP tool fires, the response
   includes citation metadata for each recalled memory that has a file path.
2. **Guidance** -- a `[Remnic citation guidance]` block is appended to the
   recall context, instructing the model to emit citations in its reply.
3. **Observation** -- after the model responds, a downstream hook (or the
   Codex read-path agent) extracts the `<oai-mem-citation>` block and posts
   it to the usage tracking endpoint.
4. **Tracking** -- the endpoint parses the citation block, resolves memory
   IDs from paths, and increments access tracking via the orchestrator.

## Configuration

| Property             | Type    | Default | Description                                                |
|----------------------|---------|---------|------------------------------------------------------------|
| `citationsEnabled`   | boolean | `false` | Explicitly enable citation guidance in recall responses.    |
| `citationsAutoDetect`| boolean | `true`  | Auto-enable when the Codex adapter is detected via MCP.     |

When `citationsAutoDetect` is `true` (the default), citations are
automatically enabled for MCP sessions where the client identifies as a
Codex adapter (`codex-mcp-client` or a name containing `codex`).

Set `citationsEnabled: true` to force citations for all recall consumers
regardless of adapter detection.

## HTTP Endpoint

### POST /v1/citations/observed

Record observed citations from a model's reply.

**Request body:**

```json
{
  "sessionId": "session-abc",
  "namespace": "global",
  "citations": {
    "entries": [
      {
        "path": "facts/fact-abc.md",
        "lineStart": 1,
        "lineEnd": 5,
        "note": "user prefers dark mode"
      }
    ],
    "rolloutIds": ["rollout-001"]
  }
}
```

**Response (200):**

```json
{
  "ok": true,
  "matched": 1,
  "entriesReceived": 1,
  "rolloutIdsReceived": 1
}
```

## Integration with Codex

When running behind the Codex CLI, the adapter auto-detection kicks in
automatically. No manual configuration is needed. The Codex read-path
agent can parse the model's `<oai-mem-citation>` block and post it back
to `/v1/citations/observed` to close the loop on usage tracking.
