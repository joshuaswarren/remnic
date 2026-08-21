---
"@remnic/core": patch
---

Encode five CI gates from the #2476/#2477/#2478/#2483/#2190 parallel run: hook source-grep tests must target remnic-hook-core.cjs, those tests run in the checks job, last_recall.json load must reject arrays and proto keys, and preflight runs both checks.
