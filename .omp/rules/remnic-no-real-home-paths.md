---
name: remnic-no-real-home-paths
description: "Never commit a real user home directory path; this is a public repo — use ~, $HOME, os.homedir(), tmpdir, or a generic persona"
condition:
  - '/(home|Users)/(?!(user|users|alex|alice|bob|carol|dave|app|dev|op|person|private|someone|test|tester|testuser|example|runner|ci|demo|sample|foo|bar|you|yourname|username|me|jdoe|janedoe|johndoe|somebody|placeholder|nobody|admin|guest|qa|node|root|ubuntu|debian|fedora|alpine|coder|vscode|devcontainer|pptruser|jovyan|appuser|deploy|worker|www-data|git|docker|github|actions)[/"''\\])[a-z][a-z0-9._-]+/'
  - '/(home|Users)/(?!(User|Users|Alice|Bob|Test|Example|Admin|Guest|Foo|Bar|Demo|Sample|Shared|Public|Default|JaneDoe|JohnDoe|Runner)[/"''\\])[A-Z][A-Za-z0-9._-]+/'
  - '(?i)[a-z]:[\\/]{1,2}users[\\/]{1,2}(?!(user|users|alex|alice|bob|carol|dave|app|dev|op|person|private|someone|somebody|test|tester|testuser|example|runner|ci|demo|sample|foo|bar|you|yourname|username|me|jdoe|janedoe|johndoe|placeholder|nobody|admin|administrator|guest|qa|public|default|defaultuser|all)[\\/"''])[a-z][a-z0-9._-]+[\\/]'
---

The text you are writing contains what looks like a real user's home
directory path (`/home/<name>/`, `/Users/<name>/`, or Windows
`C:\Users\<name>\`). This repository is PUBLIC: committing an
operator's actual filesystem path leaks personal
information and machine-specific state (reviewers flagged committed
`/home/<operator>/` paths in benchmark artifacts and test fixtures in
PRs #1754 and #1862). Machine-specific absolute paths also break on
every other checkout and in CI.

Use instead:

- runtime resolution: `os.homedir()`, `expandTildePath("~/...")` from
  `@remnic/core`, `os.tmpdir()`, or `mkdtemp` for test scratch dirs
- test fixtures: a generic persona path such as `/home/user/...`,
  `/home/alice/...`, or `/Users/JaneDoe/...` (these do not trigger this
  rule)
- docs/artifacts: `~` or `$HOME` placeholders; strip or rewrite absolute
  paths before committing generated JSON artifacts

Lowercase `/users/<handle>/` URL paths (GitHub links) are intentionally
not matched — only the case-sensitive `/home/` and `/Users/` filesystem
forms are. If this fired on a genuinely generic name, prefer one of the
persona names above rather than suppressing the rule.
