---
"@remnic/core": patch
---

Add `npm run check:regex-safety` (wired into `preflight:quick`): flags changed `.ts`/`.mts` lines whose regex literals match the ReDoS shapes CodeQL repeatedly flagged — `[\s\S]*?`/lazy `.*?`, unbounded `[^>]*` with an alternation, `\s*` chains adjacent to captures, and nested quantifiers like `(a+)+` (issue #2439).
