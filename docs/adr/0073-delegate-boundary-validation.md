# Caller input and daemon payloads are validated at the boundary; a failure stays a failure instead of becoming data

Status: accepted

## Context
Every delegate boundary is untyped: hosts send schema-valid fractions, `NaN` and `Infinity` are numbers, `null` and omission have been used interchangeably, and the daemon on the other end may be version-skewed, corrupt, or fronted by a proxy. Coercion at these boundaries produces a valid-looking answer for a request nobody made — a different byte range, a different page, a fabricated memory id the host will try to open, a fabricated ranking — and across an untyped boundary it is indistinguishable from a correct answer.

## Decision
- Reject, never reinterpret, out-of-range caller input: non-finite and non-positive budgets and offsets, fractional limits, blank required arguments. `null` is treated as absent only where the host historically used it that way; otherwise an absent optional parameter and an invalid one are different failures with different messages.
- A 200 that does not carry a usable payload is a protocol failure, not a success: a non-record body, missing `results`, a hit without a string `path`, a missing or non-finite score, an unusable threshold, or a 2xx without a record where a record is required. Surface the failure; never synthesize ids, scores, zero rankings, or empty pages, and never let a shape-coalescing default paper over the difference.
- An unknown reported backend or mode value is treated as the conservative known value rather than trusted blindly; the daemon's own availability signal (`active` and `degraded`) is used as-is, falling back to the legacy flag only when the newer field is absent.
- Validate only the winning config value: a bad explicit value is a config error; a bad value that lost precedence is irrelevant.
- Strip absolute paths and stack noise from errors before they reach user-facing tool results.

## Consequences
- Caller bugs surface as boundary errors instead of silently different answers; version skew and corrupting proxies surface as protocol failures.
- Slightly-unusual but usable payloads are refused; callers must handle explicit errors where they previously got approximations.
- Every new payload field needs an explicit unknown-value rule before it is trusted.

## Origin comments
- `packages/plugin-openclaw/src/delegate-capability.test.ts:67` — "// A literal body, so a test can send a 200 that is valid JSON but not"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:68` — "// a record — the shape `?? {}` would otherwise paper over."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1177` — "// A 200 whose entries are not memories is a version-skewed or corrupt"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1178` — "// daemon. Synthesizing `memory-N` would hand the host a path it can then"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1179` — "// try to open (AGENTS.md #22)."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1595` — "// Non-finite AND finite-but-invalid: a clamp or truncation would return a"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1596` — "// different range while looking like a correct answer."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1948` — "// A missing score is a protocol failure, not a zero ranking."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1953` — "// An unusable threshold must not silently disable the filter."
- `packages/plugin-openclaw/src/delegate-capability.ts:172` — "/** * Narrow an unvalidated JSON value to a readable record. A type guard rather * than a cast: daemon payloads are ex"
- `packages/plugin-openclaw/src/delegate-capability.ts:185` — "// The daemon reports `searchBackend` explicitly; anything other than the two"
- `packages/plugin-openclaw/src/delegate-capability.ts:186` — "// known values is treated as builtin rather than trusted blindly."
- `packages/plugin-openclaw/src/delegate-capability.ts:197` — "// `active && !degraded` is the daemon's own "search will actually answer""
- `packages/plugin-openclaw/src/delegate-capability.ts:198` — "// signal. A missing `active` means an older daemon, so fall back to"
- `packages/plugin-openclaw/src/delegate-capability.ts:199` — "// `enabled` rather than reporting a false outage."
- `packages/plugin-openclaw/src/delegate-capability.ts:487` — "// `NaN` would slip past every `<= 0` comparison and reach"
- `packages/plugin-openclaw/src/delegate-capability.ts:488` — "// `AbortSignal.timeout` as an invalid duration; a fraction would be"
- `packages/plugin-openclaw/src/delegate-capability.ts:489` — "// silently truncated. Both are caller bugs across an untyped boundary."
- `packages/plugin-openclaw/src/delegate-capability.ts:628` — "// An out-of-range budget is a caller bug, not something to reinterpret:"
- `packages/plugin-openclaw/src/delegate-capability.ts:629` — "// coercing a negative to 1, truncating a fraction, or dropping a"
- `packages/plugin-openclaw/src/delegate-capability.ts:630` — "// non-finite value to the daemon default all return a valid-looking page"
- `packages/plugin-openclaw/src/delegate-capability.ts:631` — "// for a budget nobody asked for. Zero is the one accepted edge, handled"
- `packages/plugin-openclaw/src/delegate-capability.ts:632` — "// below once the request has been authorized."
- `packages/plugin-openclaw/src/delegate-capability.ts:711` — "// A 200 with no usable `results` is a protocol or version failure."
- `packages/plugin-openclaw/src/delegate-capability.ts:712` — "// Returning [] would make it indistinguishable from a valid empty"
- `packages/plugin-openclaw/src/delegate-capability.ts:713` — "// search and quietly report that no memories exist (AGENTS.md #22)."
- `packages/plugin-openclaw/src/delegate-capability.ts:722` — "// A hit without a string `path` is a version-skewed or corrupt daemon."
- `packages/plugin-openclaw/src/delegate-capability.ts:723` — "// Synthesizing `memory-N` would present that as a real memory the host"
- `packages/plugin-openclaw/src/delegate-capability.ts:724` — "// could then try to open (AGENTS.md #22: a protocol failure must not"
- `packages/plugin-openclaw/src/delegate-capability.ts:725` — "// masquerade as data)."
- `packages/plugin-openclaw/src/delegate-capability.ts:800` — "// `NaN` and `Infinity` are numbers: without the finite check `NaN` slices"
- `packages/plugin-openclaw/src/delegate-capability.ts:801` — "// from zero and silently returns the file's head, while `Infinity` returns"
- `packages/plugin-openclaw/src/delegate-capability.ts:802` — "// an empty page and is echoed back as the offset. Neither is the range the"
- `packages/plugin-openclaw/src/delegate-capability.ts:803` — "// caller asked for, so reject rather than serve a different one."
- `packages/plugin-openclaw/src/delegate-capability.ts:804` — "// Clamping a negative to 1 or truncating a fraction returns valid-looking"
- `packages/plugin-openclaw/src/delegate-capability.ts:805` — "// content for a range the caller did not ask for, which across an untyped"
- `packages/plugin-openclaw/src/delegate-capability.ts:806` — "// host boundary is indistinguishable from a correct answer."
- `packages/plugin-openclaw/src/plugin/memory-promote.ts:53` — "// Reject invalid input instead of reinterpreting it: a blank namespace or"
- `packages/plugin-openclaw/src/plugin/memory-promote.ts:54` — "// non-string memory reference must not silently select a different target."
- `packages/plugin-openclaw/src/plugin/memory-promote.ts:55` — "// `null` is treated as absent because optional tool parameters historically"
- `packages/plugin-openclaw/src/plugin/memory-promote.ts:56` — "// used it interchangeably with omission."
- `packages/plugin-openclaw/src/plugin/memory-promote.ts:60` — "// Namespace validation reuses the SAME contract as core routing"
- `packages/plugin-openclaw/src/plugin/memory-promote.ts:61` — "// (isSafeRouteNamespace), so every namespace core accepts is accepted here."
- `packages/plugin-openclaw/src/plugin/memory-promote.ts:156` — "// displayErrorDetail strips absolute paths and stack noise before the"
- `packages/plugin-openclaw/src/plugin/memory-promote.ts:157` — "// detail reaches a user-facing tool result (MCP/tool clients)."
