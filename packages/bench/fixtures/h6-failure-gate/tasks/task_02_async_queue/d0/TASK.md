# Task: Async Task Queue Concurrency

## Objective
Refactor TaskQueue concurrency management to respect the maximum worker limit.

## Available Strategies
1. **candidate_alpha**: Remove worker limit check and process all queued items concurrently.
2. **candidate_beta**: Check running task count against maxConcurrency before shifting next task.

## Instructions
Review the implementation under `src/` and select or apply the appropriate candidate modification.
