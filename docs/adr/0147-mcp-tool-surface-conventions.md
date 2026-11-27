# MCP tools keep legacy and canonical names alive through automatic aliasing, and the tool surface applies annotations, schemas, token filtering, and protocol checks as uniform final passes

Status: accepted

## Context
Tools were first registered under the legacy `engram.*` prefix; a canonical `remnic.*` naming now exists, and clients still call both forms, so both must stay alive for the legacy surface. Tool lists are assembled by spreading several groups (chat, codegraph, coding_*, correction), so per-group annotation logic would drift. The boundary's zod schema owns validation, so MCP input schemas can stay permissive — but an advertised schema must still carry fields whose values the transport injects (sessionKey), or the injection is skipped. A scoped or deny-all token must not enumerate or recover the full tool surface, including through error messages. Protocol conformance matters at both ends: initialize requires `params.protocolVersion`, streamable-HTTP clients send `MCP-Protocol-Version`, the GET SSE stream needs visible liveness before the first 25 s heartbeat, framed buffers receive runs of blank lines, and cancellation changed behavior in #1906. `access-mcp.ts` grew past the 3000-LOC structural ratchet.

## Decision
1. Tools register under the legacy `engram.*` prefix and `withToolAliases` automatically emits the canonical `remnic.*` alias (and the `remnic_*` form) — the dual-naming invariant keeps both names alive. Dispatch matches by canonical name, so argument validation resolves whether the caller used `engram.*`, `remnic.*`, or `remnic_*`, and a tool stays callable under legacy names even when only `remnic_*` appears in tools/list.
2. `readOnlyHint` annotations and `outputSchema` declarations are applied as FINAL suffix-based passes, so every tool — including both alias forms — inherits them without scattering logic across spread sites; tools that already declare an outputSchema are left untouched, and unlisted tools fall back to a permissive object schema. The permissive pattern is deliberate for the codegraph parity tools: the boundary's zod schema owns validation (rule 51), and the dispatch injects the `tool` field from the operation name.
3. tools/list filters advertised tools by the token's ops allow-list via the same map callTool uses: unrestricted tokens (ops axis absent) see everything; an unmapped tool maps to hidden. The unknown-tool rejection names the nearest registered tool from that SAME capability-filtered set — never the global map, which would let a scoped or deny-all token recover the full surface through the error path — and still throws without executing a guessed correction.
4. initialize requires a string `params.protocolVersion`: a missing or mistyped field is rejected with JSON-RPC invalid params, never silently negotiated; a well-formed unsupported version gets the spec-mandated counter-offer (the server's newest supported version, client decides). The streamable-HTTP endpoint rejects an unknown `MCP-Protocol-Version` header with a 400 JSON-RPC-shaped error, and the supported set is exported from one place. Method conformance on the streamable endpoint: DELETE returns 204; GET upgrades to the comment-only SSE stream when the client accepts text/event-stream, else 405 with the full method set; POST continues to the handler.
5. memory_get's inputSchema advertises `sessionKey`; otherwise the argument-acceptance check skips the override injection and an MCP caller citing a `[m:xxxx]` handle fails resolution. With the field advertised, the transport session key flows through the registry op into the service.
6. Framing and streams: blank lines carry no message — skip them so a run of blank lines cannot stall the frames that follow or end up inside the first header line, and release the old buffer allocation when a connection idles. The GET SSE stream writes a comment-only `: ping` frame immediately so clients and proxies see liveness without waiting for the first 25 s tick; comment frames carry no data and cannot be mistaken for JSON-RPC. limit=1 preserves the pre-#1906 serialization in which a queued recall aborts immediately instead of waiting for the holder to release.
7. Structural ratchet: admin/maintenance tool listings and the output-schema registry live in sibling modules so access-mcp.ts stays under the 3000-LOC limit, and the git-context schema props (accepted-and-ignored compatibility surface, issue #569) are defined once and shared.

## Consequences
Every tool carries two names forever, and listing weight grows accordingly. Permissive MCP input schemas delegate correctness to the boundary schema. New cross-cutting tool metadata must be added as a final pass or it misses spread-in groups. Protocol version policy lives in exactly one exported module. Sibling-file splits must preserve the registration side effects.

## Origin comments
- `packages/remnic-core/src/access-errors.ts:125` — "// Defense in depth: the entry point already caps; this guards any direct"
- `packages/remnic-core/src/access-errors.ts:126` — "// caller of the helper from an unbounded Levenshtein pass (issue #3042)."
- `packages/remnic-core/src/access-errors.ts:244` — "// Cap the request before the suggestion pass: a 128 KB name would otherwise"
- `packages/remnic-core/src/access-errors.ts:245` — "// pay O(n*m) per registered tool (issue #3042 review, P2). The cap matches"
- `packages/remnic-core/src/access-errors.ts:246` — "// the documented tool-name shape; an over-long request is rejected with a"
- `packages/remnic-core/src/access-errors.ts:247` — "// teaching message rather than a silent truncate."
- `packages/remnic-core/src/access-http.ts:839` — "// Method-conformance for the streamable-HTTP MCP endpoint (issue #2718):"
- `packages/remnic-core/src/access-http.ts:840` — "// DELETE → 204, GET upgrades to the comment-only SSE stream in"
- `packages/remnic-core/src/access-http.ts:841` — "// access-mcp-sse.ts when the client accepts text/event-stream, else 405"
- `packages/remnic-core/src/access-http.ts:842` — "// with the full method set. POST continues to the handler below."
- `packages/remnic-core/src/access-http.ts:3157` — "// Reject requests that advertise an unknown MCP protocol version in"
- `packages/remnic-core/src/access-http.ts:3158` — "// the streamable-HTTP `MCP-Protocol-Version` header. Absent or"
- `packages/remnic-core/src/access-http.ts:3159` — "// valid → proceed. Unknown → 400 with a JSON-RPC-shaped error so"
- `packages/remnic-core/src/access-http.ts:3160` — "// the client surfaces a clear message. The supported set is"
- `packages/remnic-core/src/access-http.ts:3161` — "// exported by @remnic/core's access-mcp module to keep the"
- `packages/remnic-core/src/access-http.ts:3162` — "// version policy in a single place."
- `packages/remnic-core/src/access-mcp-admin-tools.ts:1` — "/** * MCP tool-listing entries for the admin/maintenance operation surface * (capsules, governance, entity synthesis, pr"
- `packages/remnic-core/src/access-mcp-admin-tools.ts:8` — "/** Git-context schema props accepted-and-ignored by every tool (issue #569 * compatibility surface) — defined here so t"
- `packages/remnic-core/src/access-mcp-admin-tools.ts:157` — "// The canonical `remnic.procedural_stats` alias is added automatically"
- `packages/remnic-core/src/access-mcp-admin-tools.ts:158` — "// by `withToolAliases` — the dual-naming invariant keeps both names"
- `packages/remnic-core/src/access-mcp-admin-tools.ts:159` — "// alive for the legacy surface."
- `packages/remnic-core/src/access-mcp-admin-tools.ts:200` — "/** * Tool-name → operation-name entries contributed by this module, spread into * `MCP_MIGRATED_OPERATIONS` in access-m"
- `packages/remnic-core/src/access-mcp-cancellation.test.ts:354` — "// limit=1 preserves the exact pre-#1906 serialization this test exercises:"
- `packages/remnic-core/src/access-mcp-cancellation.test.ts:355` — "// the second recall queues behind the first, and an abort while queued now"
- `packages/remnic-core/src/access-mcp-cancellation.test.ts:356` — "// rejects it immediately (before the holder releases)."
- `packages/remnic-core/src/access-mcp-frames.ts:49` — "// A blank line carries no message. Skip it and read the next frame, so a"
- `packages/remnic-core/src/access-mcp-frames.ts:50` — "// run of blank lines cannot stall the frames that follow in this buffer."
- `packages/remnic-core/src/access-mcp-frames.ts:64` — "// Blank lines before a header block carry no message; drop them so they"
- `packages/remnic-core/src/access-mcp-frames.ts:65` — "// cannot end up inside the first header line."
- `packages/remnic-core/src/access-mcp-frames.ts:114` — "/** An empty view would keep the old allocation alive while the connection idles. */"
- `packages/remnic-core/src/access-mcp-output-schemas.ts:1` — "/** * Output-schema registry for MCP tools — extracted from access-mcp.ts to * keep that file under the 3000-LOC structu"
- `packages/remnic-core/src/access-mcp-output-schemas.ts:76` — "/** * Per-suffix outputSchema registry. Tools not present here fall back to * `{ type: "object", additionalProperties: t"
- `packages/remnic-core/src/access-mcp-sse.ts:31` — "// Comment-only frames: `: ping\n\n` is a valid SSE comment that carries no"
- `packages/remnic-core/src/access-mcp-sse.ts:32` — "// data and cannot be mistaken for a JSON-RPC message. One is written"
- `packages/remnic-core/src/access-mcp-sse.ts:33` — "// immediately so clients and proxies see the stream is live without"
- `packages/remnic-core/src/access-mcp-sse.ts:34` — "// waiting for the first 25 s tick."
- `packages/remnic-core/src/access-mcp.test.ts:665` — "// The engram.memory_get inputSchema must advertise sessionKey, otherwise"
- `packages/remnic-core/src/access-mcp.test.ts:666` — "// toolAcceptsArgument skips the override injection and an MCP caller citing a"
- `packages/remnic-core/src/access-mcp.test.ts:667` — "// [m:xxxx] handle gets "cannot be resolved without a session key" (codex"
- `packages/remnic-core/src/access-mcp.test.ts:668` — "// review). With the field advertised, the transport session key flows through"
- `packages/remnic-core/src/access-mcp.test.ts:669` — "// the registry op into service.memoryGet as the 4th positional arg."
- `packages/remnic-core/src/access-mcp.ts:721` — "// Registered as `engram.recall_xray`; `withToolAliases` below"
- `packages/remnic-core/src/access-mcp.ts:722` — "// emits the canonical `remnic.recall_xray` alias automatically"
- `packages/remnic-core/src/access-mcp.ts:723` — "// (dual-naming invariant for every new MCP tool)."
- `packages/remnic-core/src/access-mcp.ts:1660` — "// Uses the legacy "engram.*" prefix like every other tool in this array;"
- `packages/remnic-core/src/access-mcp.ts:1661` — "// withToolAliases (applied via .flatMap below) generates the canonical"
- `packages/remnic-core/src/access-mcp.ts:1662` — "// "remnic.briefing" alias automatically."
- `packages/remnic-core/src/access-mcp.ts:2047` — "// The 14 codegraph parity tools (issue #1554). Each delegates to its"
- `packages/remnic-core/src/access-mcp.ts:2048` — "// boundary operation; the MCP dispatch injects the `tool` field from"
- `packages/remnic-core/src/access-mcp.ts:2049` — "// the operation name. The inputSchema is intentionally permissive —"
- `packages/remnic-core/src/access-mcp.ts:2050` — "// the boundary's zod schema owns validation (rule 51)."
- `packages/remnic-core/src/access-mcp.ts:2201` — "// Apply `readOnlyHint` annotations to the conservative read-only"
- `packages/remnic-core/src/access-mcp.ts:2202` — "// allowlist. Done as a final pass so every spread (chat, codegraph,"
- `packages/remnic-core/src/access-mcp.ts:2203` — "// coding_*, correction, etc.) inherits the annotation without"
- `packages/remnic-core/src/access-mcp.ts:2204` — "// scattering the same logic across every `withToolAliases` call site."
- `packages/remnic-core/src/access-mcp.ts:2205` — "// Suffix-based matching covers both the `remnic_*` and `engram.*`"
- `packages/remnic-core/src/access-mcp.ts:2206` — "// naming forms emitted by `withToolAliases`."
- `packages/remnic-core/src/access-mcp.ts:2212` — "// Apply `outputSchema` declarations from the registry. Like the"
- `packages/remnic-core/src/access-mcp.ts:2213` — "// readOnlyHint pass above, this is a final suffix-based pass so every"
- `packages/remnic-core/src/access-mcp.ts:2214` — "// tool (including both `remnic_*` and `engram.*` aliases) gets a"
- `packages/remnic-core/src/access-mcp.ts:2215` — "// schema. Tools that already declare an outputSchema (e.g."
- `packages/remnic-core/src/access-mcp.ts:2216` — "// chatgpt_memory_inspector) are left untouched."
- `packages/remnic-core/src/access-mcp.ts:2245` — "// MCP initialize REQUIRES params.protocolVersion (string). Reject a"
- `packages/remnic-core/src/access-mcp.ts:2246` — "// missing/mistyped field with JSON-RPC invalid params instead of"
- `packages/remnic-core/src/access-mcp.ts:2247` — "// silently negotiating (repo rule: never reinterpret invalid input)."
- `packages/remnic-core/src/access-mcp.ts:2248` — "// An unsupported-but-well-formed version gets the spec-mandated"
- `packages/remnic-core/src/access-mcp.ts:2249` — "// counter-offer below instead: the server answers with the newest"
- `packages/remnic-core/src/access-mcp.ts:2250` — "// version it supports and the client decides whether to proceed."
- `packages/remnic-core/src/access-mcp.ts:2298` — "// Issue #1850 round 5 (finding 3): a scoped/deny-all token must not"
- `packages/remnic-core/src/access-mcp.ts:2299` — "// enumerate the full tool surface — filter advertised tools by the"
- `packages/remnic-core/src/access-mcp.ts:2300` — "// token's ops allow-list via the same map callTool uses. Unrestricted"
- `packages/remnic-core/src/access-mcp.ts:2301` — "// tokens (ops axis absent) see everything; unmapped tool ⇒ "" ⇒ hidden."
- `packages/remnic-core/src/access-mcp.ts:2542` — "// Match by canonical name so argument validation resolves whether the"
- `packages/remnic-core/src/access-mcp.ts:2543` — "// caller used `engram.*`, `remnic.*`, or `remnic_*` and regardless of"
- `packages/remnic-core/src/access-mcp.ts:2544` — "// whether legacy aliases are advertised (issue #1427) — a tool stays"
- `packages/remnic-core/src/access-mcp.ts:2545` — "// callable under those names even when only remnic_* appears in tools/list."
- `packages/remnic-core/src/access-mcp.ts:2635` — "// Teaching rejection (#3035): name the nearest registered tool instead"
- `packages/remnic-core/src/access-mcp.ts:2636` — "// of a bare "unknown tool". Semantics are unchanged — this still throws"
- `packages/remnic-core/src/access-mcp.ts:2637` — "// and never executes a guessed correction."
- `packages/remnic-core/src/access-mcp.ts:2638` — "//"
- `packages/remnic-core/src/access-mcp.ts:2639` — "// Candidates are the SAME capability-filtered set `tools/list` shows"
- `packages/remnic-core/src/access-mcp.ts:2640` — "// (issue #1850 finding 3). Enumerating the global map here would let a"
- `packages/remnic-core/src/access-mcp.ts:2641` — "// scoped or deny-all token recover the full tool surface through the"
- `packages/remnic-core/src/access-mcp.ts:2642` — "// error path, re-opening the leak that fix closed."
