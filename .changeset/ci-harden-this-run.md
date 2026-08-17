---
"@remnic/core": patch
---

Harden parallel PR gates after the #2454/#2448/#2433/#2379/#2191 run: missing AI reviews and CodeQL 503s no longer block merge, targeted tests skip the bench DTS build, and squash-merge falls back to REST PUT.
