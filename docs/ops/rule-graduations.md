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
