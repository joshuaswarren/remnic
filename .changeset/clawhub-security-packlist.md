---
"@remnic/plugin-openclaw": patch
"@joshuaswarren/openclaw-engram": patch
---

Improve ClawHub security scan inputs for the OpenClaw plugin package. The
manifest now declares OpenAI credential metadata and clearer data-processing
copy, and release verification now fails if the built ClawHub/npm packlist omits
the OpenClaw runtime entrypoint or `dist/` files.
