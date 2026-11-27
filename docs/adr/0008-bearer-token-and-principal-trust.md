# Transport identity resolves once per request from one authoritative token snapshot, capabilities bind to a request-private async context, and principal identities are validated — never stored verbatim

Status: accepted

## Context
A request's bearer token can be matched by static operator strings, an entry-based dynamic getter (identity plus policy), or a legacy string getter (no identity, no policy). Resolution happens in several places — authentication, scope policy, connector provenance — so a mid-request mint or revoke could let the scope policy observe a different token than the one that authenticated. Capability binding has a language-level trap: `enterWith` mutates the CURRENT async resource and does not reliably isolate the store across the awaits of concurrent requests; an unbound store reads undefined, and undefined caps mean unrestricted — a silent fail-open past the op and namespace gates. EventSource clients cannot set request headers. `sessionOwnerPrincipal` is persisted on durable records, so accepting a malformed header verbatim would stamp unvalidated identities into storage. MCP session ids are keyed per HTTP request while concurrent initializes can reuse the same JSON-RPC id. Rate limiting, citation recording, and wearable/meetings ops all need the same identity resolution as other endpoints. URL parsers hand back compressed and IPv4-mapped forms of loopback literals, and special-use spellings (trailing dot, `.localhost`) exist, while lookalike hostnames must stay remote. Finally, the audit anomaly detector must see every record even when one client floods writes.

Merged into this theme as nearest neighbours: the per-principal audit tail records, wearables caller scope, REST connector provenance, and the per-request identity cache.

## Decision
1. When an entry-based dynamic token getter is configured it is AUTHORITATIVE: no fall-through to the string getter, which carries no identity and would bypass policy. Validation, connector identity, and capabilities all come from the SAME matched snapshot entry, cached per request, so a scope policy can never observe a token fresher than the identity it scopes (mint/revoke coherence). A path policy without a connector identity denies — fail closed.
2. The presenting token's capabilities bind via `AsyncLocalStorage.run()` — a fresh, request-private async scope for the WHOLE dispatch — never `enterWith`, so concurrent requests never bleed capabilities and the store stays bound across every await.
3. The `?token=` query fallback is accepted ONLY on the SSE endpoint, because EventSource cannot set request headers. The Authorization header always wins, the comparison is timing-safe, and restricting the fallback to SSE limits the CSRF credentialed-URL attack surface.
4. Operator and admin surfaces (OAuth pending/approve/deny and the operator routes) are unrestricted-only: a scoped, least-privileged token must not reach them.
5. Principal values are durable identity strings: no whitespace, no control characters (C0 below 0x20, DEL, and the C1 range 0x7f–0x9f that `\s` misses, e.g. U+0085 NEL), no path separators, and `..` is refused so a value can never collide with traversal shapes. Malformed identities are rejected instead of stored verbatim; principals are percent-encoded when emitted as HTTP header values and decoded by the consumer.
6. Correlation ids are server-generated per request; a client-supplied value can never install a correlation context. MCP session ids map by correlation id (unique per HTTP request), so concurrent initializes with equal JSON-RPC ids do not collide, and initialize responses pop the mapping. `clientInfo` is looked up per MCP session to avoid cross-session leaks; non-MCP requests get undefined clientInfo and rely on HTTP headers.
7. Rate limiting keys on the resolved principal, falling back to the authenticated connector identity when none is resolved, so per-connector bearer tokens stay isolated from each other. Wearables/meetings caller scope is the request principal plus the gated namespace (plus optional session). Citation usage recording passes the authenticated principal so namespace ACL checks resolve identity the same way as other write endpoints.
8. Loopback origin normalization accepts the whole 127.0.0.0/8 range, the IPv4-mapped `::ffff:127.0.0.0/104` form (which URL parsers return in compressed hex), the trailing-dot fully-qualified form, and RFC 6761 `.localhost` suffixes. Anything that merely resembles loopback — a hostname starting with the loopback literal, a non-loopback quad with resembling digits, mapped literals outside 127/8 including the octet just below it — is remote and refused, with the refusal naming the resolved origin in canonical hex form.
9. Audit integrity: tail buffers are per-principal so a noisy client cannot mask an attacker, and the tail updates BEFORE the async write so the detector sees every record.

