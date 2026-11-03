---
"@remnic/core": patch
---

Stability: stable

Make the entity canonical-id migration's search-maintenance request survive a crash. A pending marker beside the migration journal is written before a pass rewrites references and cleared only after maintenance was requested, so a crash between the rewrite and the request no longer leaves the QMD index and projections on pre-rewrite entity ids: the next startup's no-op replay fires the request once. Ordinary no-op startups stay quiet. Refs #3139; fixes #3286.
