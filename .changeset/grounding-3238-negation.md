---
"@remnic/core": patch
---

Quote-anchored grounding now checks negation and reporting polarity per claim clause. A compound quote with two negated clauses is no longer cleared by a single preserved negator elsewhere in the claim, so a restatement that keeps one denial and flips another is rejected. Single-clause claims behave as before. Part of #3238.

Stability: stable
