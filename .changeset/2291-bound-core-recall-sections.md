---
"@remnic/core": patch
---

Bound the optional phase-one recall providers by the core section deadline. `entity-retrieval` and `verbatim-artifacts` scan the memory tree and could block the whole recall for minutes on a large or network/bind-mounted store; they now degrade to no section, are recorded as `timeout` in the section metrics, and receive a cancellation signal that also fires on caller abort (issue #2291).
