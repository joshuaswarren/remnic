---
"@remnic/core": patch
---

Add a pure journal stripper that removes Remnic-owned marker regions and configured owned heading sections before vault daily-note text is read, so published output cannot re-enter the journal. Unterminated regions fail closed and strip to the end of the section. Part of #1987.
