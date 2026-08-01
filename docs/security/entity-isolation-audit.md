# Entity Isolation Audit

> **Scope:** cross-entity fact contamination **within a single tenant / namespace**.
> Cross-tenant isolation is covered separately by the namespace test suite
> (`tests/identity-namespaces.test.ts`, `tests/namespace-search-router.test.ts`,
> `tests/namespace-migrate.test.ts`, `tests/namespaces-router.test.ts`,
> `tests/orchestrator-graph-namespace.test.ts`,
> `tests/orchestrator-routing-contradiction-namespace.test.ts`).
> This document audits how Remnic prevents facts about Person-A1 from being
> attributed to or surfaced as Person-B1 when both live in the same user's
> memory store.
>
> Tracking issue: [#682](https://github.com/joshuaswarren/remnic/issues/682).

## 1. Threat model

### 1.1 Trust boundary

The relevant trust boundary in this audit is **per-entity** rather than
per-tenant. Within one user's memory store, every recall path must enforce:

| Invariant | Statement |
| --- | --- |
| **I-1** | A fact tagged `entityRef: person-alice-a1` MUST NOT surface as evidence about `person-bob-b1`, even if Bob's name appears in the query, transcript, or seed pool. |
| **I-2** | Two entities sharing a display name (e.g. two contacts both called "Alice-Test") MUST be retrieved by **canonical id**, never by display name alone. |
| **I-3** | Renaming an entity MUST NOT cause facts attached to the old canonical id to be silently re-attributed to a newer entity that adopted the old display name. |
| **I-4** | A memory chunk that mentions multiple entities MUST attribute each fact to the correct entity — chunk-level entity tags MUST propagate through chunking, reranking, and citation rendering. |
| **I-5** | A peer-profile reasoner (issue [#679](https://github.com/joshuaswarren/remnic/issues/679)) MUST gate updates by per-peer interaction stream and MUST NOT cross-attribute facts between collaborators with overlapping context. |
| **I-6** | An attribution-bearing surface (citations, hint blocks, source attributions, `<oai-mem-citation>` blocks) MUST carry the `entityRef` of the **stored** memory, not the entity inferred from the query. |

### 1.2 Adversary / failure model

This audit treats the contamination risk as an **honest-mistake / sloppy-rank**
failure mode rather than a malicious adversary. The actor surfaces are:

- The user (sends ambiguous queries, reuses names, renames entities).
- The extraction pipeline (writes facts; can mis-tag `entityRef`).
- The retrieval pipeline (reads facts; can rank wrong-entity matches above
  right-entity matches).
- Background consolidation (merges memories; can collapse two entities into one).

A malicious-prompt attacker is out of scope for this document — that risk is
covered by `docs/security/memory-extraction-threat-model.md`.

### 1.3 Synthetic fixtures

Per the project's PUBLIC repo policy, every entity used in tests and examples
MUST be synthesized with clearly fake names — examples below use
`Person-A1`, `Person-B1`, `Project-A1`, `Alice-Test`. No real names, no real
emails, no real account ids. See `CLAUDE.md` privacy rules.

## 2. Attributed-read paths

The following sections enumerate every Remnic code path that produces an
**entity-attributed result** — that is, a result whose presentation links a
fact to a specific entity. For each path: the isolation mechanism, an
observable risk, and the existing or planned regression test.

### 2.1 Entity-aware retrieval — `entity-retrieval.ts`

**Path:** `buildEntityRecallSection()` in
`packages/remnic-core/src/entity-retrieval.ts` is invoked from the orchestrator
during `before_prompt_build`. It produces the `## entity_answer_hints` block
appended to the recall payload.

**Pipeline:**

1. `buildEntityMentionIndex()` reads `storage.readAllEntityFiles()` and
   `storage.readAllMemories()`, computes a canonical id via
   `normalizeEntityName(entity.name, entity.type)` (storage.ts:768), and stores
   each entity under that id.
2. `resolveExplicitCandidates()` scores each entity entry against the query
   using **alias matching**: it walks `[entry.name, ...entry.aliases]` and
   computes `scoreAliasMatch(query, alias)` (entity-retrieval.ts:148).
3. `resolveRecentTurnCandidates()` does the same against the last N transcript
   turns (entity-retrieval.ts:421).
4. The top-K candidates are passed to `buildHintSnippets()`, which composes
   facts/timeline/relationships **only from that one entry's stored fields**.

**Isolation mechanism:**

- Canonical id is `${type}-${normalized-name}`. Two entities with different
  types but identical display names live under different ids
  (`person-alice-test` vs. `org-alice-test`).
- `buildHintSnippets()` reads only `entry.facts`, `entry.structuredSections`,
  `entry.timeline`, etc. from the matched entry — it never cross-references
  another entry's facts.
- Memory snippets are gated by an exact `frontmatter.entityRef === entry.canonicalId`
  match (entity-retrieval.ts:354–362).

**Observable risks:**

- **R-1 (same display name, same type — silent overwrite):** two
  `person`-typed entities both named "Alice-Test" share the same canonical id
  `person-alice-test` (because `normalizeEntityName(name, type)` is the only
  key). `buildEntityMentionIndex()` puts each entry into the `entities` map
  via `entities.set(canonicalId, …)` (entity-retrieval.ts:328) — so when two
  on-disk entity files share that key, the second `set()` **silently
  overwrites** the first. The losing entity's facts, timeline,
  relationships, and structured sections become unreachable through the
  hint surface for the remainder of the index lifetime, while the winning
  entity is rendered as if it owned both bodies of evidence. The "winner" is
  determined by `storage.readAllEntityFiles()` iteration order, which is
  filesystem-dependent and therefore non-deterministic across hosts. Any
  memory whose `frontmatter.entityRef` happens to match the canonical id is
  then attached to the winner regardless of which on-disk entity originally
  owned it.
- **R-2 (alias collision):** if user-defined aliases in `config/aliases.json`
  map both `alice` and `alice-test` to `alice-test`, two distinct people whose
  facts were ingested under different aliases can collapse onto the same
  canonical id at index-build time. Once collapsed, `buildHintSnippets()`
  faithfully renders the merged entity — but the **merge itself** is the
  contamination event.
- **R-3 (recent-turn alias drag):** `resolveRecentTurnCandidates()` boosts
  candidates whose alias appears in the last N turns. A query "what does she
  prefer?" with no entity name will pull whichever entity appeared most
  recently in transcript — even if the user actually meant a different entity.
  This is "follow-up" semantics by design, but it can mis-attribute when two
  pronoun-eligible entities are both in recent context.
- **R-4 (alias substring):** `containsPhrase()` (entity-retrieval.ts:88) uses
  word-boundary regex on the **normalized** alias. A short alias like "A1"
  could match longer queries containing "A12" if normalization strips the
  digit-letter boundary. Currently `normalizeEntityText()` lowercases and
  collapses whitespace but does not segment letter/digit transitions.

**Existing tests:** `tests/entity-retrieval.test.ts`,
`tests/entity-synthesis-orchestrator.test.ts`. **None** of these assert
isolation between two same-name distinct-id entities. PR 2 of this issue adds
the contamination test suite.

### 2.2 Direct-answer eligibility — `direct-answer.ts`

**Path:** `isDirectAnswerEligible()` in
`packages/remnic-core/src/direct-answer.ts` filters a candidate pool down to a
single high-confidence answer. Wired via `direct-answer-wiring.ts` from the
orchestrator (#523, #518 slice 2/8).

**Pipeline:** ordered filter chain. The relevant filter for this audit is
`FILTER_LABELS.entityRefMismatch` (direct-answer.ts:185–192):

```
if (queryEntityRefs && queryEntityRefs.length > 0) {
  const normRefs = new Set(queryEntityRefs.map((r) => r.toLowerCase()));
  working = applyFilter(working, filteredBy, FILTER_LABELS.entityRefMismatch, (c) => {
    const ref = c.memory.frontmatter.entityRef;
    if (!ref) return true;          // ← passes through memories with NO entityRef
    return normRefs.has(ref.toLowerCase());
  });
}
```

**Isolation mechanism:**

- When the caller supplies `queryEntityRefs`, candidates whose `entityRef` is
  **set and different** from any hint are filtered out.
- Existing test coverage: `direct-answer.test.ts` line 272
  ("filters candidates whose entityRef does not match provided hints").

**Observable risks:**

- **R-5 (untagged-memory passthrough):** a memory with no `entityRef`
  frontmatter passes the filter even when the query is explicitly scoped to
  an entity. This is a deliberate design choice (don't filter out general
  knowledge), but it means contamination can occur whenever an extraction-time
  bug omitted the `entityRef` for a memory that **actually** describes a
  specific entity.
- **R-6 (case-only normalization):** the filter lowercases on both sides and
  tests `Set.has`. It does **not** apply `normalizeEntityName()`. A memory
  written with `entityRef: "Alice Test"` (mid-string space) and a hint
  `"alice-test"` (slug form) would not match. Real production memories use
  the slug form, so this is low-risk in practice — but it is an asymmetry
  worth noting.

**Existing tests:** `direct-answer.test.ts:272–321` covers the basic mismatch
path and the "no entityRef on memory" passthrough. No test covers a
**user-confirmed** wrong-entity memory that survives the importance-floor
bypass at line 181 — `verificationState === "user_confirmed"` short-circuits
the importance floor, but **does not** short-circuit the entity filter; that
ordering is correct and is asserted by the contamination suite in PR 2.

### 2.3 Graph retrieval — `graph-recall.ts` / `graph-retrieval.ts`

**Path:** `runGraphRecall()` (graph-recall.ts) → `buildGraphFromMemories()`
(graph-retrieval.ts:817) → `extractGraphEdges()` (graph-retrieval.ts:629). This
tier is gated by `recallGraphEnabled` (default `false` until benched) and runs
Personalized PageRank from query-derived seeds.

**Edge semantics relevant to attribution:**

- `mentions` edges: `memory → entity` for every value in
  `memory.entityRef` and `memory.entityRefs[]`.
- `authored-by` edges: `memory → agent:<id>` parsed from inline
  `[Source: agent=…]` citations.
- `derived-from`, `supersedes`, `lineage` edges: `memory → memory` only — the
  `canTargetMemory()` guard (graph-retrieval.ts:725) rejects a memory→entity
  edge mistyped as `derived-from`.

**Isolation mechanism:**

- The "claimed by entity vs. memory" pre-scan (graph-retrieval.ts:660–705)
  ensures an id used as both a memory and an entity in the same batch resolves
  deterministically: memory wins. This prevents a stray entity mention from
  silently rewriting a memory→memory `supersedes` edge into a memory→entity
  edge with the wrong type.
- PPR returns memory-typed nodes only. Entity nodes are filtered out before
  results are merged with QMD via MMR.

**Observable risks:**

- **R-7 (seed pollution):** the orchestrator passes "entity-exact matches" as
  PPR seeds. If the seed-derivation path picks the **wrong** entity for an
  ambiguous query, PPR will boost memories `mentions`-connected to that
  entity, and those memories may carry their own additional `entityRef` to a
  different entity. The PPR score does not encode "which seed brought this
  memory in" — once a memory is in the result set, downstream consumers see it
  as relevant without provenance back to the seed.
- **R-8 (entity-node id collision):** `entityRef` and `entityRefs` are
  consumed as opaque strings. If the writer normalized one ref via
  `normalizeEntityName()` and another via raw display name, the same logical
  entity appears as two graph nodes. PPR treats them as separate, so memories
  carrying the un-normalized form do not boost via the normalized seed. This
  is an **under**-recall risk, not a contamination risk per se, but it makes
  the contamination story harder to reason about.

**Existing tests:** `graph-recall.test.ts`, `graph-retrieval.test.ts`. Edge
extraction is well-tested; **seed-derivation** (the contamination-prone step)
is tested at the orchestrator boundary, not here.

### 2.4 Recall enrichment / source attribution — `source-attribution.ts`, `citations.ts`

**Path:** after recall produces a memory list, `source-attribution.ts`
annotates each memory with provenance metadata, and `citations.ts` emits
`<oai-mem-citation>` blocks consumed by Codex.

**Isolation mechanism:**

- The `entityRef` rendered into the citation block is read from
  `memory.frontmatter.entityRef` of the **stored** memory, not derived from
  the query. This satisfies invariant **I-6**.
- Per CLAUDE.md gotcha #23, hash operations use `rawContent` consistently;
  this prevents a citation block from being attributed to a memory other than
  the one that produced it.

**Observable risks:**

- **R-9 (multi-entity chunk):** when a single memory file describes facts
  about two entities ("Alice-Test introduced Bob-B1 to Project-A1"), the
  frontmatter carries one `entityRef` and (optionally) `entityRefs[]`. The
  rendered citation attributes the **whole chunk** to the primary
  `entityRef`. A reader who consumes the chunk for a fact about the
  secondary entity will see provenance pointing at the wrong entity. This is
  invariant **I-4** — chunk-level attribution of multi-entity facts is the
  single largest gap surfaced by this audit.

**Existing tests:** `tests/citations*.test.ts` covers block rendering;
`tests/source-attribution.test.ts` covers single-entity attribution. No test
asserts correct attribution for a multi-entity chunk; PR 2 adds one.

### 2.5 Briefing / focus filtering — `briefing.ts`

**Path:** `focusMatchesMemory()` (briefing.ts:200) decides whether a memory
counts toward a focused briefing window.

**Isolation mechanism:**

- Compares `memory.frontmatter.entityRef` (lowercased) against the slug form
  of the typed focus (e.g. `person:Alice-Test` → `person-alice-test`) using
  `entityRef.includes(slug)`.

**Observable risks:**

- **R-10 (substring match):** `entityRef.includes(slug)` is a substring test,
  not an equality test. `entityRef = "person-alice-test-a1"` contains the
  slug `"person-alice-test"`, so a focus on `Alice-Test` would pull in facts
  about `Alice-Test-A1` (a different entity that happens to share a prefix).
  This is the most concrete substring-collision risk in the audit.

**Existing tests:** `tests/briefing.test.ts` covers slug-form matching but does
**not** assert non-prefix isolation between similarly-named entities. PR 2
adds one.

### 2.6 Calibration — `calibration.ts`

**Path:** `calibration.ts:145–146` parses `entityRef` from corrections frontmatter
and uses it as a single-element `entityRefs` list when computing calibration
weights.

**Isolation mechanism:**

- The regex `^entityRef:\s*(.+)$/m` extracts the literal frontmatter value.
  No normalization, no aliasing.

**Observable risks:**

- **R-11 (correction mis-attribution):** a correction memory whose frontmatter
  `entityRef` is a stale display name (e.g. "Old Alice") never matches the
  canonical id of the renamed entity. The correction's calibration weight is
  effectively dropped. This is an **under**-calibration risk; not direct
  contamination, but it weakens the user's ability to correct contamination
  once observed. Tracked here for completeness.

**Existing tests:** `tests/calibration.test.ts` covers basic weighting; no
test asserts behavior under entity rename.

### 2.7 Peer-profile reasoner — depends on issue #679

**Path:** Not yet implemented. Issue [#679](https://github.com/joshuaswarren/remnic/issues/679)
will introduce per-peer profiles that aggregate facts across interactions with
a specific collaborator.

**Planned isolation invariant (I-5):** a peer-profile update for `Alice-Test`
must be gated by a per-peer interaction stream — facts that arrived during a
conversation **with** `Alice-Test` (or **about** `Alice-Test`) are eligible;
facts from a conversation with `Bob-B1` that incidentally mention
`Alice-Test` are not.

**Audit gap:** because #679 has not landed, PR 2 of this issue **does not**
add a regression test for the peer reasoner, and PR 3 of this issue will not
implement a peer-side hardening fix. When #679 lands, its acceptance criteria
must include the contamination scenarios this audit documents (same-name peers,
shared-conversation peers).

## 3. Indexing-time attribution paths

The risks above all describe **read-side** contamination. For completeness,
this section enumerates the **write-side** points where `entityRef` is
established — a contamination introduced at write time persists across every
read path until the memory is corrected or superseded.

### 3.1 Extraction — `extraction.ts`, `extraction-judge.ts`

`entityRef` and `entityRefs[]` are emitted by the LLM extractor and validated
by the judge. The judge does **not** re-derive the entity from the fact
content; it only judges whether the fact is durable enough to write. A
mis-tagged `entityRef` from the extractor passes the judge unchanged.

**Risk R-12 (extractor mis-tag):** the extractor sees the full conversation
context. If two entities are both in context, the extractor may mis-tag a
fact. The judge cannot catch this. The contamination test suite in PR 2 uses
direct `storage.writeMemory()` calls with deliberately mis-tagged `entityRef`
to exercise the **read-side** invariants in isolation, which is the correct
factoring for this audit's scope.

### 3.2 Storage — `storage.ts`

`storage.writeMemory()` writes the `entityRef` from frontmatter as-is. There
is no read-after-write entity validation. This is the right design — storage
is the source of truth — but it means contamination introduced at extraction
time is not caught at storage time.

`normalizeEntityName()` (storage.ts:768) is the canonical-id producer. It
checks user aliases (`config/aliases.json`) before built-in aliases. **An
alias change retroactively re-canonicalizes existing entity files at
read-build time** — `buildEntityMentionIndex()` recomputes `canonicalId`
every build (entity-retrieval.ts:322), so adding an alias can collapse two
previously-separate entities. This is the alias-merge contamination path
described in R-2.

### 3.3 Semantic consolidation — `semantic-consolidation.ts`, `dedup/`

Consolidation merges semantically-similar memories. The merge logic preserves
the `entityRef` of one of the input memories. **Risk R-13:** if two
high-similarity memories carry **different** `entityRef` values, the
consolidator picks one and drops the other from frontmatter. The losing
entity's facts become un-discoverable via entity recall. This is an
under-recall failure for the losing entity, and a cross-entity contamination
for the winning entity (whose memory now contains content about a different
entity).

The dedup pipeline (`dedup/`) computes hashes from `rawContent` (CLAUDE.md
gotcha #23). It does **not** factor `entityRef` into the dedup key. Two
memories with the same content but different `entityRef` would currently
dedup against each other. Whether this is desired behavior depends on
interpretation — the contamination suite in PR 2 includes a scenario for
this and the verdict is reported alongside other findings.

## 4. Audit gap summary

Of the 13 enumerated risks, the following are **in-scope** for the
contamination test suite (PR 2) and any resulting hardening (PR 3):

| Risk | Scenario | Status after audit |
| --- | --- | --- |
| R-1 | Same display name + same type — silent overwrite in entity index | Test in PR 2; if fail, fix in PR 3 |
| R-2 | Alias merge collapses distinct entities | Test in PR 2; documented limitation if fix would break legitimate merges |
| R-3 | Recent-turn alias drag picks wrong entity for pronoun queries | Test in PR 2; documented as designed |
| R-4 | Alias substring match across letter/digit boundaries | Test in PR 2; small fix in PR 3 if confirmed |
| R-5 | Untagged memories pass direct-answer entity filter | Test in PR 2; documented as designed |
| R-6 | Direct-answer filter case-only normalization | Test in PR 2; small normalization fix in PR 3 |
| R-7 | Graph PPR seed pollution | Test in PR 2; documented (graph tier ships disabled) |
| R-8 | Entity-node id collision when refs not normalized | Test in PR 2; small normalization fix in PR 3 |
| R-9 | Multi-entity chunk citation attribution | Test in PR 2; if fail, fix in PR 3 (chunk-level entity tags) |
| R-10 | Briefing focus substring match | Test in PR 2; equality fix in PR 3 |
| R-11 | Correction `entityRef` not normalized | Test in PR 2; small normalization fix in PR 3 |
| R-12 | Extractor mis-tag (write-side) | Out of audit scope; relies on extraction tests |
| R-13 | Semantic consolidation drops losing-entity ref | Test in PR 2; verdict-driven |

The **out-of-scope** risk is:

- **I-5 / peer reasoner** — depends on issue #679. Not testable today; will be
  enforced as part of #679's acceptance.

## 5. Acceptance hooks

- This audit document covers every attributed-read path with explicit
  isolation mechanism — see Section 2.
- The contamination test suite in PR 2 (`tests/entity-contamination.test.ts`)
  exercises each in-scope risk row above.
- The `npm run test:entity-hardening` script in `package.json` is an
  **explicit file list** (it invokes `tsx --test` with named paths), not a
  glob discovery. PR 2 must therefore append `tests/entity-contamination.test.ts`
  to that file list as part of the same PR; otherwise the new suite will not
  run under the existing entity-hardening preflight gate even though it lives
  in `tests/`.

## 6. References

- `packages/remnic-core/src/entity-retrieval.ts` — entity recall section builder
- `packages/remnic-core/src/entity-schema.ts` — entity type / section definitions
- `packages/remnic-core/src/storage.ts` — `normalizeEntityName()` (line 768)
- `packages/remnic-core/src/direct-answer.ts` — `isDirectAnswerEligible()` (line 185)
- `packages/remnic-core/src/graph-recall.ts`, `graph-retrieval.ts` — graph tier
- `packages/remnic-core/src/source-attribution.ts`, `citations.ts` — attribution surfaces
- `packages/remnic-core/src/briefing.ts` — `focusMatchesMemory()` (line 200)
- `packages/remnic-core/src/calibration.ts` — `entityRef` parsing (line 145)
- `tests/identity-namespaces.test.ts` and siblings — cross-tenant isolation
- `docs/security/memory-extraction-threat-model.md` — adversarial extraction
- Issue [#679](https://github.com/joshuaswarren/remnic/issues/679) — peer modeling
- Issue [#682](https://github.com/joshuaswarren/remnic/issues/682) — this work
- [Thoth](https://github.com/codingthefuturewithai/thoth) — three-layer
  anti-contamination reference (Camp 2 differentiator)
