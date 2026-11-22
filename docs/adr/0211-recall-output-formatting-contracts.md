# Recall output rendering is byte-identical by default and changes only behind explicit feature flags

Status: accepted

## Context
Recall output feeds prompts and citations; unannounced format changes break downstream parsers and any internal absolute path leaking into a citation lets a reader load unintended files. Handles and provenance must stay truthful to what can actually be resolved.

## Decision
New annotations (superseded prefix, drift note, origin fencing) render only when their feature flag is on — with flags off, output stays byte-identical to the previous release. Display paths are memoryDir-relative in the exact form the citation resolver decodes back to the owning namespace; internal absolute paths never leak. Unresolvable origins (harmonic nodes, archived turns, rules without copied origin) fence as unknown — least privilege — when origin authority is on. Connector labels truncate rather than suppress. Persisted provenance derives exclusively from hydrated frontmatter, and handle/citation admission records only ids that can actually load. Display-safe copies never mutate the input snapshot, and admitted-id recording is skipped only when both handles and navigation are off.

## Consequences
Flag-off deployments see zero rendering change but also none of the new annotations; origin-unknown fencing shows fenced output for content whose origin was legitimately absent. The citation format and the resolver are a matched pair — changing one requires the other.

## Origin comments
- `packages/remnic-core/src/orchestration/recall-internal.ts:5258` — "// readers see the snapshot without degradations, and a concurrent"
- `packages/remnic-core/src/orchestration/recall-internal.ts:5259` — "// same-session recall could drop them entirely (codex + cursor"
- `packages/remnic-core/src/orchestration/recall-internal.ts:5260` — "// reviews on #1544)."
- `packages/remnic-core/src/orchestration/recall-internal.ts:5266` — "// Record admitted ids when handles render OR navigation needs authority."
- `packages/remnic-core/src/orchestration/recall-internal.ts:5267` — "// Handles-off + navigation-on is the shipped default; skip only when both are off."
- `packages/remnic-core/src/orchestration/recall-internal.ts:5269` — "// Only handle-eligible ids aid resolution; filter out non-memory .md"
- `packages/remnic-core/src/orchestration/recall-internal.ts:5270` — "// basenames (entity reconstructions) so the resolver never records a"
- `packages/remnic-core/src/orchestration/recall-internal.ts:5271` — "// citation target that cannot be loaded."
- `packages/remnic-core/src/orchestration/recall-introspection.ts:323` — "// Issue #681 PR 3/3 — surface per-edge confidence in the"
- `packages/remnic-core/src/orchestration/recall-introspection.ts:324` — "// graph-explain document. Legacy snapshots without"
- `packages/remnic-core/src/orchestration/recall-introspection.ts:325` — "// `edgeConfidence` render as `conf=n/a` so older payloads"
- `packages/remnic-core/src/orchestration/recall-introspection.ts:326` — "// remain readable."
- `packages/remnic-core/src/orchestration/recall-introspection.ts:457` — "// Resolve the observation namespace set through the SAME ScopePlan resolver"
- `packages/remnic-core/src/orchestration/recall-introspection.ts:458` — "// the main recall path uses (#1521). The observe path does NOT throw on an"
- `packages/remnic-core/src/orchestration/recall-introspection.ts:459` — "// unreadable override (it falls through to the coding/legacy branches), so"
- `packages/remnic-core/src/orchestration/recall-introspection.ts:460` — "// we skip the readability gate the recall path enforces."
- `packages/remnic-core/src/orchestration/recall-introspection.ts:632` — "// Issue #1526 (seam 14): graph-recall snapshot moved to"
- `packages/remnic-core/src/orchestration/recall-introspection.ts:633` — "// GraphRecallCoordinator. Thin delegation keeps the private API stable."
- `packages/remnic-core/src/orchestration/recall-recognition-index.ts:1` — "Recognition-index write-path maintenance (issue #2975)."
- `packages/remnic-core/src/orchestration/recall-recognition-index.ts:161` — "`changes` is the full set the caller wants published. Persist-path"
- `packages/remnic-core/src/orchestration/recall-recognition-index.ts:162` — "bootstraps from the active corpus when the file is absent so a"
- `packages/remnic-core/src/orchestration/recall-recognition-index.ts:163` — "first post-enable write cannot mint a 1-id index that recall would"
- `packages/remnic-core/src/orchestration/recall-recognition-index.ts:164` — "treat as authoritative."
- `packages/remnic-core/src/orchestration/recall-result-formatter-display-safe.test.ts:39` — "// Anchor not among the included memories → truthful storage-relative segment, never a decode."
- `packages/remnic-core/src/orchestration/recall-result-formatter-display-safe.test.ts:45` — "// The input snapshot must not be mutated — the live cache keeps absolute paths."
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:46` — "Issue #2183 — render the persisted `sourceConnector` carried on the result (hydrated where the memory is loaded) as `[ag"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:91` — "Render an internal (possibly absolute) result path as a memoryDir-relative path for display in prompts/citations, so ope"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:106` — "// memoryDir/namespaces/<token>/<rel> -> "<namespace>/<rel>", the exact"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:107` — "// form the citation resolver decodes back to the owning namespace."
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:117` — "Return a display-safe copy of a recall snapshot for the `includeDebug=true` surface (#2077). `includedMemories[].path` i"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:219` — "// Historical-prefix contract (issue #1952): only a labeled superseded"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:220` — "// row gets `[superseded <date> by <id>]`; every other row — and every"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:221` — "// render with the feature off — stays byte-identical."
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:243` — "// Preference age note (issue #2371). Set only when"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:244` — "// `driftDetection.annotateAfterDays` is on, so this suffix is absent —"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:245` — "// and the rendered line byte-identical to pre-#2371 — by default."
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:358` — "// #1955 review: node title/summary copy active source-memory content;"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:359` — "// harmonic nodes carry no per-node origin yet, so fence as unknown"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:360` — "// (least privilege) when origin authority is on (plumbing: #2397)."
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:361` — "// Flag-off keeps the original two-slot shape byte-identical."
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:412` — "// Archived conversation turns carry no origin: least-privilege"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:413` — "// fencing applies when origin authority is enabled (issue #2331)."
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:491` — "// #1955 review: the rule body derives from a source memory whose"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:492` — "// origin is not copied onto the rule — fence via the rule's own"
- `packages/remnic-core/src/orchestration/recall-result-formatter.ts:493` — "// frontmatter origin (missing → unknown, least privilege) when on."
- `packages/remnic-core/src/orchestration/recall-search-pipeline.ts:1307` — "// Derive persisted provenance exclusively from hydrated frontmatter."
- `packages/remnic-core/src/orchestration/recall-search-pipeline.ts:1308` — "// The formatter parses this value at the model-context render site."
