---
"@remnic/bench": patch
"@remnic/cli": patch
---

H5 injection-suite openai-compat executor attaches a Bearer token only on exact API hosts (NVIDIA_API_KEY on integrate.api.nvidia.com, OPENAI_API_KEY on api.openai.com) or REMNIC_OPENAI_COMPAT_API_KEY elsewhere — including other *.openai.com / *.nvidia.com subdomains — requires https except loopback HTTP, and fails closed rather than reusing an ambient key on the wrong host (#1962).
