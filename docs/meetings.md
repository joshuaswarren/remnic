# Meetings

Retrospective meeting intelligence (issue #1900): Remnic detects, fuses, and
stores a day's meetings from ingested wearable audio transcripts and screen
activity, then writes deterministic episode memories (and, under `summaryMode`,
trust-gated summary facts) for each meeting. Every surface — CLI, MCP tools
(`engram.meetings_*`), and HTTP routes — delegates to the single orchestrator-owned
`MeetingsService`, so behavior, validation, and the `meetings.enabled` gate are
identical everywhere.

## Namespace + machine-source boundary

Meetings follow caller-derived namespace symmetry (issue #2123): the caller's
resolved namespace determines where meeting inputs are read from and where
outputs are written, EXCEPT for machine-scoped screen activity, which is global.

- **Caller-namespaced (per-namespace storage root).** Wearable *source
  transcripts*, meeting *records* (`<ns>/meetings/<date>/<id>.md`), and meeting
  *episode/summary memories* all live under the caller's namespace root. Reads
  resolve through `resolveReadableNamespace`; writes (`wearables sync`,
  `meetings build`) through `writableNamespaceFor`. A build reads the wearable
  source and prior records from the caller namespace's storage only.
- **Machine-scoped, default-only (global).** Screen activity is a single
  machine-global store (`<memoryDir>/state/activity.sqlite`) and is NEVER
  migrated per-namespace. It is consumed ONLY when the resolved caller namespace
  is the machine-owner (`config.defaultNamespace`). For every non-default caller
  namespace the day-source is built with no activity reader, so detection
  degrades to audio-only.
- **Strict isolation for non-default callers.** A non-default caller reads ONLY
  its own namespace's wearable days and records — there is no fallback to
  default-namespace wearables and no machine-global activity. A day that has only
  default-namespace wearables plus global activity therefore yields zero meetings
  for a non-default caller. The default / machine-owner namespace is the only one
  that consumes default-namespace wearables (including legacy historical data)
  and the global activity store.

Operator/CLI callers carry the default principal and so resolve to
`config.defaultNamespace`, preserving pre-#2123 single-tenant behavior.
