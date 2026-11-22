# Redaction patterns are /.../-wrapped regexes, shape-inspected without execution, and plans keep their raw pattern on disk

Status: accepted

## Context
Correction plans may carry redaction rules whose patterns come from LLM output and user text. A hostile or careless pattern can be catastrophically backtracking (ReDoS), match unbounded strings, or leak sensitive content when the plan is persisted and audited. Storage sanitization rewrites injection-pattern bodies on write, which conflicts with needing the literal pattern back at apply time.

## Decision
Only `/.../`-wrapped patterns are treated as regex; everything else is a literal. Regex candidates are validated by SHAPE inspection only — never executed: reject patterns that could match an unbounded run of any character (overly broad) or exhibit catastrophic backtracking shapes (nested quantifiers like `(a+)+`, `(a*)*`, `(a?)+`, and overlapping alternation under repetition such as `(a|a)+`). The broadness heuristic and the ReDoS heuristic are independent checks. Persisted plans keep the real `redaction_rule.pattern` unredacted on disk (redacting it would register a placeholder pattern that validation rejects on re-load); the in-memory plan keeps the original text for auditing. The transient exposure is bounded by the pending-plan TTL plus consumed-on-apply lifecycle. Error messages sanitize absolute POSIX and Windows paths to `<path>` by capturing the leading delimiter, so paths beginning with a dot component are also covered.

## Consequences
A genuinely dangerous-but-shape-clean regex could still pass inspection. Redaction patterns are briefly readable in the pending-plan file, an accepted, time-bounded exposure. Path sanitization must keep capturing the delimiter or the placeholder is appended after the path again.

## Origin comments
- `packages/remnic-core/src/correction/correction-contract.ts:307` — "// Reject patterns that could match an unbounded string (overly-broad) OR"
- `packages/remnic-core/src/correction/correction-contract.ts:308` — "// exhibit catastrophic backtracking (nested quantifiers like `(a+)+`). We do"
- `packages/remnic-core/src/correction/correction-contract.ts:309` — "// NOT execute the regex (that would be ReDoS itself); we only inspect shape."
- `packages/remnic-core/src/correction/correction-contract.ts:336` — "/** Only `/.../`-wrapped patterns are treated as regex; everything else is a * literal (review thread P1 — con"
- `packages/remnic-core/src/correction/correction-contract.ts:342` — "/** * Reject a regex that would either match an arbitrary-length run of any * character (overly-broad) OR exhi"
- `packages/remnic-core/src/correction/correction-contract.ts:358` — "// Nested quantifier: a group (...) whose body ends with a quantifier and"
- `packages/remnic-core/src/correction/correction-contract.ts:359` — "// which is itself quantified → exponential blowup on near-miss inputs"
- `packages/remnic-core/src/correction/correction-contract.ts:360` — "// (classic ReDoS shapes: (a+)+, (a*)*, (a?)+). Also catches overlapping"
- `packages/remnic-core/src/correction/correction-contract.ts:361` — "// alternation under repetition: (a|a)+ where branches share a prefix."
- `packages/remnic-core/src/correction/correction-executor.test.ts:1580` — "// Paths starting with a dot component (/.config/remnic/token) — previously"
- `packages/remnic-core/src/correction/correction-executor.test.ts:1581` — "// leaked because the regex required the first path char to be [A-Za-z]."
- `packages/remnic-core/src/correction/correction-executor.ts:765` — "// Collapse any absolute POSIX path (~/..., /.config/..., /tmp/a@b/...) and"
- `packages/remnic-core/src/correction/correction-executor.ts:766` — "// Windows path (C:\Users\...) to a neutral <path> placeholder."
- `packages/remnic-core/src/correction/correction-executor.ts:767` — "// Capture the leading delimiter (start/space/quote) in group 1 so the path"
- `packages/remnic-core/src/correction/correction-executor.ts:768` — "// itself is consumed and replaced — the prior non-capturing prefix bound $1"
- `packages/remnic-core/src/correction/correction-executor.ts:769` — "// to the path, which survived and had <path> appended AFTER it."
- `packages/remnic-core/src/correction/correction-planner.test.ts:538` — "// The in-memory plan keeps the original text (the executor's audit body"
- `packages/remnic-core/src/correction/correction-planner.test.ts:539` — "// re-applies its own redaction)."
- `packages/remnic-core/src/correction/correction-planner.test.ts:551` — "// The redaction_rule.pattern is NOT redacted on disk: the executor's apply"
- `packages/remnic-core/src/correction/correction-planner.test.ts:552` — "// flow reloads via loadPlan and needs the real pattern to call"
- `packages/remnic-core/src/correction/correction-planner.test.ts:553` — "// registerRedactionRule. Redacting it would register a placeholder (#vZln)."
- `packages/remnic-core/src/correction/correction-planner.test.ts:554` — "// The pattern's transient exposure is bounded by the pending-plan TTL +"
- `packages/remnic-core/src/correction/correction-planner.test.ts:555` — "// consumed-on-apply lifecycle."
- `packages/remnic-core/src/correction/correction-planner.test.ts:657` — "// Read the raw file (loadPlan/parsePlan rejects the scrubbed pattern by"
- `packages/remnic-core/src/correction/correction-planner.test.ts:658` — "// design — validation rejects placeholder patterns on re-load)."
