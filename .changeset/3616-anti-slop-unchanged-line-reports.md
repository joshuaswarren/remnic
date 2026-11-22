---
"@remnic/core": patch
Stability: stable
---

No runtime change: the anti-slop gate now compares findings against a baseline of the base revision, so a change that introduces a finding reported on an unchanged line is caught, and the test cleanup in `access-cli.test.ts` retries directory removal instead of failing on a late write. Refs #3616.
