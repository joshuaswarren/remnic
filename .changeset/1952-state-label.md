---
"@remnic/core": patch
---

Add a pure state-view labeler. Current stays current. Historical and transition keep their kind only when both supersession fields are set. Missing either field is current. Unknown kind throws. Part of #1952.
