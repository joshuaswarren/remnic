# Raw transcript excerpts are read-authorized, session-scoped, and capped

Status: accepted

## Context
Raw disclosure attaches LCM transcript excerpts inline. The archive is keyed by session_id, not partitioned by namespace: resolving excerpts from the write/overlay namespace attached rows the principal can write but not read; omitting the session key made the search cross every archived session, leaking unrelated (potentially cross-namespace) content; unbounded fanout ballooned responses on an escape-hatch feature; and an external store failure could crash the primary recall flow. Session keys with surrounding whitespace drove recall under one identity but probed the archive under another.

## Decision
- Raw-excerpt reads resolve through the READ-AUTHORIZATION gate — the same read-authorized namespace (or ordered, read-authorized key set with coding fallbacks) that recall and lcmSearch use — never the write/overlay snapshot namespace. Resolution happens ONLY for raw disclosure (its sole consumer), so non-raw recall and x-ray responses stay byte-for-byte unchanged.
- An implicit raw recall with NO readable LCM namespace emits empty excerpts rather than falling back to a namespace the read gate excludes; an explicit namespace always resolves (or throws) above, so suppression applies only to the implicit path.
- Raw disclosure is session-scoped: without a concrete sessionKey, callers get an empty excerpt list — never a cross-session (or cross-namespace) leak. With a session key, excerpts are looked up under the ordered read-authorized key set so a branch-scoped session finds excerpts archived at project or root scope, exactly as recall does.
- The excerpt fanout is capped (five matches) across the MERGED result set, so adding fallback keys never inflates the excerpt budget; raw is the escape hatch, not the default. Session keys are trimmed identically to the recall path so gating and lookup agree.
- LCM is an external subsystem: its failures are isolated and never crash the primary recall flow.
- The x-ray raw-excerpt path mirrors all of the above, with the memory-file reads staying on their own snapshot-scoped namespace.

## Consequences
Raw disclosure can return fewer excerpts than exist; callers outside a session get none; excerpt availability depends on read (not write) policy; excerpt cost is bounded regardless of fallback depth.

