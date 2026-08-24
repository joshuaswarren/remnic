---
"@remnic/bench": patch
"@remnic/cli": patch
---

H5 injection-suite openai-compat executor attaches a host-matched Bearer token only (NVIDIA_API_KEY, OPENAI_API_KEY, or REMNIC_OPENAI_COMPAT_API_KEY), requires https except loopback HTTP, and fails closed rather than reusing an ambient key on the wrong host (#1962).
