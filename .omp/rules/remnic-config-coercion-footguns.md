---
name: remnic-config-coercion-footguns
description: "Config values arrive as strings and 0 is often valid: use coerceBool/coerceNumber, never strict === true / Boolean() / parse-||-default"
condition:
  - '(cfg|config|rawConfig|raw|obj|options|opts)\.[A-Za-z0-9_]+\s*(===\s*true|!==\s*false)\b'
  - 'Boolean\(\s*(cfg|config|rawConfig|raw|obj|options|opts)\.'
  - '(parseInt|Number\.parseInt|parseFloat|Number)\([^;\n]{0,80}\)\s*\|\|\s*[0-9]'
globs:
  - "**/*.ts"
  - "**/*.mts"
interruptMode: never
---

Advisory: this looks like a config/CLI value being gated with a strict
or truthy check. Remnic config arrives from multiple hosts and from
`--config key=value` CLI strings, so values are often strings
(`"false"`, `"0"`, `"5555"`), and `0` is frequently a valid,
documented "disable" value. AI reviewers flagged this family in 6+ PRs
in two weeks (#1623, #1663, #1664, #1675, #1679, #1921; AGENTS.md
patterns 17, 24, 33):

- `cfg.flag === true` / `cfg.flag !== false` silently ignores the
  string forms `"true"`/`"false"` — use `coerceBool(...)`
  (`packages/remnic-core/src/connectors/coerce.ts`) or
  `coerceBooleanLike(...)` like the neighboring flags do.
- `Boolean(cfg.x)` turns the string `"false"` into `true`.
- `parseInt(x) || DEFAULT` / `Number(x) || DEFAULT` swallows a valid
  `0` and coerces `NaN` to the default without erroring — use
  `coerceNumber(...)` plus an explicit `Number.isInteger` range check,
  and honor `0` when the docs say 0 disables.

Ignore if the value provably cannot be a string (already normalized by
`parseConfig`) and `0`/falsy is genuinely invalid — but say so in the
validation error rather than silently defaulting.
