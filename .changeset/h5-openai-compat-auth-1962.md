---
"@remnic/bench": patch
"@remnic/cli": patch
---

H5 injection-suite openai-compat executor sends Authorization from OPENAI_API_KEY or NVIDIA_API_KEY (NVIDIA hosts prefer NVIDIA_API_KEY) and fails closed when neither is set (#1962).
