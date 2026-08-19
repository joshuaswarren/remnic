---
"@remnic/core": patch
"@remnic/cli": patch
---

Harden the OKF export publish path: `--namespace` resolves through the shared containment guard instead of a raw path join, each forced publish uses its own backup directory, a non-directory `--out` is refused with a clear message, and staging happens beside `--out` so the publish rename is never cross-device. Part of #2548.
