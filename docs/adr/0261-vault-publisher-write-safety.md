# Vault publisher writes are refusal-first: any ambiguity in note structure, markers, or paths refuses instead of guessing

Status: accepted

## Context
The vault publisher rewrites managed regions inside user-owned Markdown notes. The notes are human-edited: examples may imitate managed markers, indentation varies, headings parse ambiguously, symlinks and concurrent editor autosaves exist. A misclassification does not fail visibly — it silently overwrites content inside an example, a code block, or a stale copy of the note, and the loss is unrecoverable. Issue history (#1985, #2439, #2917) is a catalogue of exactly these silent-overwrite shapes.

## Decision
Never guess when scanning or writing a note; refuse. Specifically: (1) a scanner that trims or normalizes indentation before classifying marker lines is forbidden — classify the raw line, and treat CommonMark-ambiguous indentation (4+ spaces, tabs, list-nested markers) as code/uncertain, resolving the ambiguity toward skip, because a refused publish is recoverable and an overwritten region is not; (2) the scanner must track fenced-code state so headings and markers inside examples are never treated as live targets; (3) marker recognition uses bounded-whitespace regexes with the name captured up to the terminal :start/:end suffix (ReDoS-safe, no silently invisible markers), and blank or invalid marker names refuse rather than throwing from deeper code; (4) a configured region name that does not render back to itself as an ATX heading (e.g. a trailing # run) is rejected at the input boundary because it could never match at publish time; (5) every input validation — region names, property shapes/bounds, path containment, symlink checks — is total and runs before any note byte is read or written, so no rejection can leave a half-merged note; (6) symlinked vault roots and symlinked notes are refused outright, even when the link target lives inside the vault, because writeAtomic renames over the link itself; (7) path traversal is judged lexically — only `..` exactly or a `..`+separator prefix escapes; `..notes/x.md` is an in-vault name; (8) if the note changed on disk after it was read, keep the user's bytes and abort — never a silent overwrite, never `updated`; (9) a partial publish writes only the applied sections: a skipped section's properties must never reach the file and must be surfaced as its own `skipped` row; (10) parent directories are created only after every refusal has passed, beneath an already-verified contained ancestor; (11) the exported writer re-validates the same boundaries the entry point checked, so a direct caller cannot smuggle unbounded or newline-bearing values into a note.

## Consequences
Some legitimate layouts (marker-like content nested under list items) cannot be published and are refused; supporting them would require full list-context tracking. Publishers cost a full pre-validation pass before any I/O. Legitimately symlinked notes need real files. The ambiguity always resolving to skip means a refused publish must be retried by the operator after fixing the note — automation cannot force it through.

## Origin comments
### vault-region-scan-correctness
- `packages/remnic-core/src/activity/vault-publisher.test.ts:637` — "// region. A scanner that trims a row before classifying it erases the"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:638` — "// indentation, pairs the example's markers first, and replaces the"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:639` — "// example's contents while reporting a successful publish (issue #1985)."
- `packages/remnic-core/src/activity/vault-publisher.test.ts:680` — "// One tab is a full four-column indent (CommonMark tab handling), so the"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:681` — "// tab-indented example is code exactly like the four-space variant."
- `packages/remnic-core/src/activity/vault-publisher.test.ts:716` — "// CommonMark measures indentation relative to the containing block, so a"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:717` — "// marker indented under a list item CAN be live content rather than code."
- `packages/remnic-core/src/activity/vault-publisher.test.ts:718` — "// Distinguishing that needs full list tracking; this fix classifies any"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:719` — "// indent >= 4 as code instead. The ambiguity resolves to "skip": a refused"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:720` — "// publish is recoverable, an overwritten region is not."
- `packages/remnic-core/src/activity/vault-publisher.test.ts:746` — "// The only `## Timeline` heading lives inside a fenced example. An"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:747` — "// insertion scanner without fence state treats it as the target and"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:748` — "// writes a live managed region into the user's code block."

### vault-concurrent-write-refusal
- `packages/remnic-core/src/activity/vault-publisher.test.ts:868` — "// The concurrent edit survives byte-for-byte — including the stale"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:869` — "// managed region: refusal keeps the user's bytes, it does not merge."
- `packages/remnic-core/src/activity/vault-publisher.ts:296` — "// The note changed after it was read (editor autosave): keep the user's"
- `packages/remnic-core/src/activity/vault-publisher.ts:297` — "// bytes and surface the abort — never a silent overwrite, never `updated`."

### vault-input-boundaries-before-io
- `packages/remnic-core/src/activity/vault-publisher.test.ts:883` — "// ── Input-boundary regressions (issue #2917) ────────────────────────────"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:884` — "// Every rejection below must fire before any file byte is read or written."
- `packages/remnic-core/src/activity/vault-publisher.ts:106` — "// Issue #2917: input boundaries are total and run BEFORE any note byte"
- `packages/remnic-core/src/activity/vault-publisher.ts:107` — "// is read or written, so a rejection can never leave a half-merged"
- `packages/remnic-core/src/activity/vault-publisher.ts:108` — "// note behind."
- `packages/remnic-core/src/activity/vault-publisher.ts:129` — "// Property values land in note frontmatter or inline fields; validate"
- `packages/remnic-core/src/activity/vault-publisher.ts:130` — "// their shape and bounds (vault-frontmatter.ts) against the final"
- `packages/remnic-core/src/activity/vault-publisher.ts:131` — "// prefixed keys, in every mode, before any file access."
- `packages/remnic-core/src/activity/vault-publisher.ts:282` — "// A brand-new note may live in absent folders (Daily/{yyyy}/{MM}). Make"
- `packages/remnic-core/src/activity/vault-publisher.ts:283` — "// the parent chain only here, after every refusal above has passed: the"
- `packages/remnic-core/src/activity/vault-publisher.ts:284` — "// lexical path check and `containedBySymlinks` already proved the deepest"
- `packages/remnic-core/src/activity/vault-publisher.ts:285` — "// existing ancestor is a real directory inside the vault, so every segment"
- `packages/remnic-core/src/activity/vault-publisher.ts:286` — "// `mkdirSync` adds lands beneath that contained ancestor."
- `packages/remnic-core/src/activity/vault-publisher.ts:460` — "// The writer re-validates the same boundary the publisher entry checked"
- `packages/remnic-core/src/activity/vault-publisher.ts:461` — "// (issue #2917): this function is exported, so a direct caller must not"
- `packages/remnic-core/src/activity/vault-publisher.ts:462` — "// be able to smuggle a newline-bearing or unbounded value into a note."

### vault-heading-name-validation
- `packages/remnic-core/src/activity/vault-publisher.test.ts:905` — "// `## Timeline #` parses back as `Timeline` (closing hash sequence), so"
- `packages/remnic-core/src/activity/vault-publisher.test.ts:906` — "// the region could never be matched on any publish."
- `packages/remnic-core/src/activity/vault-publisher.ts:110` — "// The heading strategy matches a section by scanning note headings with"
- `packages/remnic-core/src/activity/vault-publisher.ts:111` — "// the shared ATX parser (`applyHeadingRegion`/`insertMarkersUnderHeading`)."
- `packages/remnic-core/src/activity/vault-publisher.ts:112` — "// A name whose rendered heading parses back to something else — a"
- `packages/remnic-core/src/activity/vault-publisher.ts:113` — "// trailing `#` run is stripped as a closing sequence (`## Timeline #`"
- `packages/remnic-core/src/activity/vault-publisher.ts:114` — "// reads as `Timeline`) — can never be matched, so every publish would"
- `packages/remnic-core/src/activity/vault-publisher.ts:115` — "// no-op or mis-scope. Reject it here rather than at match time."

### vault-marker-regex-shape
- `packages/remnic-core/src/activity/vault-publisher.ts:71` — "// Bounded whitespace runs: an unbounded `\s*` chain around a lazy capture is the"
- `packages/remnic-core/src/activity/vault-publisher.ts:72` — "// CodeQL js/polynomial-redos shape `check:regex-safety` rejects (issue #2439)."
- `packages/remnic-core/src/activity/vault-publisher.ts:73` — "// The name is captured up to the TERMINAL `:start`/`:end` suffix, so a marker"
- `packages/remnic-core/src/activity/vault-publisher.ts:74` — "// carrying a stray colon (`remnic:A:B:start`) is still seen by the scanner"
- `packages/remnic-core/src/activity/vault-publisher.ts:75` — "// instead of being silently invisible to it. `validateRegionName` rejects `:`"
- `packages/remnic-core/src/activity/vault-publisher.ts:76` — "// in a configured name, so such a marker can never be a legitimate pair and"
- `packages/remnic-core/src/activity/vault-publisher.ts:77` — "// always resolves to a refusal below."
- `packages/remnic-core/src/activity/vault-publisher.ts:412` — "// A blank marker name cannot be paired at all: refuse rather than let"
- `packages/remnic-core/src/activity/vault-publisher.ts:413` — "// assertBeginEndPair throw out of the publisher."

### vault-symlink-and-traversal-refusal
- `packages/remnic-core/src/activity/vault-publisher.ts:159` — "// A symlinked vault root is rejected outright (security checklist §3):"
- `packages/remnic-core/src/activity/vault-publisher.ts:160` — "// statSync follows links, lstatSync does not."
- `packages/remnic-core/src/activity/vault-publisher.ts:170` — "// `..notes/x.md` is an in-vault name, not parent traversal: only `..`"
- `packages/remnic-core/src/activity/vault-publisher.ts:171` — "// exactly or a `..${path.sep}` prefix escapes."
- `packages/remnic-core/src/activity/vault-publisher.ts:181` — "// A symlinked note is refused even when its target lives inside the"
- `packages/remnic-core/src/activity/vault-publisher.ts:182` — "// vault (issue #1985): writeAtomic renames over the link itself, which"
- `packages/remnic-core/src/activity/vault-publisher.ts:183` — "// would destroy the symlink and leave the target stale while the"
- `packages/remnic-core/src/activity/vault-publisher.ts:184` — "// status still says `updated`."

### vault-partial-publish-semantics
- `packages/remnic-core/src/activity/vault-publisher.ts:253` — "// Partial publish (issue #1985 review): when some sections applied and"
- `packages/remnic-core/src/activity/vault-publisher.ts:254` — "// others were skipped, the write covers ONLY the applied sections — their"
- `packages/remnic-core/src/activity/vault-publisher.ts:255` — "// frontmatter properties, and the reported status. A skipped section's"
- `packages/remnic-core/src/activity/vault-publisher.ts:256` — "// properties must never reach the file, and the omission must be surfaced"
- `packages/remnic-core/src/activity/vault-publisher.ts:257` — "// as its own `skipped` row rather than reported as a plain `updated`."

### vault-frontmatter-indent-key-matching
- `packages/remnic-core/src/activity/vault-publisher.ts:501` — "// Leading whitespace is exactly the signal that this is a nested,"
- `packages/remnic-core/src/activity/vault-publisher.ts:502` — "// user-owned child key (`custom:` / ` remnic_focus: old`). Only an"
- `packages/remnic-core/src/activity/vault-publisher.ts:503` — "// unindented top-level mapping may satisfy a pending update, so the"
- `packages/remnic-core/src/activity/vault-publisher.ts:504` — "// key is NOT trimmed before that decision."
