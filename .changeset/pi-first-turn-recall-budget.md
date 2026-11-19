"@remnic/plugin-pi": patch
---

Stability: stable

Bound the first-turn recall wait so a slow daemon no longer blocks the first agent turn (#3273). `before_agent_start` now waits at most `firstTurnRecallBudgetMs` (default 1000ms) for semantic recall; a recall that misses the budget keeps running in the background and its context is injected from the next turn. A fast daemon still lands context on turn one.
