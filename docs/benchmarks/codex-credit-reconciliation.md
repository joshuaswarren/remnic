# Codex credit ledger reconciliation

Use this procedure only when a bounded Codex CLI benchmark ledger is blocked
because a dispatched call ended without an exact `turn.completed` usage event.
Do not edit, delete, reset, or replace the ledger by hand.

The ledger has two deliberately separate measurements. Completed turns produce
local token-rate **budget units**, which enforce the 2,473-unit allocation,
473-unit reserve, and 2,000-unit planned-spend ceiling. Displayed Codex account
balances are account observations. They are compared only with each other and
are never subtracted from local budget units.

Account balances are preserved and subtracted as exact decimal strings. Local
budget units are conservative token-rate estimates calculated and accumulated
as integer nanounits. The JSON surface renders those exact nanounit totals as
numbers for compatibility, but enforcement converts them back to safe integer
nanounits before addition or comparison. These local estimates must never be
presented as exact account debits.

Reconciliation records the account-wide balance delta for a bracketed
observation window. It does not attribute that delta to the failed call and
does not fabricate model or token usage. An exact zero delta adds zero local
budget units. A positive delta adds the conservative 300-unit maximum call
charge and requires confirmation that no other Codex activity occurred in the
window. If 300 units do not remain below the planned-spend ceiling, the ledger
stays blocked.

## Preconditions

Before running the command:

1. Capture exact before and after displayed balances from the same Codex
   account. Preserve every displayed decimal digit; do not round.
2. Confirm the snapshots bracket the blocked event, the after value has
   settled, and no credits were added or refunded between them.
3. Capture the blocked ledger's SHA-256 and keep the ledger unchanged between
   capturing the hash and running reconciliation.
4. Identify the affected run ID. It binds the private blocked event for audit;
   it does not attribute an account-wide delta to that run.
5. If the balance decreased, confirm no other Codex activity occurred between
   snapshots. A zero delta does not require this confirmation: other activity
   may have occurred, but the only supported conclusion is the observed net
   zero account debit for the whole window.

```bash
LEDGER="$HOME/.remnic/bench/build-week-2026/codex-credit-ledger.json"
sha256sum "$LEDGER"
```

## Reconcile

```bash
pnpm exec tsx scripts/bench/reconcile-codex-credit-ledger.ts \
  --ledger "$HOME/.remnic/bench/build-week-2026/codex-credit-ledger.json" \
  --prior-ledger-sha256 <EXACT_BLOCKED_LEDGER_SHA256> \
  --before-account-balance <EXACT_BEFORE_BALANCE> \
  --after-account-balance <EXACT_AFTER_BALANCE> \
  --affected-run-id <BLOCKED_RUN_ID> \
  --confirm-same-account \
  --confirm-snapshots-bracket-event \
  --confirm-balance-settled \
  --confirm-no-credit-additions-or-refunds
```

For a positive balance decrease, also append:

```bash
  --confirm-no-intervening-codex-activity
```

Inspect the command surface without reading or changing a ledger:

```bash
pnpm exec tsx scripts/bench/reconcile-codex-credit-ledger.ts --help
```

The command fails closed if the prior hash changed, the ledger is not blocked,
either decimal is invalid, the balance increased, required confirmation is
absent, a positive debit lacks exclusivity, 300 local units do not remain, or
the ledger lock is held. The successful write is atomic and migrates a valid
schema-v1 ledger to schema v2 while preserving its completed usage and any
legacy conservative reconciliation charges. Schema-v2 resolution history also
binds every resolution to its prior ledger hash, prior recorded spend, and
explicit prior entry count, so wall-clock ties or clock movement cannot change
event ordering. A v1 migration preserves the exact private predecessor bytes
as an immutable witness and verifies their hash and accounting semantics on
every later read. Inconsistent or forged history is rejected.

The atomic rename is the accounting commit point. The command derives its
receipt hash from the exact bytes renamed into place, without a fallible
post-commit readback. Lock-state and lock-cleanup work after that point is
best-effort and cannot report the committed ledger mutation as failed.

The sanitized receipt contains ledger hashes, exact account observations, the
account-wide delta, local budget charge, and a hash of the private blocked
event. It does not print the ledger path or blocked reason.

## Continue safely

Reconciliation covers only the bracketed observation window. Before another
benchmark window, stop other Codex sessions using the same account. The CLI has
no machine-readable balance command, so later shared-account activity remains
invisible to the local ledger.

Keep the ledger and benchmark result store private. The ledger file must be
mode `0600`, and its parent directories must be mode `0700`:

```bash
chmod 700 "$HOME/.remnic/bench" "$HOME/.remnic/bench/build-week-2026"
chmod 600 "$HOME/.remnic/bench/build-week-2026/codex-credit-ledger.json"
```
