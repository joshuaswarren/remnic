---
name: remnic-fs-boundary-checks
description: "Scan/write roots must reject symlinks (lstatSync, not statSync) and path containment must not use string prefixes"
condition:
  - 'statSync\([^)]{0,120}\)\s*\.isDirectory\(\)'
  - '\.startsWith\(\s*path\.join\('
globs:
  - "**/*.ts"
  - "**/*.mts"
interruptMode: never
---

Advisory: this code performs a filesystem safety check with a known
weak form. Two recurring review findings (8+ findings across PRs #1938,
#1999, #2000; #1612):

1. `statSync(p).isDirectory()` FOLLOWS symlinks, so it accepts a
   symlinked root. The repo rule is to REJECT symlinked scan/write
   roots (memory dirs, discovery roots, recording paths, profile
   components): use `lstatSync(p)`, reject when `.isSymbolicLink()`,
   then check `.isDirectory()`. `statSync` is fine when following the
   link is intended — e.g. reading a file the user pointed at.

2. `child.startsWith(path.join(root, "sub"))` is not containment: a
   sibling like `<root>/sub-evil` passes the prefix check. Use
   `const rel = path.relative(base, child)` and require
   `rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)`,
   or append `path.sep` to the prefix before comparing.
