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
