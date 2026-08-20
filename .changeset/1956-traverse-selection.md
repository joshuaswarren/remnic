---
"@remnic/core": patch
---

Add an internal pure selection helper for recall traverse (`selectTraverseNeighbors`): filter a recalled memory's typed frontmatter links by relation, skip unknown link types and blank or duplicate targets, sort deterministically, and cap with a validated limit. Not wired to any surface yet; wiring is a later slice. Part of #1956.
