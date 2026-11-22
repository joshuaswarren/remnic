# All surfaces dispatch through one access-boundary registry that owns schema validation, and invalid input is rejected loudly with non-leaking errors — never silently defaulted, coerced, or echoed

Status: accepted

## Context
Before the registry migration, CLI, MCP, and HTTP surfaces each validated independently, so namespace policy and schema checks could be skipped on some paths. The boundary module is imported from many entry points, and naive placement of shared imports creates TDZ cycles. zod 4 wraps base objects in pipes and leaks array-index paths into messages; JSON bodies can carry dictionary keys that change object shape or hit prototype resolution; JS coercions such as `Number(true) === 1` would silently accept wrong types. Programmatic callers bypass wire schemas entirely — direct service calls, CLI flag parsing, templating errors that produce strings like `"project:"` where a filter belongs, raw body fields a schema would strip, and `parseConfig`, which embeds offending values verbatim in thrown messages and warns from coercion paths. Unbounded fuzzy matching over registered tools is O(n*m) in request size. Arbitrary throw values surfaced to clients can expose stack traces and filesystem or backend paths.

Merged into this theme as nearest neighbours: the strict-validation one-offs (briefing focus/format strictness and its LLM-chain fallback, peer null handling, error-message sanitization, xray fail-fast parity, CLI flag-value parsing).

## Decision
1. The access boundary is the single input-validation and error boundary: it validates SHAPE, not tenancy. CLI store commands, MCP tools/call, and HTTP routes dispatch migrated operations through the same registry entry, so schema validation and normalization are owned in ONE place. Importing access-operations registers the pilot boundary operations as a side effect, and the input-error type is imported from a leaf module to avoid a TDZ cycle.
2. At the registry boundary In/Out types are erased (the cast is safe there); an operation's schema input type may differ from its output. zod 4 pipes are unwrapped in a loop until the base object. Zod error paths collapse array indices so messages read `field: must be ...`.
3. Reserved dictionary keys — the ones that change object shape or prototype resolution — are rejected with the input-error type. Boundary type checks compare exact types, never coercions.
4. Only undefined or truly empty means "no filter" or "default format". A briefing focus value that parses to null (`"project:"`, `"topic:"`) is malformed and rejected, so a templating miss never silently broadens a targeted project view to all memories; an unsupported format value like `"jsno"` is rejected explicitly so programmatic callers cannot silently receive the default format and mask the bug — only absent format falls through to the default. A CLI flag occupying the value slot is a missing value, not a value. Explicit nulls a schema strips as "absent" must fail at the transport, or a peer would register with default fields. All failure modes short-circuit BEFORE any recall IO. Storage acquisition and the briefing body share one request budget, and follow-ups without a direct OpenAI key route through the configured LLM chain (gateway model source or local LLM) like every other LLM feature; a configured key keeps precedence.
5. Error responses surface only deliberately-prefixed validation `Error.message` — never `String(err)` of an arbitrary throw (CodeQL js/stack-trace-exposure); anything else is rethrown as a 500. The MCP tools/call catch-all must not leak unexpected `Error.message` (paths from fs/backend), while intended typed access errors stay readable. Tool-name suggestion caps the request BEFORE the O(n*m) pass — matching the documented tool-name shape and rejecting over-long names with a teaching message rather than a silent truncate — and the helper re-checks the cap as defense in depth for direct callers.
6. Command-name type guards enumerate the union (not a bare `value in SPECS` check) so narrowing is sound.

## Consequences
Every new surface must wire through the registry rather than hand-validating, and the registration side-effect import must be preserved. Over-long or shape-changing inputs get teaching rejections instead of silent truncation or defaulting. Error text is restricted to intended validation messages, which costs detail on unexpected failures but removes stack-trace and path exposure.

