---
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Published packages now ship a minified openclaw.plugin.json: OpenClaw rejects plugin manifests at or above 256 KiB (MAX_PLUGIN_MANIFEST_BYTES) with "unsafe plugin manifest path (validation)", and the pretty-printed manifest crossed that cap, breaking every install on current hosts. A shared prepack/postpack script packs the compact form (with a 250,000-byte early-fail guard) while the committed manifest stays pretty-printed, and verify-openclaw-clawpack asserts the packed size stays under the host cap.
