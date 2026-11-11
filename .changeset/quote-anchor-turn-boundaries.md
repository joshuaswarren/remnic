---
"@remnic/core": patch
---

Quote anchors now use real turn boundaries. Extraction passes the turn texts the grounding source was joined from, so a quote that crosses a blank line inside one turn keeps its anchor and anchor windows stop at their turn's end instead of at any blank line. Without turn boundaries the previous blank-line behavior is unchanged, and a quote that spans two turns is still rejected.

Stability: stable