## Origin comments
- `packages/remnic-cli/src/oauth.test.ts:651` — "// A flag in the value slot is a missing value, not a value."
- `packages/remnic-cli/src/xray.test.ts:164` — "// All four failure modes must short-circuit BEFORE the recall IO"
- `packages/remnic-core/src/access-boundary.test.ts:74` — "exact cases rule 36 exists for"
- `packages/remnic-core/src/access-boundary.test.ts:101` — "Number(true) === 1 would silently pass"
- `packages/remnic-core/src/access-boundary.ts:1` — "Single input-validation and error boundary; validates SHAPE, not tenancy"
- `packages/remnic-core/src/access-boundary.ts:19` — "input error imported from leaf module to avoid TDZ cycle (#3354)"
- `packages/remnic-core/src/access-boundary.ts:308` — "schema input type may differ from output In (#2829)"
- `packages/remnic-core/src/access-boundary.ts:426` — "collapse array-index paths so message reads "field: must be ...""
- `packages/remnic-core/src/access-boundary.ts:518` — "cast safe: In/Out erased at registry boundary"
- `packages/remnic-core/src/access-boundary.ts:534` — "zod 4 pipes: unwrap until base object; loop needed for suggestion_submit"
- `packages/remnic-core/src/access-cli.ts:11` — "// Importing access-operations registers the pilot boundary operations as a"
- `packages/remnic-core/src/access-cli.ts:12` — "// side effect; the store command dispatches through the registry (issue #1525)."
- `packages/remnic-core/src/access-cli.ts:319` — "/** * Type guard for {@link CommandName}. Enumerating the union (rather than a * bare `value in COMMAND_SPECS`) is what "
- `packages/remnic-core/src/access-cli.ts:564` — "// Migrated through the access boundary (issue #1525): the store command"
- `packages/remnic-core/src/access-cli.ts:565` — "// dispatches through the same registry entry as the MCP tool and HTTP"
- `packages/remnic-core/src/access-cli.ts:566` — "// route, so validation/normalization is owned in ONE place. The CLI has no"
- `packages/remnic-core/src/access-cli.ts:567` — "// write-quota hook (it is a one-shot process), so no hooks are forwarded."
- `packages/remnic-core/src/access-cli.ts:831` — "// Default mode: plan from text — dispatch through the boundary operation"
- `packages/remnic-core/src/access-cli.ts:832` — "// so schema validation + namespace policy reach this path (same as MCP/HTTP)."
- `packages/remnic-core/src/access-errors.ts:40` — "/** * Dictionary keys that change object shape or prototype resolution. A JSON * body can carry them as own members; the"
- `packages/remnic-core/src/access-errors.ts:49` — "/** * Reject the reserved keys with the input-error type, so a client that * submits a magic dictionary key gets a valid"
- `packages/remnic-core/src/access-http.ts:70` — "// Importing access-operations registers the pilot boundary operations"
- `packages/remnic-core/src/access-http.ts:71` — "// (memory_get / memory_store) as a side effect; the HTTP handlers below"
- `packages/remnic-core/src/access-http.ts:72` — "// dispatch the migrated routes through the registry (issue #1525)."
- `packages/remnic-core/src/access-http.ts:880` — "// boundary dispatch (issue #1850)"
- `packages/remnic-core/src/access-http.ts:946` — "// boundary dispatch (issue #1525)"
- `packages/remnic-core/src/access-http.ts:1058` — "// Boundary dispatch (issue #2482): same registry path as memory_store —"
- `packages/remnic-core/src/access-http.ts:1059` — "// the canonical recallRequestSchema re-validates the envelope the"
- `packages/remnic-core/src/access-http.ts:1060` — "// transport assembled (resolved namespace + query-param overlays)."
- `packages/remnic-core/src/access-http.ts:1813` — "// Migrated through the access boundary (issue #1525): the registry"
- `packages/remnic-core/src/access-http.ts:1814` — "// entry owns schema validation, normalization, and service dispatch."
- `packages/remnic-core/src/access-http.ts:1815` — "// The HTTP transport resolves the request-scoped namespace and principal"
- `packages/remnic-core/src/access-http.ts:1816` — "// BEFORE the boundary re-validates the cleaned envelope. The write-quota"
- `packages/remnic-core/src/access-http.ts:1817` — "// hook is forwarded via ctx.hooks so it still fires atomically inside"
- `packages/remnic-core/src/access-http.ts:1818` — "// the service's idempotent-write lock — never before, never on a replay"
- `packages/remnic-core/src/access-http.ts:1819` — "// (#1434 invariant preserved by the boundary migration)."
- `packages/remnic-core/src/access-http.ts:1844` — "// Migrated through the access boundary (issue #1525/#1548): the"
- `packages/remnic-core/src/access-http.ts:1845` — "// registry entry owns schema validation and service dispatch. HTTP"
- `packages/remnic-core/src/access-http.ts:1846` — "// resolves the request principal; the boundary re-validates the"
- `packages/remnic-core/src/access-http.ts:1847` — "// cleaned envelope. record/supersede persist decision memories, so they"
- `packages/remnic-core/src/access-http.ts:1848` — "// are gated by the same 30/min write quota as /engram/v1/memories,"
- `packages/remnic-core/src/access-http.ts:1849` — "// suggestions, and observe; list/get are pure reads and stay uncounted"
- `packages/remnic-core/src/access-http.ts:1850` — "// (review P2: apply write quotas to decision writes)."
- `packages/remnic-core/src/access-http.ts:1872` — "// Migrated through the access boundary (issue #1525/#1548 PR3):"
- `packages/remnic-core/src/access-http.ts:1873` — "// refresh persists the card, so it is gated by the 30/min write quota;"
- `packages/remnic-core/src/access-http.ts:1874` — "// get is a pure read and stays uncounted."
- `packages/remnic-core/src/access-http.ts:1896` — "// get is read-only with respect to user memory content. It DOES write"
- `packages/remnic-core/src/access-http.ts:1897` — "// the operator-side state file (last-seen-head marker), but that is"
- `packages/remnic-core/src/access-http.ts:1898` — "// bookkeeping — the same way calibration.ts writes are uncounted. No"
- `packages/remnic-core/src/access-http.ts:1899` — "// write-quota enforcement."
- `packages/remnic-core/src/access-http.ts:1911` — "// Daily briefing — pure read through the registered `briefing` boundary"
- `packages/remnic-core/src/access-http.ts:1912` — "// operation (sibling module; see access-http-briefing.ts)."
- `packages/remnic-core/src/access-http.ts:1924` — "// ── Correction Contract (issue #1580) — plan / apply / pending ─────────"
- `packages/remnic-core/src/access-http.ts:1925` — "// All three routes dispatch through the boundary operations so schema"
- `packages/remnic-core/src/access-http.ts:1926` — "// validation + namespace policy reach every correction path (rule 22/39)."
- `packages/remnic-core/src/access-http.ts:2040` — "// boundary dispatch (issue #1830)"
- `packages/remnic-core/src/access-http.ts:2047` — "// Dispatch through the registered operation so the HTTP route and the"
- `packages/remnic-core/src/access-http.ts:2048` — "// boundary registration share one gate. The server's own principal is"
- `packages/remnic-core/src/access-http.ts:2049` — "// the transport-level operator fallback; a configured"
- `packages/remnic-core/src/access-http.ts:2050` — "// agentAccessHttp.principal outranks it."
- `packages/remnic-core/src/access-http.ts:2073` — "// entry owns memoryId presence/shape validation (rule 51: reject empty"
- `packages/remnic-core/src/access-http.ts:2074` — "// ids loudly instead of silently passing "" into the service) and the"
- `packages/remnic-core/src/access-http.ts:2075` — "// service dispatch."
- `packages/remnic-core/src/access-http.ts:2532` — "// As with recallXray above: surface only the deliberately-prefixed"
- `packages/remnic-core/src/access-http.ts:2533` — "// graphSnapshot validation Error.message, never String(err) of an"
- `packages/remnic-core/src/access-http.ts:2534` — "// arbitrary throw (CodeQL js/stack-trace-exposure). Validation errors are"
- `packages/remnic-core/src/access-http.ts:2535` — "// always Error instances; anything else is rethrown as a 500."
- `packages/remnic-core/src/access-http.ts:2734` — "// The operation schema strips nulls as "absent", so an explicit null"
- `packages/remnic-core/src/access-http.ts:2735` — "// must fail here or the peer would register with default fields."
- `packages/remnic-core/src/access-http.ts:2739` — "// Raw body fields: the operation schema rejects malformed types with an"
- `packages/remnic-core/src/access-http.ts:2740` — "// input error instead of silently defaulting them (rule 51)."
- `packages/remnic-core/src/access-http.ts:3835` — "// preserve the registration side-effect assertion"
- `packages/remnic-core/src/access-observe-write-surface.ts:429` — "// Validate focus: only treat undefined / empty strings as "no filter"."
- `packages/remnic-core/src/access-observe-write-surface.ts:430` — "// Anything else that parses to null (e.g. "project:", "topic:") is malformed"
- `packages/remnic-core/src/access-observe-write-surface.ts:431` — "// and must be rejected so a templating miss never silently broadens the"
- `packages/remnic-core/src/access-observe-write-surface.ts:432` — "// briefing from a targeted project view to all memories."
- `packages/remnic-core/src/access-observe-write-surface.ts:442` — "// Reject unsupported format values explicitly. Programmatic callers that"
- `packages/remnic-core/src/access-observe-write-surface.ts:443` — "// bypass CLI/MCP pre-validation (which already use validateBriefingFormat)"
- `packages/remnic-core/src/access-observe-write-surface.ts:444` — "// could otherwise send a typo like "jsno" and silently receive a response"
- `packages/remnic-core/src/access-observe-write-surface.ts:445` — "// in the default format, masking the client bug and breaking format-dependent"
- `packages/remnic-core/src/access-observe-write-surface.ts:446` — "// automation. Only undefined / absent format falls through to the default."
- `packages/remnic-core/src/access-observe-write-surface.ts:465` — "// Storage acquisition and the briefing body share one request budget."
- `packages/remnic-core/src/access-observe-write-surface.ts:479` — "// Without a direct OpenAI key, route follow-ups through the configured"
- `packages/remnic-core/src/access-observe-write-surface.ts:480` — "// LLM chain (gateway model source or local LLM) — same fallback every"
- `packages/remnic-core/src/access-observe-write-surface.ts:481` — "// other LLM feature uses. A configured key keeps its precedence so"
- `packages/remnic-core/src/access-observe-write-surface.ts:482` — "// existing deployments are unchanged."
