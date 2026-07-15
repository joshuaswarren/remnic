# Codex credit ledger reconciliation

Use this procedure only when a bounded Codex CLI benchmark ledger is blocked
because a dispatched call ended without an exact `turn.completed` usage event.
Do not edit, delete, reset, or replace the ledger by hand.

Reconciliation is deliberately conservative. It compares the exact displayed
remaining balance for the original credit budget with the budget and exact
completed-call spend already recorded in the ledger. Every unexplained credit
is recorded as `account-wide-unattributed`. The affected run ID and blocked
event remain separate audit context. The procedure does not claim that the
timed-out call alone consumed the account-wide difference, and it never
fabricates model or token usage.

## Preconditions

Before running the command:

1. Confirm the displayed remaining balance belongs to the same original
   budget or grant recorded in the ledger. Use the exact displayed number; do
   not round it.
2. Confirm no credits have been added or refunded since that original budget
   was established. If credits were added or refunded, stop: the arithmetic
   cannot reconstruct an honest account-wide delta.
3. Capture the blocked ledger's SHA-256 before doing anything else. Keep the
   ledger unchanged between capturing this hash, observing the balance, and
   running reconciliation.
4. Identify the affected blocked run. This ID binds the private blocked event
   for audit; it does not assign the unattributed delta to that run.

For example:

```bash
LEDGER="$HOME/.remnic/bench/build-week-2026/codex-credit-ledger.json"
sha256sum "$LEDGER"
```

The ledger remains unchanged until the reconciliation command passes every
validation and completes its atomic write.

## Reconcile

Replace every angle-bracketed placeholder with the observed value:

```bash
pnpm exec tsx scripts/bench/reconcile-codex-credit-ledger.ts \
  --ledger "$HOME/.remnic/bench/build-week-2026/codex-credit-ledger.json" \
  --prior-ledger-sha256 <EXACT_BLOCKED_LEDGER_SHA256> \
  --observed-remaining-credits <EXACT_DISPLAYED_BALANCE> \
  --affected-run-id <BLOCKED_RUN_ID> \
  --confirm-original-budget-balance \
  --confirm-no-credit-additions-or-refunds \
  --acknowledge-account-wide-unattributed-charge
```

Inspect the command surface without reading or changing a ledger:

```bash
pnpm exec tsx scripts/bench/reconcile-codex-credit-ledger.ts --help
```

The command fails closed if the prior hash changed, the ledger is not blocked,
the balance is invalid, the observed spend is lower than already recorded
spend, any acknowledgment is absent, or the ledger lock is held. On success it
prints a sanitized receipt with the prior and new ledger hashes, the original
budget, prior exact spend, displayed balance, account-wide unattributed delta,
and a hash of the private affected event. It does not print the ledger path or
blocked reason.

## Start an exclusive benchmark window

After reconciliation and before dispatching another benchmark call, stop this
and every other Codex session that uses the same credit account. The account
must remain exclusive to the single benchmark harness process until that
benchmark window ends. Codex CLI has no machine-readable balance command, so
shared-account activity after the observed snapshot is invisible to the local
ledger and can invalidate its safety calculation.

Do not treat the acknowledgments used for historical reconciliation as proof
of later isolation. Reconciliation accounts for activity only through the
displayed balance snapshot.

## Private state and receipts

Keep both the ledger and benchmark result store private. The ledger file must
be mode `0600`, and its parent directories must be mode `0700`:

```bash
chmod 700 "$HOME/.remnic/bench" "$HOME/.remnic/bench/build-week-2026"
chmod 600 "$HOME/.remnic/bench/build-week-2026/codex-credit-ledger.json"
```

The private ledger preserves the blocked reason and affected run. Public
credit receipts expose only hashes and aggregate accounting. Account-wide
unattributed reconciliation credits appear in the cumulative receipt under
`unattributedReconciliationCount` and `unattributedReconciledCredits`; they are
excluded from every per-run receipt.
