---
name: remnic-no-real-home-paths
description: "Never commit a real user home directory path; this is a public repo — use ~, $HOME, os.homedir(), tmpdir, or a generic persona"
condition:
  - '/(home|Users)/(?!(user|users|alice|bob|carol|dave|app|dev|test|tester|testuser|example|runner|ci|demo|sample|foo|bar|you|yourname|username|me|jdoe|somebody|placeholder|nobody|admin|guest)[/"''\\])[a-z][a-z0-9._-]{5,}/'
---

The text you are writing contains what looks like a real user's home
directory path (`/home/<name>/` or `/Users/<name>/`). This repository is
PUBLIC: committing an operator's actual filesystem path leaks personal
information and machine-specific state (reviewers flagged committed
`/home/<operator>/` paths in benchmark artifacts and test fixtures in
PRs #1754 and #1862). Machine-specific absolute paths also break on
every other checkout and in CI.

Use instead:

- runtime resolution: `os.homedir()`, `expandTildePath("~/...")` from
  `@remnic/core`, `os.tmpdir()`, or `mkdtemp` for test scratch dirs
- test fixtures: a generic persona path such as `/home/user/...` or
  `/home/alice/...` (these do not trigger this rule)
- docs/artifacts: `~` or `$HOME` placeholders; strip or rewrite absolute
  paths before committing generated JSON artifacts

If this fired on a genuinely generic name, prefer one of the persona
names above rather than suppressing the rule.
