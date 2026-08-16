# Theory: Automatic Review-Gate Recovery

## Problem

GitHub has no pull request event for review-thread resolution.

The required `unresolved-review-threads` check can stay red after the last thread closes.

Manual workflow dispatch restores the check, but it delays merge readiness.

## Operating theory

The check-unsticker already owns stale required-check recovery.

A short schedule can detect this state without changing guard semantics.

Each sweep lists open pull requests and inspects the latest guard workflow run.

A green or active latest run requires no thread lookup and no rerun.

A failed latest run needs a GraphQL thread count.

The sweep reruns failed guard suites only when effective unresolved threads equal zero.

The guard keeps no concurrency group because every failed suite needs a rerun.

The scheduler owns one concurrency group and never force-cancels its own run.

## Strategy

Keep manual dispatch unchanged for immediate recovery.

Reuse the shared dedup evaluator for effective thread counts.

Keep stale-red selection in a small tested module.

Use the five-minute schedule as the automatic path.

## Failure boundaries

Open threads block reruns because the guard result would remain red.

A newer green run suppresses older failed-run reruns.

An active latest run suppresses older failed-run reruns.

Rerun failures are warnings, not sweep-wide failures.

## Verification state

Unit tests cover green, resolved-thread, open-thread, and active-run cases.

Workflow tests cover the schedule, scheduler concurrency, and latest-run gate.

The repository scheduling note documents automatic and manual paths.
