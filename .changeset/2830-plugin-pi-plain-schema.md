---
"@remnic/plugin-pi": patch
---

Drop the `@sinclair/typebox` dependency from plugin-pi. Pi validates tool parameters as plain JSON Schema, so `toPiToolParametersSchema` now passes the stripped MCP input schema through unwrapped (typed `PiToolParametersSchema`, no TypeBox `Kind` marker); runtime validation and the stripped fields are unchanged. The packed bundle no longer carries the bare `@sinclair/typebox` specifier that omp's extension loader could not resolve, so the omp known-issue examples now reference the remaining `@remnic/core` bare specifiers. Fixes #2830.
