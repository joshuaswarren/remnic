# Prompt-injection screening is deterministic, normalization-hardened, and the audit sweep screens with the deployment's live profile

Status: accepted

## Context

Memories can carry prompt-injection-shaped instructions. Detection must be deterministic (no model in the loop), must survive evasion via invisible characters and whitespace runs, must avoid false positives on ordinary technical vocabulary, and the periodic audit sweep must agree with what live ingestion would enforce rather than becoming stricter or looser than the configured write path.

## Decision

Screening is a deterministic write-path scoring pass. Rule weights express confidence that content carries executable instructions; weight 4 blocks a single high-confidence pattern, and profile-dependent rules (hardened vs default) resolve through the shared security capability plan.

Input is normalized before screening: non-ASCII space-like separators and invisible formatting characters are folded/collapsed, and a rule fires if it fires under EITHER reading of an invisible character, so neither placement evades the patterns. Whitespace runs are collapsed at entry because rule patterns bind inter-word whitespace for ReDoS safety.

False-positive guards: bare verbs only count when the target looks like a tool identifier; acronyms, crypto/encoding/spec vocabulary, and capitalized template-opening words are treated as ordinary tokens; a hyphenated Title-Case name is a field/header, not a directive.

A response-control finding requires a corroborating signal that is sentence-local — a corroborator must sit in the directive's own sentence. An opaque emission target (quoted multi-word payload, uppercase-initial token judged by shape) counts only in the same sentence as the directive verb.

Cheap structural early exit: if the whole memory carries no corroborator, skip detailed scanning.

The audit sweep must screen with the profile live ingestion uses (resolved through the shared capability plan), so a memory this deployment would quarantine on write never stays active once stored; deployments with screening disabled keep the previous `default` weighting — the sweep must not be stricter than the operator-configured write path.

Legacy memories without an explicit status ARE active (recall infers status), so the audit must include them; explicit non-active statuses bail. The --until cutoff is parsed strictly (calendar overflow and trailing junk fail closed) because a silently reinterpreted date changes what --quarantine may mutate. Burst detection groups by lineage AND creation day, and generic/absent provenance never forms an "unknown" group. Before quarantining, the live record is re-fetched because the snapshot from readAllMemories can be stale enough that intermediate writes would be lost.

## Consequences

Normalization and guard lists must be maintained as evasion and vocabulary evolve; over-aggressive profile resolution can retro-quarantine stored memories when an operator enables a stricter profile.

## Origin comments

