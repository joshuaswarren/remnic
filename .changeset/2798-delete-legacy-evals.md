---
"@remnic/cli": patch
---

Remove the legacy top-level evals directory and its CLI fallback runner. `remnic bench run` now requires `@remnic/bench` (built in the workspace, or installed) instead of falling back to the legacy eval runner, and benchmark datasets default to `~/.remnic/bench/datasets` in repo checkouts as well as packaged installs. The five published benchmarks the legacy tree duplicated (ama-bench, amemgym, locomo, longmemeval, memory-arena) remain fully covered by `@remnic/bench`, enforced by a new registry test.
