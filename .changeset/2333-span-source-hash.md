---
"@remnic/core": patch
---

Add a span source stamp and verify helper. The stamp records the length and a sha256 over the string's UTF-16LE code units — not its UTF-8 bytes, because Node's UTF-8 encoder collapses unpaired surrogates to U+FFFD and would give distinct sources one digest. Verification compares length first, then the digest, and reports `length_mismatch` or `hash_mismatch` carrying only the two stamp fields, never the text. Malformed stamps throw before comparison. Source-internal like its sibling `extraction-span-*` modules; extraction wiring is unchanged. Part of #2333.
