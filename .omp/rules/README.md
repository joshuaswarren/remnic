# Project stream rules (omp TTSRs)

These are project-scoped Time Traveling Stream Rules for the
[Oh My Pi](https://github.com/can1357/oh-my-pi) coding harness. When an
AI agent working in this repo streams code that matches a rule's
`condition` (regex) or `astCondition` (ast-grep pattern), the harness
interrupts (or, for `interruptMode: never` rules, attaches a reminder to
the tool result) and injects the rule body so the problem is fixed
before it ever reaches a PR.

Every rule here was derived from recurring AI code-review findings on
this repository (four weeks of Cursor Bugbot / Codex / kilo / CodeQL
review comments, 2026-06-20 through 2026-07-18, 3,100+ bot findings
analyzed) and cross-checked against `AGENTS.md` review-prevention
patterns. Other harnesses ignore this directory; human contributors can
read the rules as a distilled "most-flagged mistakes" checklist.

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

## Evaluated and rejected candidates

These patterns recurred in review findings but FAILED the
false-positive bar against the actual tree. Do not re-propose them as
conditions without new evidence; each baseline below is the receipt.

- **`String(err)` / `err.message` in logs, throws, or response fields**
  — 462 occurrences of the standard
  `error instanceof Error ? error.message : String(error)`
  normalization idiom. Whether a message reaches an operator/client
  surface (the actual leak) is semantic; `access-http.ts` legitimately
  echoes input-validation messages. Reviewers keep catching the real
  cases; a rule cannot.
- **`coerce*(...) ?? <default>`** — this IS the config-parser idiom
  (`config.ts` uses `coerceBooleanLike(cfg.x) ?? <default>` for nearly
  every flag). The recurring bug — an explicitly-set-but-unrecognized
  value silently becoming the default, worst as fail-open `?? true` —
  is about which default and whether unrecognized input should warn,
  not about the syntax. Fix belongs in the coercion helpers, not a
  per-callsite rule.
- **Inline `NODE_OPTIONS=` / `VAR=value cmd` in npm scripts**
  (Windows-hostile) — 20 existing scripts use the
  `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--conditions=remnic-source"`
  convention for POSIX-only dev/test scripts.
- **`../packages/<pkg>/src/` imports** — 361 ratchet-managed
  occurrences (`directStorageImports`); see the note in
  `remnic-no-cross-package-src-imports.md`.

The dominant review clusters of 2026-06-20..07-04 (namespace/ACL
scoping, flush-plan lifecycle races, catalog-touch ordering) are
semantic, single-subsystem invariants with no textual signature —
that class is governed by the scenario-matrix workflow in `AGENTS.md`,
not by stream rules.
