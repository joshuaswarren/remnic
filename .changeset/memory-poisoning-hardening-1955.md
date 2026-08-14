---
"@remnic/core": minor
---

Add memory-poisoning hardening with origin-bound write authority, an authority-stripping recall fence, deterministic injection screening with review quarantine, and the `remnic security audit-memory` forensic command. The `originAuthorityEnabled` flag defaults to `false`; `injectionScreenEnabled` defaults to `true`; and `untrustedOrigins` defaults to `tool_output`, `import:*`, and `unknown`.