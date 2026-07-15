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
  --observed-remaining-credits <credits>
      Exact remaining balance displayed for the original budget/grant.
  --affected-run-id <id>
      Blocked benchmark run associated with the unknown event; this is audit context,
      not attribution of the account-wide delta to that run.
  --confirm-original-budget-balance
      Confirm the displayed balance belongs to the original budget recorded in the ledger.
  --confirm-no-credit-additions-or-refunds
      Confirm no credits were added or refunded after that budget was established.
  --acknowledge-account-wide-unattributed-charge
      Accept that every unexplained account credit, including other Codex activity, is
      charged conservatively as account-wide unattributed spend.

Other options:
  -h, --help
      Print this help without reading or changing a ledger.

After reconciliation, stop every other Codex session before starting the benchmark.
Later shared-account activity is invisible to the harness ledger.
`;

export interface ReconcileCodexCreditLedgerCliOptions {
  ledgerPath: string;
  priorLedgerSha256: string;
  observedRemainingCredits: number;
  affectedRunId: string;
  originalBudgetBalanceConfirmed: true;
  noCreditsAddedOrRefundedConfirmed: true;
  accountWideUnattributedChargeAccepted: true;
}

export function parseReconcileCodexCreditLedgerArgs(args: string[]): ReconcileCodexCreditLedgerCliOptions {
  const values = new Map<string, string>();
  const confirmations = new Set<string>();
  const confirmationFlags = new Set([
    "--confirm-original-budget-balance",
    "--confirm-no-credit-additions-or-refunds",
    "--acknowledge-account-wide-unattributed-charge",
  ]);
  const valueFlags = new Set([
    "--ledger",
    "--prior-ledger-sha256",
    "--observed-remaining-credits",
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
  const observedRemainingCredits = Number(requireFlag(values, "--observed-remaining-credits"));
  const affectedRunId = requireFlag(values, "--affected-run-id");
  if (!confirmations.has("--confirm-original-budget-balance")) {
    throw new Error(
      "--confirm-original-budget-balance is required and confirms the observed balance belongs to the original budget recorded in this ledger"
    );
  }
  if (!confirmations.has("--confirm-no-credit-additions-or-refunds")) {
    throw new Error(
      "--confirm-no-credit-additions-or-refunds is required and confirms no credits were added or refunded after the original budget was established"
    );
  }
  if (!confirmations.has("--acknowledge-account-wide-unattributed-charge")) {
    throw new Error(
      "--acknowledge-account-wide-unattributed-charge is required; all unexplained account activity, including activity outside the affected benchmark call, will be charged conservatively as unattributed spend"
    );
  }

  return {
    ledgerPath,
    priorLedgerSha256,
    observedRemainingCredits,
    affectedRunId,
    originalBudgetBalanceConfirmed: true,
    noCreditsAddedOrRefundedConfirmed: true,
    accountWideUnattributedChargeAccepted: true,
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
