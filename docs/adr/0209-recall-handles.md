# Recall handles are short hex tokens derived from memory ids, widened group-wise on collision, and only resolvable within a session

Status: accepted

## Context
Injected recall context cites memories with short 4-hex handles so a model can reference them in follow-ups. Four hex characters collide (birthday bound in a 65,536-space is ~300 samples), entity reconstructions carry .md paths whose basenames are not loadable memory ids, and handle-shaped tokens can appear in user text when handles are off. Resolution depends on recorded recall history keyed by session.

## Decision
Handles are derived from the memory id's sha256 prefix. On a width-4 collision, ALL members of the collision group widen together — never just the later one — so no displayed token stays ambiguous; if a group still collides at the extended width, widen all members again, iterating until no collision remains or every member reaches HANDLE_MAX_WIDTH (identical 8-char prefixes are irreducible; stop rather than loop forever; the same id listed twice is fine). Resolution is prefix-based: a widened handle still matches its own shorter core, so a user citing the short form resolves the widened memory. Only memory ids are handle-eligible (ids are `${category}-${Date.now()}-...`); entity reconstructions and bare names get NO handle because citing one would resolve to an unloadable basename. A recall that injects context without a sessionKey renders NO handles — handle history is only recorded per session, so tokens shown without one could never resolve. Stripping is bounded: remove the token plus exactly one preceding space (`\s?`, not `\s*`, to avoid polynomial ReDoS on uncontrolled input), then collapse leftover double spaces; when handles are OFF, buffering is untouched even if a handle-shaped token appears. A bare token is treated as a handle only when it is pure hex in the width range, so a real memory id that happens to be 4 hex chars is not misclassified. Resolution consults a bounded snapshot lookback depth (configurable); a cited handle with no recorded history surfaces as an input error BEFORE the planner runs, and a downstream fault (empty candidates, LLM unavailable) is out of the resolver's scope. Tests engineer genuine collisions by searching a real id space (never faking one); if no collision is found in budget they skip and cover the ambiguous branch in the pure-module test with fixtures.

## Consequences
Cited handles only resolve inside the session and lookback window that recorded them. Collision widening makes some tokens longer than 4 chars. Irreducible collisions (astronomically unlikely) cannot be disambiguated.

