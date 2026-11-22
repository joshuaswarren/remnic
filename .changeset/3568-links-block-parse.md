---
"@remnic/core": patch
Stability: stable
---

Fix memory-file parsing so `links:` items survive any valid field order. The raw-text scan required `targetId`/`linkType`/`strength` in the writer's exact order, so a reordered item silently lost every link on read. Items now parse their fields order-free, and a corrupt item drops alone. Closes #3568.