## Origin comments
- `packages/remnic-core/src/access-recall-response.ts:134` — "// Gate the raw-excerpt LCM read with the SAME read-authorization namespace"
- `packages/remnic-core/src/access-recall-response.ts:135` — "// `lcmSearch` + the in-prompt LCM sections use (#1505 thread 2f7), so"
- `packages/remnic-core/src/access-recall-response.ts:136` — "// `disclosure: \"raw\"` never attaches `<principal>-project-*` overlay rows"
- `packages/remnic-core/src/access-recall-response.ts:137` — "// when the principal can WRITE but not READ its self base (or"
- `packages/remnic-core/src/access-recall-response.ts:138` — "// `defaultRecallNamespaces` omits `self`). Computed ONLY for raw disclosure:"
- `packages/remnic-core/src/access-recall-response.ts:139` — "// it is the sole consumer, and resolving the overlay on every chunk/section"
- `packages/remnic-core/src/access-recall-response.ts:140` — "// recall would be wasted work — keeping non-raw recall byte-for-byte"
- `packages/remnic-core/src/access-recall-response.ts:141` — "// unchanged."
- `packages/remnic-core/src/access-recall-response.ts:142` — "// Trim the sessionKey to match what `orchestrator.recall(...)` already does"
- `packages/remnic-core/src/access-recall-response.ts:143` — "// (`request.sessionKey?.trim() || undefined`) and what the x-ray raw-excerpt"
- `packages/remnic-core/src/access-recall-response.ts:144` — "// path uses (cursor \"Raw excerpt key not trimmed\"). A whitespace-padded key"
- `packages/remnic-core/src/access-recall-response.ts:145` — "// otherwise drives recall under one identity but resolves the raw-excerpt"
- `packages/remnic-core/src/access-recall-response.ts:146` — "// overlay namespace + LCM `session_id` under a DIFFERENT (untrimmed) prefix,"
- `packages/remnic-core/src/access-recall-response.ts:147` — "// so excerpts are gated/queried inconsistently with recall and the x-ray path."
- `packages/remnic-core/src/access-recall-response.ts:157` — "// `undefined` for an IMPLICIT raw recall means NO readable LCM namespace"
- `packages/remnic-core/src/access-recall-response.ts:158` — "// exists (restrictive `default` READ policy, no readable overlay/self) —"
- `packages/remnic-core/src/access-recall-response.ts:159` — "// suppress excerpts rather than fall back to the write/overlay namespace the"
- `packages/remnic-core/src/access-recall-response.ts:160` — "// read gate excludes (#1505 thread NBHWz). An EXPLICIT namespace always"
- `packages/remnic-core/src/access-recall-response.ts:161` — "// resolves (or throws) above, so suppression only applies to the implicit"
- `packages/remnic-core/src/access-recall-response.ts:162` — "// path."
- `packages/remnic-core/src/access-recall-response.ts:170` — "// Ordered, read-authorized LCM read key SET (#1505 fallback unification) so"
- `packages/remnic-core/src/access-recall-response.ts:171` — "// raw disclosure finds excerpts a branch-scoped session archived at"
- `packages/remnic-core/src/access-recall-response.ts:172` — "// project/root scope — exactly as recall + `lcmSearch` do. Only with a"
- `packages/remnic-core/src/access-recall-response.ts:173` — "// concrete sessionKey; already read-gated."
- `packages/remnic-core/src/access-recall-surface.ts:1` — "Access recall read-surface (extracted from access-service.ts; god-file decomposition follow-through of #1526..."
- `packages/remnic-core/src/access-recall-surface.ts:498` — "Namespace for the LCM prefix: prefer the caller-supplied READ-AUTHORIZATION-GATED rawExcerptNamespace"
- `packages/remnic-core/src/access-recall-surface.ts:499` — "caller-supplied READ-AUTHORIZATION-GATED rawExcerptNamespace (#1505"
- `packages/remnic-core/src/access-recall-surface.ts:500` — "thread 2f7) so raw disclosure honours the same read gate as normal recall"
- `packages/remnic-core/src/access-recall-surface.ts:501` — "+ lcmSearch and never attaches principal-project-* overlay rows the"
- `packages/remnic-core/src/access-recall-surface.ts:502` — "gate excludes. Fall back to the snapshot's resolved namespace only when no"
- `packages/remnic-core/src/access-recall-surface.ts:503` — "gated namespace was threaded (sessionless / legacy callers) - unchanged."
- `packages/remnic-core/src/access-recall-surface.ts:506` — "Implicit raw recall with NO readable LCM namespace (#1505 thread"
- `packages/remnic-core/src/access-recall-surface.ts:507` — "NBHWz): emit empty excerpts rather than falling back to the"
- `packages/remnic-core/src/access-recall-surface.ts:508` — "write/overlay namespace the read gate excludes."
- `packages/remnic-core/src/access-recall-surface.ts:601` — "Privacy guard: raw disclosure must be session-scoped. Without a"
- `packages/remnic-core/src/access-recall-surface.ts:602` — "sessionKey, lcm.searchContextFull(query, n, undefined) searches"
- `packages/remnic-core/src/access-recall-surface.ts:603` — "across every archived session in the LCM store and would return"
- `packages/remnic-core/src/access-recall-surface.ts:604` — "excerpts from unrelated sessions (potentially crossing namespaces"
- `packages/remnic-core/src/access-recall-surface.ts:605` — "via their namespace:sessionKey prefix encoding). Treat a"
- `packages/remnic-core/src/access-recall-surface.ts:606` — "missing sessionKey as no excerpts - callers asking for raw"
- `packages/remnic-core/src/access-recall-surface.ts:607` — "disclosure outside a session get an empty list, not a leak."
- `packages/remnic-core/src/access-recall-surface.ts:621` — "Cap the excerpt fanout so recall responses stay bounded. Five matches"
- `packages/remnic-core/src/access-recall-surface.ts:622` — "is enough to anchor the model in the raw transcript without ballooning"
- `packages/remnic-core/src/access-recall-surface.ts:623` — "token spend; raw is meant as the escape hatch, not the default. The cap"
- `packages/remnic-core/src/access-recall-surface.ts:624` — "is applied across the MERGED result set so adding fallback keys never"
- `packages/remnic-core/src/access-recall-surface.ts:625` — "inflates the excerpt budget."
- `packages/remnic-core/src/access-recall-surface.ts:652` — "CLAUDE.md rule 13: never let an external subsystem (LCM/SQLite)"
- `packages/remnic-core/src/access-recall-surface.ts:653` — "crash the primary recall flow."
- `packages/remnic-core/src/access-recall-surface.ts:1200` — "Read-authorization-gated namespace for the raw-excerpt LCM lookup"
- `packages/remnic-core/src/access-recall-surface.ts:1201` — "(#1505 thread 2f7). NOT snapshot.namespace (the write/overlay"
- `packages/remnic-core/src/access-recall-surface.ts:1202` — "namespace), which would attach principal-project-* overlay rows"
- `packages/remnic-core/src/access-recall-surface.ts:1203` — "when the principal can WRITE but not READ its self base. Mirrors the"
- `packages/remnic-core/src/access-recall-surface.ts:1204` — "recall + lcmSearch read gate. Resolved ONLY for raw disclosure (its"
- `packages/remnic-core/src/access-recall-surface.ts:1205` — "sole consumer); the namespace above is still used for the"
- `packages/remnic-core/src/access-recall-surface.ts:1206` — "memory-FILE reads below (a separate, snapshot-scoped read), so non-raw"
- `packages/remnic-core/src/access-recall-surface.ts:1207` — "x-ray decoration stays byte-for-byte unchanged."
- `packages/remnic-core/src/access-recall-surface.ts:1216` — "undefined for an IMPLICIT raw recall means NO readable LCM namespace"
- `packages/remnic-core/src/access-recall-surface.ts:1217` — "exists (restrictive default READ policy, no readable overlay/self)"
- `packages/remnic-core/src/access-recall-surface.ts:1218` — "- suppress excerpts rather than fall back to the write/overlay"
- `packages/remnic-core/src/access-recall-surface.ts:1219` — "namespace the read gate excludes (#1505 thread NBHWz)."
- `packages/remnic-core/src/access-recall-surface.ts:1227` — "Ordered, read-authorized LCM read key SET (#1505 fallback"
- `packages/remnic-core/src/access-recall-surface.ts:1228` — "unification) so raw disclosure finds excerpts a branch-scoped session"
- `packages/remnic-core/src/access-recall-surface.ts:1229` — "archived at project/root scope - exactly as recall + lcmSearch do."
- `packages/remnic-core/src/access-recall-surface.ts:1230` — "Only meaningful with a concrete sessionKey + a readable namespace;"
- `packages/remnic-core/src/access-recall-surface.ts:1231` — "already read-gated so no unauthorized overlay key is present."
- `packages/remnic-core/src/access-recall-surface.ts:1352` — "Same read-authorization-gated raw-excerpt namespace the recall path uses"
- `packages/remnic-core/src/access-recall-surface.ts:1353` — "(#1505 thread 2f7), so the includeRecall x-ray path can't leak overlay"
- `packages/remnic-core/src/access-recall-surface.ts:1354` — "transcript rows via raw disclosure. Resolved ONLY for raw disclosure (the"
- `packages/remnic-core/src/access-recall-surface.ts:1355` — "sole consumer) so non-raw x-ray recall stays byte-for-byte unchanged. The"
- `packages/remnic-core/src/access-recall-surface.ts:1356` — "ordered LCM read key SET (#1505 fallback unification) adds the coding read"
- `packages/remnic-core/src/access-recall-surface.ts:1357` — "fallbacks so a branch-scoped session also finds excerpts at project/root"
- `packages/remnic-core/src/access-recall-surface.ts:1358` — "scope."
- `packages/remnic-core/src/access-recall-surface.ts:1368` — "exists - suppress excerpts rather than fall back to the write/overlay"
