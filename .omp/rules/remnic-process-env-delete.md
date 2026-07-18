---
name: remnic-process-env-delete
description: "Assigning undefined to process.env stores the string \"undefined\"; use delete"
astCondition:
  - 'process.env.$NAME = undefined'
  - 'process.env[$NAME] = undefined'
globs:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
  - "**/*.js"
  - "**/*.mjs"
  - "**/*.cjs"
---

`process.env.X = undefined` does not unset the variable in Node — the
value is coerced to the literal string `"undefined"`, which is truthy
and passes `!== undefined` checks. Three different AI reviewers flagged
this in Remnic test teardown code (PR #1844).

Use `delete process.env.X` to remove the variable. In tests, capture the
prior value and restore it in teardown: `delete` when it was absent,
reassign when it was present.