## Consequences
Dynamic token rotation mid-request cannot split validation from scoping, at the cost of one authoritative snapshot per request. SSE is the only surface where a token may travel in a URL. Malformed principal headers fail the request instead of persisting, and emitted principal headers require percent-encoding. Lookalike hostnames are refused with canonical hex names in the error. Per-principal audit tails cost memory proportional to active principals.

## Origin comments
- `packages/remnic-cli/src/remote-daemon.test.ts:327` — "// The whole 127.0.0.0/8 range is loopback, not just the .1 literal — and"
- `packages/remnic-cli/src/remote-daemon.test.ts:328` — "// so is the IPv4-mapped equivalent `::ffff:127.0.0.0/104`, which the URL"
- `packages/remnic-cli/src/remote-daemon.test.ts:329` — "// parser hands back in compressed hex form (pinned below)."
- `packages/remnic-cli/src/remote-daemon.test.ts:345` — "// Special-use localhost spellings the shared core helper already"
- `packages/remnic-cli/src/remote-daemon.test.ts:346` — "// normalizes: a trailing dot (fully-qualified form) and the reserved"
- `packages/remnic-cli/src/remote-daemon.test.ts:347` — "// `.localhost` suffix from RFC 6761."
- `packages/remnic-cli/src/remote-daemon.test.ts:360` — "// Lookalikes are remote: a hostname that merely starts with the loopback"
- `packages/remnic-cli/src/remote-daemon.test.ts:361` — "// literal, a non-loopback quad whose digits resemble one, and mapped"
- `packages/remnic-cli/src/remote-daemon.test.ts:362` — "// literals outside 127.0.0.0/8 — including the octet just below it. The"
- `packages/remnic-cli/src/remote-daemon.test.ts:363` — "// refusal carries the resolved origin, so mapped spellings are named in"
- `packages/remnic-cli/src/remote-daemon.test.ts:364` — "// the canonical hex form."
- `packages/remnic-core/src/access-audit.ts:49` — "per-principal tails so noisy client cannot mask attacker"
- `packages/remnic-core/src/access-audit.ts:86` — "update tail BEFORE async write; detector sees every record"
- `packages/remnic-core/src/access-correlation.ts:3` — "// Server-generated per-request correlation id for the access HTTP transport."
- `packages/remnic-core/src/access-correlation.ts:4` — "// Scoped per request in EngramAccessHttpServer and read downstream (recall"
- `packages/remnic-core/src/access-correlation.ts:5` — "// timings, MCP dispatch, logs) without threading the id through every call."
- `packages/remnic-core/src/access-correlation.ts:6` — "// The id never derives from client input: clients may echo it back, but a"
- `packages/remnic-core/src/access-correlation.ts:7` — "// client-supplied value can never install a correlation context."
- `packages/remnic-core/src/access-http.ts:266` — "// Principals are durable identity strings (sessionOwnerPrincipal, scope-group"
- `packages/remnic-core/src/access-http.ts:267` — "// keys, derived namespaces): no whitespace, control characters, or path"
- `packages/remnic-core/src/access-http.ts:268` — "// separators; `..` is refused so a value can never collide with traversal"
- `packages/remnic-core/src/access-http.ts:269` — "// shapes anywhere downstream."
- `packages/remnic-core/src/access-http.ts:275` — "// Control characters are refused: C0 (<0x20) plus DEL and the C1 range"
- `packages/remnic-core/src/access-http.ts:276` — "// (0x7f-0x9f, which \s does not cover — e.g. U+0085 NEL). Printable/unicode"
- `packages/remnic-core/src/access-http.ts:277` — "// otherwise fine."
- `packages/remnic-core/src/access-http.ts:601` — "// Look up clientInfo for this specific MCP session to avoid cross-session leaks."
- `packages/remnic-core/src/access-http.ts:602` — "// Non-MCP requests (no mcp-session-id header) get undefined clientInfo and"
- `packages/remnic-core/src/access-http.ts:603` — "// rely on HTTP headers for adapter matching."
- `packages/remnic-core/src/access-http.ts:614` — "/** Cache for per-request identity resolution (avoids double adapter resolution) */"
- `packages/remnic-core/src/access-http.ts:632` — "// Trust boundary (issue #3460): once the header is honored, a client"
- `packages/remnic-core/src/access-http.ts:633` — "// could stamp any value as sessionOwnerPrincipal on durable records."
- `packages/remnic-core/src/access-http.ts:634` — "// Reject malformed identities instead of storing them verbatim."
- `packages/remnic-core/src/access-http.ts:676` — "/** Caller scope for wearables/meetings ops (issue #2123): request principal + * gated namespace + optional se"
- `packages/remnic-core/src/access-http.ts:793` — "// Operator-only endpoints (OAuth pending/approve/deny) must only pass"
- `packages/remnic-core/src/access-http.ts:794` — "// for unrestricted tokens — a scoped (least-privileged) token must NOT"
- `packages/remnic-core/src/access-http.ts:795` — "// reach operator surfaces (issue #1837)."
- `packages/remnic-core/src/access-http.ts:816` — "// Bind the presenting token's capabilities to this request's async"
- `packages/remnic-core/src/access-http.ts:817` — "// context via run() (NOT enterWith). enterWith mutates the CURRENT async"
- `packages/remnic-core/src/access-http.ts:818` — "// resource and does NOT reliably isolate the store across the awaits and"
- `packages/remnic-core/src/access-http.ts:819` — "// concurrent requests that fill this handler — the store could read"
- `packages/remnic-core/src/access-http.ts:820` — "// undefined mid-handler, and undefined caps == unrestricted/legacy,"
- `packages/remnic-core/src/access-http.ts:821` — "// which would SILENTLY FAIL OPEN, bypassing the op + namespace gates."
- `packages/remnic-core/src/access-http.ts:822` — "// run() establishes a fresh, request-private async scope for the WHOLE"
- `packages/remnic-core/src/access-http.ts:823` — "// dispatch so concurrent requests never bleed capabilities and the store"
- `packages/remnic-core/src/access-http.ts:824` — "// stays bound across every await (issue #1850 round 7)."
- `packages/remnic-core/src/access-http.ts:1669` — "// Phase 1 provenance: server-resolved connector identity from the"
- `packages/remnic-core/src/access-http.ts:1670` — "// bearer token (REST path, mirroring the MCP tools/call dispatch)."
- `packages/remnic-core/src/access-http.ts:1799` — "// Percent-encode so every configured principal remains a valid HTTP"
- `packages/remnic-core/src/access-http.ts:1800` — "// header value. Mission Control decodes this before constructing the"
- `packages/remnic-core/src/access-http.ts:1801` — "// server-validated human approval envelope."
- `packages/remnic-core/src/access-http.ts:2001` — "// #2829: raw alias spelling retained by the schema transform."
- `packages/remnic-core/src/access-http.ts:2064` — "// Issue #1582 — thread the transport session key so a `[m:xxxx]` handle in"
- `packages/remnic-core/src/access-http.ts:2065` — "// the path resolves against this session's recall history (codex review)."
- `packages/remnic-core/src/access-http.ts:2066` — "// resolveRequestIdentity reads it from adapter identity / request headers."
- `packages/remnic-core/src/access-http.ts:3379` — "// If this was an initialize response, pop the session ID keyed by"
- `packages/remnic-core/src/access-http.ts:3380` — "// correlation ID (unique per HTTP request, not client-chosen JSON-RPC id)."
- `packages/remnic-core/src/access-http.ts:3672` — "/** * Per-request cache of the matched token entry (the entry whose token * matched the bearer credential, BEF"
- `packages/remnic-core/src/access-http.ts:3685` — "/** * Resolve the matched token entry for this request, caching the result so * every downstream consumer (aut"
- `packages/remnic-core/src/access-http.ts:3702` — "/** * Find the entry whose token matches the request's bearer credential. * Static operator tokens (`authToken"
- `packages/remnic-core/src/access-http.ts:3734` — "// Fallback: ?token= query parameter — ONLY accepted for the SSE"
- `packages/remnic-core/src/access-http.ts:3735` — "// endpoint (/engram/v1/graph/events). EventSource cannot set request"
- `packages/remnic-core/src/access-http.ts:3736` — "// headers, so SSE clients must pass the token via the query string."
- `packages/remnic-core/src/access-http.ts:3737` — "// Allowing this fallback on every endpoint would let a CSRF attacker"
- `packages/remnic-core/src/access-http.ts:3738` — "// embed a credentialed URL anywhere — restricting it to SSE limits the"
- `packages/remnic-core/src/access-http.ts:3739` — "// attack surface (Codex P2 review thread `access-http.ts:1406`; Cursor"
- `packages/remnic-core/src/access-http.ts:3740` — "// review thread `access-http.ts:1412`). Authorization header always"
- `packages/remnic-core/src/access-http.ts:3741` — "// wins; timing-safe compare used below."
- `packages/remnic-core/src/access-http.ts:3763` — "// Entry-based dynamic tokens are AUTHORITATIVE when configured: the"
- `packages/remnic-core/src/access-http.ts:3764` — "// dynamic-token decision ends here (no fall-through to the string"
- `packages/remnic-core/src/access-http.ts:3765` — "// getter, which carries no identity and would bypass the policy)."
- `packages/remnic-core/src/access-http.ts:3766` — "// Validation and connector identity come from the same snapshot entry,"
- `packages/remnic-core/src/access-http.ts:3767` — "// so a scope policy can never observe a token fresher than the"
- `packages/remnic-core/src/access-http.ts:3768` — "// identity it scopes (mint/revoke coherence). Capabilities ride on the"
- `packages/remnic-core/src/access-http.ts:3769` — "// same entry so enforcement can never lag the token that validated."
- `packages/remnic-core/src/access-http.ts:3781` — "// String-token getter (no identity, no policy) — only consulted when"
- `packages/remnic-core/src/access-http.ts:3782` — "// no entry getter is configured."
- `packages/remnic-core/src/access-http.ts:3791` — "/** * Resolve the presenting token's entry for an authorized request, or null. * Applies the path-policy gate "
- `packages/remnic-core/src/access-http.ts:3806` — "// Fail closed: a policy without a connector identity denies."
- `packages/remnic-core/src/access-http.ts:3813` — "/** * Resolve the presenting token's capabilities for this request, or * undefined when the token is unrestric"
- `packages/remnic-core/src/access-http.ts:3848` — "/** * Operator/admin routes are unrestricted-only surfaces: a scoped * (least-privileged) token must NOT reach"
- `packages/remnic-core/src/access-http.ts:3860` — "/** * Resolve the connector identity for the request's bearer token (Phase 1 * provenance). Reuses the per-req"
- `packages/remnic-core/src/access-http.ts:3946` — "// Fall back to the authenticated connector identity when no principal is"
- `packages/remnic-core/src/access-http.ts:3947` — "// resolved, so per-connector bearer tokens are isolated from each other"
- `packages/remnic-core/src/access-http.ts:3948` — "// even without a principal header/server principal (issue #2029 review)."
- `packages/remnic-core/src/access-mcp.ts:2275` — "// Store session ID keyed by correlation ID (unique per HTTP request) so"
- `packages/remnic-core/src/access-mcp.ts:2276` — "// concurrent initializes with the same JSON-RPC id don't collide."
