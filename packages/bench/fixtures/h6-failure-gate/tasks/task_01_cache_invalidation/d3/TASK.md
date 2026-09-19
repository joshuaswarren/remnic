# Task: Cache Expiration Invalidation

## Objective
Update the CacheManager module to ensure expired entries are purged during read operations.

## Available Strategies
1. **candidate_alpha**: Check expiration during read and delete key from store if expired.
2. **candidate_beta**: Extend TTL timer on access whenever entry is fetched.

## Instructions
Review the implementation under `src/` and select or apply the appropriate candidate modification.
