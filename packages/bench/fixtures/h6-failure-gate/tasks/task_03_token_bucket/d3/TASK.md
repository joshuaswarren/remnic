# Task: Token Bucket Rate Limiter

## Objective
Implement rate limiting logic in TokenBucket to handle capacity replenishment correctly.

## Available Strategies
1. **candidate_alpha**: Calculate elapsed time since last refill and add accrued tokens capped at capacity.
2. **candidate_beta**: Always reset token count to full capacity on every consume call.

## Instructions
Review the implementation under `src/` and select or apply the appropriate candidate modification.
