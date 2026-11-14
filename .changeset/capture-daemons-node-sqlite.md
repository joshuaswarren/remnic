---
"@remnic/capture-audio": patch
"@remnic/capture-screen": patch
---

Keep the `node:` prefix on `node:sqlite` in the built daemons. tsup removed it by default, so the published `remnic-capture-audio` and `remnic-capture-screen` failed at start with `ERR_MODULE_NOT_FOUND: Cannot find package 'sqlite'`. Both packages now build with `removeNodeProtocol: false`, and a test builds each package and checks the bundle.
