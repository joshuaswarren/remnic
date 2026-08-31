---
"@remnic/plugin-openclaw": patch
---

Stability: stable

Restore delegate-mode memory injection on OpenClaw 2.0. 2.0 removed `registerMemoryPromptSection`, and the delegate recall hook assumed the unified memory capability's `promptBuilder` would inject the cached recall lines. That builder is synchronous and is read during host prompt assembly, which never runs `before_prompt_build` first, so cached lines were never consumed and the hook's void return injected nothing. The pre-compute-then-consume contract now applies only to section-builder hosts (OpenClaw 1.x, behavior unchanged); everywhere else the hook returns `prependSystemContext` itself. Closes #3057.
