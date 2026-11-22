# Project scoping comes from working context, never from caller-named overlay namespaces

Status: accepted

## Context
Writes had to land where the same client's recall searches: a write stored anywhere else is undiscoverable by that session. Two traps forced explicit rules — letting callers name the derived overlay namespace directly would bypass the persist allow-list (or spoof another principal's project namespace through a shared prefix), and letting a per-call project tag override an existing session binding would store into a namespace that session's recall never searches. A sessionless recall can attach no coding context, so its writes had to stay findable by that same client.

## Decision
- Project scoping is requested via cwd/projectTag (schema-level git/project context), which lets MCP clients that auto-inject cwd use write tools. When the session already carries a coding binding, the SESSION binding wins over a per-call tag: the write resolves to the session's project — the same project its recall searches (recall attaches context session-first).
- Overlay namespaces are never accepted as caller strings. A caller naming an overlay-shaped namespace directly is authorized strictly through canWriteNamespace on the base and rejected when not writable; a shared `principal-project-` prefix across principals grants nothing, and a base namespace the principal cannot write is rejected even when the spelled name is default-derived.
- An UNQUALIFIED write — no project context, no overlay — stays on config.defaultNamespace exactly as before; project re-scoping applies only to project-identified writes and never silently moves plain writes into a principal self namespace.
- With a self policy, a project-scoped write overlays onto the principal self base — the same base recall, observe, and buffers overlay onto — so the store is discoverable by that principal's project-scoped recall. The derived dynamic project namespace is used verbatim for dup-check and write, never rewritten.
- An authorized project write seeds the session's coding binding (like recall's attach), so a SUBSEQUENT bare recall on the same session — omitting cwd/projectTag — is scoped to the same project and finds the memory. An explicit `namespace` bypasses the coding overlay and must NOT seed a binding the session never wrote to. A sessionless write stays on the base namespace, matching its sessionless recall.
- Test doubles for sealed writes delegate through the PRODUCTION envelope-to-options mapping, so mock behavior cannot drift from real translation.

## Consequences
Write placement is predictable per session; guessing overlay names gains no access; a stale per-call projectTag cannot retarget a bound session; the base namespace remains the compatibility floor for unqualified and sessionless writes.

