# Project stream rules (omp TTSRs)

These are project-scoped Time Traveling Stream Rules for the
[Oh My Pi](https://github.com/can1357/oh-my-pi) coding harness. When an
AI agent working in this repo streams code that matches a rule's
`condition` (regex) or `astCondition` (ast-grep pattern), the harness
interrupts (or, for `interruptMode: never` rules, attaches a reminder to
the tool result) and injects the rule body so the problem is fixed
before it ever reaches a PR.

Every rule here was derived from recurring AI code-review findings on
this repository (2+ weeks of Cursor Bugbot / Codex / kilo / CodeQL
review comments, 2,500+ findings analyzed) and cross-checked against
`AGENTS.md` review-prevention patterns. Other harnesses ignore this
directory; human contributors can read the rules as a distilled
"most-flagged mistakes" checklist.

Ground rules for adding or editing rules:

- **Low false positives beat coverage.** Before adding a `condition`,
  run it against the existing codebase; if it matches legitimate idioms,
  tighten it or make it advisory (`interruptMode: never`).
- **Hard-interrupt rules** are reserved for near-zero-FP signatures
  (boundary violations, privacy leaks, always-a-bug JS forms).
- **Advisory rules** nudge on medium-FP signatures where the agent must
  judge context.
- **No PII.** This repo is public: rule text must never contain real
  usernames, paths, keys, or memory content.
