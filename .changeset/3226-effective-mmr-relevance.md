---
"@remnic/core": patch
---

Stability: stable

Keep the rerank stages' relevance through the MMR pass (issue #3226). The
Memory-Worth, TrustScore and preference-drift stages decide a recall order, but
the MMR pass re-derived relevance from the raw retrieval score and undid that
decision — a promoted memory fell back to its old rank and a demoted one
climbed back to the top. Each stage now carries its own relevance forward as
optional per-result metadata (`QmdSearchResult.effectiveScore`), and MMR
prefers that over the raw score. These rerank stages leave raw scores intact;
the existing reasoning-trace boost still adds to raw scores and now composes
into effective relevance too. A neutral stage leaves its results unchanged,
and annotation-only drift preserves the upstream effective relevance.

Normalize carried relevance before additive boosts. TrustScore recomputes
dense admitted ranks after quarantine and scales over the admitted scores,
so excluded rows cannot leave relevance holes. Active drift damping composes
with upstream effective relevance, retaining both neutral scores and gaps
instead of replacing them with fresh position scores.
