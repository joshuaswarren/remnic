---
"@remnic/core": patch
"@remnic/cli": patch
---

Stability: stable

Restore the `EngramAccessForbiddenError`, `EngramAccessInputError`, and
`NamespaceNotWritableError` exports that were inadvertently deleted from
`@remnic/core`'s `access-errors` module, and repair a syntax error in the
`@remnic/cli` entrypoint. Wire the teaching-rejection builders into the MCP
unknown-tool path, scoped to caller-visible tools. Sanitize the optional
benchmark scorecard in `remnic report` through an allow-list.