- `packages/remnic-core/src/security/audit-memory-cli.test.ts:1` — "/** * The audit sweep must screen with the profile the deployment writes with * (issue #3078). A `quarantine`/`layere"
- `packages/remnic-core/src/security/audit-memory-cli.test.ts:77` — "// `layered` resolves the hardened profile: weight 4 for a conditional"
- `packages/remnic-core/src/security/audit-memory-cli.test.ts:78` — "// trigger alone, so the sweep retro-quarantines the memory."
- `packages/remnic-core/src/security/audit-memory-cli.test.ts:81` — "// `custom` resolves the default profile: weight 3, below the threshold,"
- `packages/remnic-core/src/security/audit-memory-cli.test.ts:82` — "// so the same memory stays active. This proves the profile is read from"
- `packages/remnic-core/src/security/audit-memory-cli.test.ts:83` — "// the configuration rather than hard-coded either way."
- `packages/remnic-core/src/security/audit-memory-cli.test.ts:86` — "// `off`/`fencing` disable live screening, so the sweep keeps the previous"
- `packages/remnic-core/src/security/audit-memory-cli.test.ts:87` — "// `default` weighting instead of becoming stricter than the write path."
- `packages/remnic-core/src/security/audit-memory-cli.ts:36` — "// Screen with the profile live ingestion uses, or a memory this"
- `packages/remnic-core/src/security/audit-memory-cli.ts:37` — "// deployment would quarantine on write stays active once stored"
- `packages/remnic-core/src/security/audit-memory-cli.ts:38` — "// (#3078). A deployment with the screen DISABLED keeps the previous"
- `packages/remnic-core/src/security/audit-memory-cli.ts:39` — "// `default` weighting: the sweep must not be stricter than the"
- `packages/remnic-core/src/security/audit-memory-cli.ts:40` — "// write path the operator configured."
- `packages/remnic-core/src/security/audit-memory.test.ts:139` — "// Legacy memory without an explicit status: recall treats it as active"
- `packages/remnic-core/src/security/audit-memory.test.ts:140` — "// (inferMemoryStatus), so the audit must report and quarantine it."
- `packages/remnic-core/src/security/audit-memory.test.ts:166` — "// The hardened profile keeps every rule at weight >= INJECTION_SCREEN_THRESHOLD,"
- `packages/remnic-core/src/security/audit-memory.test.ts:167` — "// so one finding is sufficient to quarantine; the default profile keeps"
- `packages/remnic-core/src/security/audit-memory.test.ts:168` — "// conditional triggers sub-threshold (#1962)."
- `packages/remnic-core/src/security/audit-memory.test.ts:277` — "// Calendar overflow (Feb 31) and trailing junk must fail closed — a"
- `packages/remnic-core/src/security/audit-memory.test.ts:278` — "// silently reinterpreted cutoff changes what --quarantine may mutate."
- `packages/remnic-core/src/security/audit-memory.ts:64` — "// #1955 review: legacy memories without an explicit status ARE active in"
- `packages/remnic-core/src/security/audit-memory.ts:65` — "// normal recall (inferMemoryStatus handles missing status), so the audit"
- `packages/remnic-core/src/security/audit-memory.ts:66` — "// must include them — otherwise injection-bearing legacy memories can"
- `packages/remnic-core/src/security/audit-memory.ts:67` — "// never be reported or quarantined. Explicit non-active statuses bail."
- `packages/remnic-core/src/security/audit-memory.ts:82` — "// Strict parse (rejects calendar overflow like 2026-02-31 and trailing"
- `packages/remnic-core/src/security/audit-memory.ts:83` — "// junk) — a silently reinterpreted date changes which memories"
- `packages/remnic-core/src/security/audit-memory.ts:84` — "// --quarantine may mutate (#1955 review)."
- `packages/remnic-core/src/security/audit-memory.ts:152` — "/** * Group by lineage AND creation day: a burst is many writes in a SHORT * interval, so a long-lived legitimate ses"
- `packages/remnic-core/src/security/audit-memory.ts:161` — "// Do not create an \"unknown\" group. Generic or absent provenance cannot"
- `packages/remnic-core/src/security/audit-memory.ts:162` — "// establish a write burst."
- `packages/remnic-core/src/security/audit-memory.ts:210` — "/** * The screen profile an audit sweep must use, resolved through the shared * security capability plan (#1523) rath"
- `packages/remnic-core/src/security/audit-memory.ts:284` — "// #1955 review: the stale snapshot from readAllMemories can be old enough"
- `packages/remnic-core/src/security/audit-memory.ts:285` — "// that intermediate gateway writes would be lost if rewritten blindly. Fetch"
- `packages/remnic-core/src/security/audit-memory.ts:286` — "// the live record first."
- `packages/remnic-core/src/security/injection-screen.test.ts:281` — "// Any non-ASCII space-like separator defeats the ASCII-bound patterns as a"
- `packages/remnic-core/src/security/injection-screen.test.ts:282` — "// SINGLETON, and invisible formatting characters defeat them in both"
- `packages/remnic-core/src/security/injection-screen.test.ts:283` — "// placements, so both are normalized before screening (PR #3094 r1)."
- `packages/remnic-core/src/security/injection-screen.test.ts:284` — "// The vertical members (VT, FF, U+0085, U+2028) are folded to a space on"
- `packages/remnic-core/src/security/injection-screen.test.ts:285` — "// purpose: only `\n` occurs in ordinary prose, so honoring them as"
- `packages/remnic-core/src/security/injection-screen.test.ts:286` — "// locality boundaries would be a one-character directive split (r2)."
- `packages/remnic-core/src/security/injection-screen.test.ts:293` — "// Invisible characters read as nothing inside a word and as a separator"
- `packages/remnic-core/src/security/injection-screen.test.ts:294` — "// between words; both readings are screened, so neither placement helps."
- `packages/remnic-core/src/security/injection-screen.test.ts:307` — "// Whitespace runs cannot split a directive from its corroborator: the"
- `packages/remnic-core/src/security/injection-screen.test.ts:308` — "// rule patterns bound inter-word whitespace for ReDoS safety, so runs are"
- `packages/remnic-core/src/security/injection-screen.test.ts:309` — "// collapsed at entry (PR #3082). Both the URL-locality form and the"
- `packages/remnic-core/src/security/injection-screen.test.ts:310` — "// in-directive gap form must catch at every run length."
- `packages/remnic-core/src/security/injection-screen.ts:1` — "Deterministic write-path screening for prompt-injection-shaped facts (#1955)"
- `packages/remnic-core/src/security/injection-screen.ts:21` — "Each score reflects the confidence that the candidate carries executable instructions"
- `packages/remnic-core/src/security/injection-screen.ts:40` — "Rules whose confidence depends on the screen profile (#1962)."
- `packages/remnic-core/src/security/injection-screen.ts:57` — "Weight 4 blocks one high-confidence instruction pattern"
- `packages/remnic-core/src/security/injection-screen.ts:106` — "Bare verbs only count when the target looks like a tool identifier"
- `packages/remnic-core/src/security/injection-screen.ts:179` — "Corroborating signals that separate an injected response control from ordinary prose"
- `packages/remnic-core/src/security/injection-screen.ts:194` — "Measured trade (PR #3079 r4): these are evaluated over the whole memory"
- `packages/remnic-core/src/security/injection-screen.ts:230` — "Acronyms that appear as ordinary content in technical memories"
- `packages/remnic-core/src/security/injection-screen.ts:240` — "Crypto, encoding, and spec vocabulary (trailing digits are stripped before this lookup)"
- `packages/remnic-core/src/security/injection-screen.ts:249` — "Capitalized words that open ordinary templates"
- `packages/remnic-core/src/security/injection-screen.ts:262` — "An opaque token the memory wants echoed verbatim, in the emission slot"
- `packages/remnic-core/src/security/injection-screen.ts:275` — "Sticky: anchored at lastIndex, so no per-match slicing."
- `packages/remnic-core/src/security/injection-screen.ts:278` — "Sentence split that never cuts inside a quoted span"
- `packages/remnic-core/src/security/injection-screen.ts:283` — "Scans the run with charCodeAt rather than slicing a suffix per candidate"
- `packages/remnic-core/src/security/injection-screen.ts:308` — "Token-jump scan: advance between quote and boundary characters"
- `packages/remnic-core/src/security/injection-screen.ts:328` — "Token-internal only applies to sentence punctuation"
- `packages/remnic-core/src/security/injection-screen.ts:334` — "Terminal URL punctuation binds the unit ONLY when a URL actually precedes it"
- `packages/remnic-core/src/security/injection-screen.ts:362` — "A hyphenated Title-Case name is a field or header"
- `packages/remnic-core/src/security/injection-screen.ts:373` — "An opaque token the memory wants echoed verbatim IN THE SAME SENTENCE"
- `packages/remnic-core/src/security/injection-screen.ts:382` — "The verb is matched case-insensitively, the marker case-sensitively"
- `packages/remnic-core/src/security/injection-screen.ts:385` — "Every verb occurrence is tried"
- `packages/remnic-core/src/security/injection-screen.ts:399` — "A quoted multi-word payload is opaque"
- `packages/remnic-core/src/security/injection-screen.ts:406` — "Uppercase-initial tokens are judged by shape"
- `packages/remnic-core/src/security/injection-screen.ts:424` — "A directive over what the agent's future answer must contain or say"
- `packages/remnic-core/src/security/injection-screen.ts:439` — "hardened is the profile an operator opts into for strict security"
- `packages/remnic-core/src/security/injection-screen.ts:445` — "Cheap structural exit: if the whole memory carries no corroborator"
- `packages/remnic-core/src/security/injection-screen.ts:454` — "Corroborators are sentence-local now that sentence splitting no longer breaks URLs"
- `packages/remnic-core/src/security/injection-screen.ts:459` — "Cue locality: a corroborator must sit in the directive's own sentence"
- `packages/remnic-core/src/security/injection-screen.ts:492` — "Normalize whitespace and invisible formatting before screening."
- `packages/remnic-core/src/security/injection-screen.ts:556` — "A rule fires if it fires under EITHER reading of the invisible characters"
