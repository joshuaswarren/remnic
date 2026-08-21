#!/usr/bin/env -S npx tsx
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { reconcileCodexCreditLedger } from "../../packages/bench/src/providers/codex-credit-budget.ts";

export const RECONCILE_CODEX_CREDIT_LEDGER_HELP = `Usage:
  pnpm exec tsx scripts/bench/reconcile-codex-credit-ledger.ts [options]

Required options:
  --ledger <path>
      Private Codex credit ledger to reconcile.
  --prior-ledger-sha256 <sha256>
      Exact SHA-256 captured from the blocked ledger before observing the balance.
  --before-account-balance <exact-decimal>
      Exact displayed account balance before the bracketed event window.
  --after-account-balance <exact-decimal>
      Exact displayed account balance after the bracketed event window settled.
  --affected-run-id <id>
      Blocked benchmark run associated with the unknown event; this is audit context,
      not attribution of the account-wide delta to that run.
  --confirm-same-account
      Confirm both balance snapshots belong to the same Codex account.
  --confirm-snapshots-bracket-event
      Confirm the two snapshots bracket the blocked event.
  --confirm-balance-settled
      Confirm the post-event balance display has settled.
  --confirm-no-credit-additions-or-refunds
      Confirm no credits were added or refunded between snapshots.

Conditionally required:
  --confirm-no-intervening-codex-activity
      Required when the account-wide balance decreased. A zero delta does not require
      this confirmation because intervening zero-debit activity does not change it.

Other options:
  -h, --help
      Print this help without reading or changing a ledger.

The account-balance delta is evidence for the whole bracketed observation window,
not attribution to the failed call. Local token-rate budget units remain separate.
`;

export interface ReconcileCodexCreditLedgerCliOptions {
  ledgerPath: string;
  priorLedgerSha256: string;
  beforeAccountBalance: string;
  afterAccountBalance: string;
  affectedRunId: string;
  sameAccountConfirmed: true;
  snapshotsBracketBlockedEventConfirmed: true;
  balanceSettledConfirmed: true;
  noCreditsAddedOrRefundedConfirmed: true;
  noInterveningCodexActivityConfirmed?: true;
}

export function parseReconcileCodexCreditLedgerArgs(args: string[]): ReconcileCodexCreditLedgerCliOptions {
  const values = new Map<string, string>();
  const confirmations = new Set<string>();
  const confirmationFlags = new Set([
    "--confirm-same-account",
    "--confirm-snapshots-bracket-event",
    "--confirm-balance-settled",
    "--confirm-no-credit-additions-or-refunds",
    "--confirm-no-intervening-codex-activity",
  ]);
  const valueFlags = new Set([
    "--ledger",
    "--prior-ledger-sha256",
    "--before-account-balance",
    "--after-account-balance",
    "--affected-run-id",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag) continue;
    if (confirmationFlags.has(flag)) {
      if (confirmations.has(flag)) throw new Error(`${flag} may only be supplied once`);
      confirmations.add(flag);
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`Unknown argument ${JSON.stringify(flag)}`);
    if (values.has(flag)) throw new Error(`${flag} may only be supplied once`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }

  const ledgerPath = requireFlag(values, "--ledger");
  const priorLedgerSha256 = requireFlag(values, "--prior-ledger-sha256");
  const beforeAccountBalance = requireFlag(values, "--before-account-balance");
  const afterAccountBalance = requireFlag(values, "--after-account-balance");
  const affectedRunId = requireFlag(values, "--affected-run-id");
  if (!confirmations.has("--confirm-same-account")) throw new Error("--confirm-same-account is required");
  if (!confirmations.has("--confirm-snapshots-bracket-event"))
    throw new Error("--confirm-snapshots-bracket-event is required");
  if (!confirmations.has("--confirm-balance-settled")) throw new Error("--confirm-balance-settled is required");
  if (!confirmations.has("--confirm-no-credit-additions-or-refunds")) {
    throw new Error(
      "--confirm-no-credit-additions-or-refunds is required and confirms no credits were added or refunded after the original budget was established"
    );
  }

  return {
    ledgerPath,
    priorLedgerSha256,
    beforeAccountBalance,
    afterAccountBalance,
    affectedRunId,
    sameAccountConfirmed: true,
    snapshotsBracketBlockedEventConfirmed: true,
    balanceSettledConfirmed: true,
    noCreditsAddedOrRefundedConfirmed: true,
    ...(confirmations.has("--confirm-no-intervening-codex-activity")
      ? { noInterveningCodexActivityConfirmed: true as const }
      : {}),
  };
}

export async function main(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(RECONCILE_CODEX_CREDIT_LEDGER_HELP);
    return 0;
  }
  const receipt = await reconcileCodexCreditLedger(parseReconcileCodexCreditLedgerArgs(args));
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return 0;
}

function requireFlag(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
