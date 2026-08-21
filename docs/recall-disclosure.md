# Recall Disclosure Depth

Issue [#677](https://github.com/joshuaswarren/remnic/issues/677) adds a
**disclosure depth** parameter to all recall surfaces. A single `disclosure`
field on each recall call controls how much content is returned per result —
letting callers start cheap and escalate only when they need more context.

## The three levels

```
chunk (default)  →  section  →  raw
     cheapest                    most expensive
```

### `chunk` (default)

Returns a short preview of up to ~180 characters derived from the memory body
(the `normalizeProjectionPreview` projection). The preview is whitespace-
normalized and truncated at word boundaries. No full body content is included;
no LCM archive reads are issued.

- **Token budget:** roughly 45–55 tokens per result (180 chars ÷ ~4 chars/token).
- **When to use:** the default. Most recall consumers only need a glance at
  each memory to route the conversation. Chunk is enough when you are scanning
  results for relevance or building a briefing.

### `section`

Returns the full markdown body of each memory file in a `content` field
alongside the `preview`. This is the complete text that Remnic stored — the
same content you would read with `remnic memory get <id>`.

- **Token budget:** roughly 2–5× chunk, depending on memory size. Typical
  memories are 200–800 characters (50–200 tokens each); a result set of top-5
  section results commonly runs 500–1 000 tokens.
- **When to use:** when the chunk preview is ambiguous and you need the full
  reasoning or supporting detail a memory contains. Section is the right
  escalation for most agent flows.

### `raw`

Returns both the full memory body (`content`) and raw transcript excerpts from
the LCM archive (`rawExcerpts`) when the archive holds turns that originated
the memory. Each excerpt carries `turnIndex`, `role`, `content`, and
`sessionId`. If the LCM archive is disabled or has no stored turns for a given
memory the `rawExcerpts` array is present but empty.

- **Token budget:** full body plus transcript excerpts. An excerpt from a
  long conversation turn can be hundreds of tokens. Budget conservatively —
  10+ results at `raw` can easily exceed a context window.
- **When to use:** debugging provenance, verifying that a stored fact actually
  appeared verbatim in a past conversation, or building audit tooling that
  needs the original source text. Not recommended for production recall paths.

## Disclosure vs. retrieval tier — they are orthogonal

Remnic has two concepts that can look similar but answer different questions:

| Concept | What it controls | Defined in |
| --- | --- | --- |
| **Retrieval tier** | Which pipeline stage served a result: `exact-cache`, `fuzzy-cache`, `direct-answer`, `hybrid`, `rerank-graph`, `agentic` | `retrieval-tiers.ts` / `RecallTierExplain.tier` |
| **Disclosure depth** | How much of each result's content is returned: `chunk`, `section`, `raw` | `types.ts` / `RecallDisclosure` |

A `direct-answer` result can be returned at `chunk`, `section`, or `raw`
disclosure. A `hybrid` result can also be returned at any depth. **Tier
controls which memories surface; disclosure controls how deep into each memory
you go.** They are set independently and are fully composable.

## Using disclosure

### CLI

```sh
remnic recall "<query>" --disclosure chunk|section|raw
```

Omitting `--disclosure` defaults to `chunk`. Passing an invalid value (e.g.
`--disclosure full`) raises an error listing the valid options instead of
silently defaulting.

The `remnic xray` command also accepts `--disclosure` to populate the per-
disclosure token-spend summary in the X-ray snapshot:

```sh
remnic xray "<query>" --disclosure section
```

### HTTP

Pass `?disclosure=chunk|section|raw` as a query parameter on any recall
endpoint:

```
POST /engram/v1/recall
Content-Type: application/json

{ "query": "...", "disclosure": "section" }
```

Or via query string (for GET-friendly recall paths and `remnic xray`):

```
GET /engram/v1/recall/xray?q=...&disclosure=section
```

Invalid values on the primary `/engram/v1/recall` endpoint return `400` with
`code: "input_error"`. Invalid values on the `/engram/v1/recall/xray`
query-string path return `400` with `code: "invalid_disclosure"`. Both include
a message listing the valid options: `chunk`, `section`, `raw`.

### MCP

The `engram.recall` and `remnic.recall` tools accept a `disclosure` string
field:

```json
{
  "query": "what did we decide about the cache TTL",
  "disclosure": "section"
}
```

The `engram.recall_xray` / `remnic.recall_xray` tools also accept `disclosure`
to populate the per-result token-spend telemetry.

## X-ray surfacing

When a recall is captured with `xrayCapture: true`, each result in the
`RecallXraySnapshot` carries:

- **`disclosure`** — the depth used to render this result's payload
  (`"chunk"` | `"section"` | `"raw"`).
- **`estimatedTokens`** — estimated token cost of the payload at that depth
  (the shared NFC-normalized, script-aware heuristic used by recall surfaces).

The X-ray markdown renderer aggregates these into a **"Token spend by
disclosure"** summary table at the bottom of the results section:

```
### Token spend by disclosure

| Disclosure | Results | Estimated tokens |
| --- | ---: | ---: |
| chunk   | 3 |  145 |
| section | 2 |  820 |
| raw     | 0 |    0 |
```

The summary is only emitted when at least one result carries a disclosure
level, so legacy snapshots (callers who have not wired `--disclosure` through)
render identically to before #677.

## Auto-escalation policy

By default (`recallDisclosureEscalation: "manual"`) the system honors the
caller's requested depth verbatim and never escalates.

When you set `recallDisclosureEscalation: "auto"`, recalls that did **not**
explicitly specify a disclosure depth are automatically escalated from `chunk`
to `section` when the top-K confidence score falls below the configured
threshold (`recallDisclosureEscalationThreshold`, default `0.5`):

```jsonc
// openclaw.json (excerpt) — plugins.entries.openclaw-engram.config
{
  "plugins": {
    "entries": {
      "openclaw-engram": {
        "config": {
          "recallDisclosureEscalation": "auto",
          "recallDisclosureEscalationThreshold": 0.4
        }
      }
    }
  }
}
```

Key rules for `auto` mode:

- Only `chunk → section` is eligible for auto-escalation. `section` is never
  demoted; `raw` is never auto-selected — it always requires an explicit
  caller request because of its LCM archive read cost.
- Explicit caller requests (even `--disclosure chunk`) are **never** overridden
  by auto mode. The policy only fires when the caller omits the field entirely.
- When the snapshot has no scored results or no finite confidence value, no
  escalation fires.

The `DisclosureEscalationDecision` returned by the pure
`decideDisclosureEscalation()` helper records `effective` (the chosen depth),
`escalated` (boolean), and `reason` (human-readable text surfaced in operator
telemetry / debug paths).

## Configuration reference

| Key | Default | Description |
| --- | --- | --- |
| `recallDisclosureEscalation` | `"manual"` | `"manual"` — honor caller depth verbatim. `"auto"` — escalate chunk→section when top-K confidence is below threshold (on system-default-depth calls only). |
| `recallDisclosureEscalationThreshold` | `0.5` | Top-K confidence threshold in `[0, 1]` used by `auto` mode. Recalls whose top result scores below this value are escalated from `chunk` to `section`. |

## Related reading

- [Recall X-ray](xray.md) — per-result tier attribution and token-spend telemetry.
- [Advanced Retrieval](advanced-retrieval.md) — the retrieval tier ladder that is orthogonal to disclosure.
- [Retrieval Pipeline](architecture/retrieval-pipeline.md) — end-to-end recall flow.
- [`packages/remnic-core/src/types.ts`](../packages/remnic-core/src/types.ts) — `RecallDisclosure` type, `RECALL_DISCLOSURE_LEVELS`, `DEFAULT_RECALL_DISCLOSURE`.
- [`packages/remnic-core/src/recall-disclosure-escalation.ts`](../packages/remnic-core/src/recall-disclosure-escalation.ts) — pure `decideDisclosureEscalation()` helper and `DisclosureEscalationMode` type.
- [`packages/remnic-core/src/recall-xray.ts`](../packages/remnic-core/src/recall-xray.ts) — `RecallXrayResult.disclosure`, `RecallXrayResult.estimatedTokens`, `RecallXrayDisclosureSummary`, `estimateRecallTokens()`.
