---
"@remnic/core": patch
---

Add a secure status route for recent recall times. Records arrive newest-first in a versionable envelope with generatedAt, processStartedAt, capacity, and count, and each record nests its phase timings under timingsMs. Phases that did not run are omitted; a zero means the phase ran and measured zero. The response is marked no-store. The route does not send probe traffic.
