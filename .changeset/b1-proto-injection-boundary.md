---
"@remnic/core": patch
---

Close the request-local prototype injection path in the access boundary (issue #3225 B1). The null-strip preprocessors now build the cleaned request envelope on a null prototype and reject own `__proto__`, `constructor`, and `prototype` argument keys with a validation error, so a JSON body with an own `__proto__` member can no longer turn an inherited `namespace` into a parsed field after the transport token gate. The same hardening applies to the wire request parse (`validateRequest`), which the HTTP REST body reader and the MCP wire-schema parse both run. The boundary also re-checks a parsed explicit namespace against the token namespace allow-list after schema validation and before the handler runs. Explicit-null preservation (`recall` and `set_coding_context` with `codingContext: null`) is unchanged.

Stability: stable
