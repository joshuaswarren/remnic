---
"@remnic/server": patch
---

Standalone startup readiness warms the default namespace's real QMD collection through the same namespace routing a memory search uses — the legacy flat-root base collection for a flat default store, the suffixed namespaced collection once the default namespace migrates under `namespaces/`, and the backend default when namespaces are disabled — instead of passing the namespace name as a QMD collection and warming a nonexistent target while the health endpoint reported ready. Empty corpora still warm on the first attempt; cancellation/degradation propagation into the degraded gate is unchanged. Closes #3253.

Stability: stable