## Origin comments
- `packages/remnic-core/src/access-recall-surface.ts:682` — "Attach any coding context shipped with the recall request BEFORE"
- `packages/remnic-core/src/access-recall-surface.ts:683` — "namespace resolution so the overlay applies to this recall (issue #569)."
- `packages/remnic-core/src/access-recall-surface.ts:690` — "Auto-resolve coding context from cwd/projectTag when no explicit"
- `packages/remnic-core/src/access-recall-surface.ts:691` — "codingContext was supplied (issue #569 wiring). This allows Claude"
- `packages/remnic-core/src/access-recall-surface.ts:692` — "Code hooks and OpenClaw connectors to get project-scoped memory"
- `packages/remnic-core/src/access-recall-surface.ts:693` — "transparently."
- `packages/remnic-core/src/access-schema.ts:420` — "// Git/project context for project-scoped writes (#1434). When no explicit"
- `packages/remnic-core/src/access-schema.ts:421` — "// `namespace` is given, these route the write to the same project namespace"
- `packages/remnic-core/src/access-schema.ts:422` — "// recall/observe resolve from `cwd`/`projectTag` (issue #569, rule 42). Also"
- `packages/remnic-core/src/access-schema.ts:423` — "// lets MCP clients that auto-inject `cwd` (e.g. Pi MCPorter) call write tools."
- `packages/remnic-core/src/access-service-coding-write.test.ts:38` — "// Sealed-write stub fidelity (issue #1989 PR2; AGENTS.md §21): production"
- `packages/remnic-core/src/access-service-coding-write.test.ts:39` — "// callers now write via `writeSealedMemory`. Test doubles keep stubbing"
- `packages/remnic-core/src/access-service-coding-write.test.ts:40` — "// `writeMemory`; this decorator adds a sealed entry that delegates through"
- `packages/remnic-core/src/access-service-coding-write.test.ts:41` — "// the PRODUCTION mapping (`sealedWriteToLegacyArgs`), so mock behavior"
- `packages/remnic-core/src/access-service-coding-write.test.ts:42` — "// cannot drift from the real envelope→options translation."
- `packages/remnic-core/src/access-service-coding-write.test.ts:119` — "// Without a sessionKey the recall path can't attach or look up coding context"
- `packages/remnic-core/src/access-service-coding-write.test.ts:120` — "// (maybeAttachCodingContext / applyCodingNamespaceOverlay both no-op), so a"
- `packages/remnic-core/src/access-service-coding-write.test.ts:121` — "// sessionless recall searches the base namespace. A sessionless write must"
- `packages/remnic-core/src/access-service-coding-write.test.ts:122` — "// therefore also stay on the base — else the store would be hidden from the"
- `packages/remnic-core/src/access-service-coding-write.test.ts:123` — "// same client's recall (Codex review)."
- `packages/remnic-core/src/access-service-coding-write.test.ts:153` — "// Session is bound to project A; this write also passes per-call projectTag B."
- `packages/remnic-core/src/access-service-coding-write.test.ts:154` — "// The write MUST resolve to A — the same project the session's recall searches"
- `packages/remnic-core/src/access-service-coding-write.test.ts:155` — "// (recall is session-first: maybeAttachCodingContext returns early when a"
- `packages/remnic-core/src/access-service-coding-write.test.ts:156` — "// context is already attached). A per-call-wins write would land in B, which"
- `packages/remnic-core/src/access-service-coding-write.test.ts:157` — "// that session's recall never searches, so the memory would be undiscoverable."
- `packages/remnic-core/src/access-service-coding-write.test.ts:190` — "// Even when principal \"alice\" has a self policy, an UNQUALIFIED write (no"
- `packages/remnic-core/src/access-service-coding-write.test.ts:191` — "// coding overlay) stays on config.defaultNamespace — exactly the pre-#1434"
- `packages/remnic-core/src/access-service-coding-write.test.ts:192` — "// behavior. #1434 only re-scopes project-identified writes; it must not"
- `packages/remnic-core/src/access-service-coding-write.test.ts:193` — "// silently move plain unqualified writes to a principal self namespace (Codex"
- `packages/remnic-core/src/access-service-coding-write.test.ts:194` — "// review). The symmetry fix applies to the coding-overlay path only."
- `packages/remnic-core/src/access-service-coding-write.test.ts:223` — "// With a self policy, a project-scoped write overlays onto the principal self"
- `packages/remnic-core/src/access-service-coding-write.test.ts:224` — "// base (defaultNamespaceForPrincipal) — the SAME base recall/observe/buffer"
- `packages/remnic-core/src/access-service-coding-write.test.ts:225` — "// overlay onto — so the store is discoverable by that principal's"
- `packages/remnic-core/src/access-service-coding-write.test.ts:226` — "// project-scoped recall (Cursor review / rule 42)."
- `packages/remnic-core/src/access-service-coding-write.test.ts:246` — "// Project scoping is requested via cwd/projectTag, never by naming the derived"
- `packages/remnic-core/src/access-service-coding-write.test.ts:247` — "// overlay namespace. A caller naming an overlay-shaped namespace directly is"
- `packages/remnic-core/src/access-service-coding-write.test.ts:248` — "// authorized strictly through canWriteNamespace and rejected, so the persist"
- `packages/remnic-core/src/access-service-coding-write.test.ts:249` — "// allow-list can never be bypassed by guessing an overlay name."
- `packages/remnic-core/src/access-service-coding-write.test.ts:264` — "// Policies for both `alice` and `alice-project-team`. An authenticated `alice`"
- `packages/remnic-core/src/access-service-coding-write.test.ts:265` — "// must NOT be able to write `alice-project-team-project-foo` (the OTHER"
- `packages/remnic-core/src/access-service-coding-write.test.ts:266` — "// principal's project-scoped namespace) by exploiting a shared `alice-project-`"
- `packages/remnic-core/src/access-service-coding-write.test.ts:267` — "// prefix. Strict canWriteNamespace authorization rejects it."
- `packages/remnic-core/src/access-service-coding-write.test.ts:291` — "// The principal has a self policy but NO write access to the configured"
- `packages/remnic-core/src/access-service-coding-write.test.ts:292` — "// default namespace. An explicit `default-project-foo` must be rejected —"
- `packages/remnic-core/src/access-service-coding-write.test.ts:293` — "// overlay namespaces are never accepted as caller strings, and the base must"
- `packages/remnic-core/src/access-service-coding-write.test.ts:294` — "// pass canWriteNamespace."
- `packages/remnic-core/src/access-service-coding-write.test.ts:315` — "// A caller naming a namespace that is not writable for this principal is"
- `packages/remnic-core/src/access-service-coding-write.test.ts:316` — "// rejected by canWriteNamespace — it can't escalate to another principal's"
- `packages/remnic-core/src/access-service-coding-write.test.ts:317` — "// namespace."
- `packages/remnic-core/src/access-service-coding-write.test.ts:388` — "// A store with sessionKey + per-call projectTag must seed the session's"
- `packages/remnic-core/src/access-service-coding-write.test.ts:389` — "// coding binding (like recall's maybeAttachCodingContext), so a SUBSEQUENT"
- `packages/remnic-core/src/access-service-coding-write.test.ts:390` — "// bare recall on the same session — one that omits cwd/projectTag — is scoped"
- `packages/remnic-core/src/access-service-coding-write.test.ts:391` — "// to the same project and finds the memory."
- `packages/remnic-core/src/access-service-coding-write.test.ts:421` — "// An explicit `namespace` bypasses the coding overlay, so the write must not"
- `packages/remnic-core/src/access-service-coding-write.test.ts:422` — "// seed a project binding the session never wrote to — else later bare recalls"
- `packages/remnic-core/src/access-service-coding-write.test.ts:423` — "// would search a project namespace with no committed memory."
- `packages/remnic-core/src/access-service-coding-write.test.ts:488` — "// The dynamic project namespace must be used verbatim (dup-check + write),"
- `packages/remnic-core/src/access-service-coding-write.test.ts:489` — "// never rewritten or rejected."