## Origin comments
(64 records)
- `packages/remnic-core/src/recall-handles-wiring.test.ts:82` — "/** * Test-only view of the private QMD results formatter. `formatQmdResults` is * private on the Orchestrator; this nam"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:179` — "// Entity reconstructions can carry an `.md` path whose basename is a bare"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:180` — "// entity name (e.g. entities/Widget.md). Such a basename is not a loadable"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:181` — "// memory id, so it must NOT receive a handle — citing one would resolve to"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:182` — "// "Widget", which no storage can getMemoryById."
- `packages/remnic-core/src/recall-handles-wiring.test.ts:198` — "// A recall that injects context without a session key renders NO handles:"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:199` — "// the handle history is only recorded when sessionKey is present, so tokens"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:200` — "// shown without it could never be resolved (cursor review of #1582)."
- `packages/remnic-core/src/recall-handles-wiring.test.ts:253` — "// Force a genuine width-4 collision: two distinct ids whose 4-hex handle"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:254` — "// matches. Birthday bound in a 65 536-space is ~300 samples, so a single"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:255` — "// linear pass with a Map finds one quickly (and deterministically for a fixed"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:256` — "// search prefix). In practice collisions across ~10–40 memories are"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:257` — "// vanishingly rare; this pins the disambiguation contract regardless."
- `packages/remnic-core/src/recall-handles-wiring.test.ts:275` — "// No collision found in the budget — skip rather than fake the scenario."
- `packages/remnic-core/src/recall-handles-wiring.test.ts:276` — "// The pure-module test (recall-handles.test.ts) covers the ambiguous"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:277` — "// branch with fixture snapshots directly."
- `packages/remnic-core/src/recall-handles-wiring.test.ts:338` — "// Even if a handle-shaped token appears (e.g. user typed it), the OFF path"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:339` — "// does not strip: nothing is injected, so buffering must be untouched."
- `packages/remnic-core/src/recall-handles-wiring.test.ts:383` — "// No recorded recall history → any handle cited as a target misses, and the"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:384` — "// shared resolver surfaces it as an input error BEFORE the planner runs."
- `packages/remnic-core/src/recall-handles-wiring.test.ts:431` — "// The planner runs after resolution. With a known id it proceeds to"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:432` — "// search/locate; the contract we assert is that resolution did NOT throw"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:433` — "// (i.e. the handle was accepted and mapped). A downstream contract fault"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:434` — "// (empty candidate set / LLM unavailable) is out of scope here — the"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:435` — "// resolver's job is done once the handle maps to an id without error, which"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:436` — "// we prove by confirming no handle-resolution miss escapes."
- `packages/remnic-core/src/recall-handles-wiring.test.ts:489` — "// Read the buffered turns directly and assert the strip held — the buffer is"
- `packages/remnic-core/src/recall-handles-wiring.test.ts:490` — "// the extraction source, so if it is clean the persisted corpus is clean."
- `packages/remnic-core/src/recall-handles.test.ts:76` — "// Engineer a collision: two synthetic ids whose sha256 prefix collides at 4"
- `packages/remnic-core/src/recall-handles.test.ts:77` — "// chars. Search a small id space for a real collision so the test is honest."
- `packages/remnic-core/src/recall-handles.test.ts:95` — "// BOTH colliding members widen: leaving the first at 4 chars would make its"
- `packages/remnic-core/src/recall-handles.test.ts:96` — "// displayed handle ambiguous to resolve against the group (codex review)."
- `packages/remnic-core/src/recall-handles.test.ts:268` — "// MemoryCategory includes reasoning_trace; StorageManager writes ids as"
- `packages/remnic-core/src/recall-handles.test.ts:269` — "// `${category}-${Date.now()}-...`, so these must be handle-eligible."
- `packages/remnic-core/src/recall-handles.test.ts:276` — "// Entity reconstructions (entities/Widget.md) and bare names must NOT receive"
- `packages/remnic-core/src/recall-handles.test.ts:277` — "// a handle — citing one would resolve to an unloadable basename."
- `packages/remnic-core/src/recall-handles.ts:1` — "recall-handles.ts — injection-time memory handles (issue #1582)."
- `packages/remnic-core/src/recall-handles.ts:141` — "Group ids by their default-width handle so every member of a 4-char"
- `packages/remnic-core/src/recall-handles.ts:142` — "collision group widens to 6 together — not just the later one. Widening"
- `packages/remnic-core/src/recall-handles.ts:143` — "only the second id would leave the first rendering a 4-char token whose"
- `packages/remnic-core/src/recall-handles.ts:144` — "resolution is ambiguous against the group (codex review)."
- `packages/remnic-core/src/recall-handles.ts:161` — "Reconciliation pass: if two DIFFERENT ids still produce the same rendered"
- `packages/remnic-core/src/recall-handles.ts:162` — "token at their assigned width — the pathological case where they also"
- `packages/remnic-core/src/recall-handles.ts:163` — "collide at the extended 6-char width — widen ALL members of the collision"
- `packages/remnic-core/src/recall-handles.ts:164` — "group together, never just the later one. Leaving the first at 6 chars"
- `packages/remnic-core/src/recall-handles.ts:165` — "while widening the second to 7 makes the first token resolve ambiguously"
- `packages/remnic-core/src/recall-handles.ts:166` — "(both ids match at width 6). Iterate until no collision remains or every"
- `packages/remnic-core/src/recall-handles.ts:167` — "member reaches HANDLE_MAX_WIDTH (codex review)."
- `packages/remnic-core/src/recall-handles.ts:181` — "same id listed twice — same handle is fine"
- `packages/remnic-core/src/recall-handles.ts:182` — "Only continue widening if at least one entry has room to grow."
- `packages/remnic-core/src/recall-handles.ts:183` — "When every member has reached HANDLE_MAX_WIDTH the collision is"
- `packages/remnic-core/src/recall-handles.ts:184` — "irreducible (two ids with identical sha256 8-char prefixes —"
- `packages/remnic-core/src/recall-handles.ts:185` — "astronomically unlikely for real data); stop to avoid an infinite loop."
- `packages/remnic-core/src/recall-handles.ts:271` — "Remove the token and the single preceding space that {@link appendHandle}"
- `packages/remnic-core/src/recall-handles.ts:272` — "added, then tidy any double space left behind."
- `packages/remnic-core/src/recall-handles.ts:273` — "\s? (not \s*): the renderer appends exactly one preceding space, and a"
- `packages/remnic-core/src/recall-handles.ts:274` — "bounded quantifier avoids the polynomial-ReDoS flag on uncontrolled input."
- `packages/remnic-core/src/recall-handles.ts:275` — "A stray run of spaces is collapsed by the following line."
- `packages/remnic-core/src/recall-handles.ts:301` — "bare 4f2a — only treat as a handle when it is pure hex in the width range,"
- `packages/remnic-core/src/recall-handles.ts:302` — "so we don't mis-classify a real memory id that happens to be 4 hex chars."
- `packages/remnic-core/src/recall-handles.ts:384` — "A handle resolves when a memory id's handle is a PREFIX of `hex` (handles"
- `packages/remnic-core/src/recall-handles.ts:385` — "widened to 6 chars for collision still match their own 4-char core, and a"
- `packages/remnic-core/src/recall-handles.ts:386` — "user citing the short form must still resolve the widened memory)."
- `packages/remnic-core/src/recall-handles.ts:409` — "Default snapshot lookback depth for handle resolution (issue #1582 config"
