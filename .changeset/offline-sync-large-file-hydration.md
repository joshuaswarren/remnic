---
"@remnic/core": patch
"@remnic/cli": patch
---

Add chunked large-file hydration for offline sync so append-heavy lifecycle state can sync without forcing multi-hundred-megabyte payloads through one JSON response.
