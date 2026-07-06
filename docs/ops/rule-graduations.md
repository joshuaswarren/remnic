# Rule Graduation Ledger

CLAUDE.md prose rules are graduated into machine checks (lint rules, ratchets,
boundary tests, fitness tests) so the doc converges back to architecture
description. Once a rule graduates, it is **deleted from CLAUDE.md** — the
check is the new source of truth, and this ledger preserves the mapping so the
history is not lost.

Graduation criteria (per #1528): a prose rule graduates only when a machine
check makes the mistake impossible-or-loud. Rules that encode judgment
("don't destroy old state before new state is confirmed") stay as prose.

| Rule # | Original rule text | Check location | Graduated in |
|--------|--------------------|----------------|--------------|
| 31 | **Core package files must never have host-specific prefixes** — generic modules in `@remnic/core` must use generic names (e.g. `recall-audit.ts`, not `openclaw-recall-audit.ts`); host adapters wrap core, not the other way around. | `scripts/check-review-patterns.sh` check #15 — `find packages/remnic-core/src -maxdepth 1 -type f \( -name "openclaw-*" -o -name "hermes-*" -o -name "codex-*" \)` is **BLOCKING** (`fail`, exits 1). Scoped to top-level generic modules; legitimate host adapters in `memory-extension/`, `connectors/`, `adapters/` are excluded. | #1638 |
| 26 | **Import via package name, not relative cross-package paths** — `import { X } from "@remnic/core"` not `import { X } from "../../../remnic-core/src/foo.js"`. Directory renames silently break relative imports with no package-dependency signal. | `scripts/check-review-patterns.sh` check #36 — `grep -rnE 'from .*\.\..*remnic-(core|cli)/src'` is **BLOCKING** (`fail`, exits 1). Zero current violations. Scoped to `.ts` files in `packages/`, excluding tests and node_modules. | #TBD |
| 27 | **Guard `slice(-n)` against `n === 0`** — `entries.slice(-0)` equals `slice(0)` and returns ALL entries. Always check `if (n <= 0)` before negating for slice. The `-0 === 0` footgun is a JavaScript-specific trap. | `scripts/check-review-patterns.sh` check #35 — `grep -rnE '\.slice\(-[a-zA-Z_]'` is **WARN-level** (19 existing call sites use computed offsets, many guarded by `Math.max(1,...)` above). New code should add a guard or justify safety. Scoped to `.ts` files in `packages/remnic-core/src/` and `packages/remnic-cli/src/`, excluding tests and comments. | #TBD |
