import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BenchmarkRunBlockReason, BenchmarkRunBlockedError } from "../benchmark-run-blocked-error.js";

export interface CodexCliNativeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface CodexCreditRate {
  input: number;
  cachedInput: number;
  output: number;
}

interface CodexCreditLedgerEntryV1 extends CodexCliNativeUsage {
  at: string;
  model: string;
  credits: number;
  runId?: string;
}

interface CodexCreditLedgerReconciliationV1 {
  at: string;
  basis: "operator-observed-original-budget-balance";
  attribution: "account-wide-unattributed";
  priorLedgerSha256: string;
  originalBudgetCredits: number;
  priorRecordedSpentCredits: number;
  observedRemainingCredits: number;
  credits: number;
  confirmations: {
    observedBalanceBelongsToOriginalBudget: true;
    noCreditsAddedOrRefunded: true;
    accountWideUnattributedChargeAccepted: true;
  };
  affectedBlockedEvent: {
    runId: string;
    blockedReason: string;
  };
}

interface CodexCreditLedgerV1 {
  schemaVersion: 1;
  budgetCredits: number;
  reserveCredits: number;
  spentCredits: number;
  entries: CodexCreditLedgerEntryV1[];
  reconciliations?: CodexCreditLedgerReconciliationV1[];
  blockedReason?: string;
}

interface CodexCreditLedgerEntry extends CodexCliNativeUsage {
  at: string;
  model: string;
  budgetUnits: number;
  runId?: string;
}

interface CodexCreditBlockedEvent {
  reason: string;
  at?: string;
  runId?: string;
  model?: string;
}

interface CodexCreditLedgerResolution {
  at: string;
  basis: "operator-observed-account-balance-delta";
  attribution: "account-wide-observation-window";
  priorLedgerSha256: string;
  priorRecordedSpentUnits: number;
  priorEntryCount: number;
  beforeAccountBalance: string;
  afterAccountBalance: string;
  observedAccountDebit: string;
  localBudgetChargeUnits: number;
  confirmations: {
    sameAccount: true;
    snapshotsBracketBlockedEvent: true;
    balanceSettled: true;
    noCreditsAddedOrRefunded: true;
    noInterveningCodexActivity?: true;
  };
  affectedRunId: string;
  affectedBlockedEvent: CodexCreditBlockedEvent;
}

interface CodexCreditLedger {
  schemaVersion: 2;
  budgetUnits: number;
  reserveUnits: number;
  spentUnits: number;
  entries: CodexCreditLedgerEntry[];
  resolutions?: CodexCreditLedgerResolution[];
  legacyReconciliations?: CodexCreditLedgerReconciliationV1[];
  migratedFromV1Sha256?: string;
  migrationWitnessV1?: { source: string };
  blockedEvent?: CodexCreditBlockedEvent;
}

type LedgerLockPhase = "preflight" | "in-flight" | "settled";

export interface CodexCreditBudgetConfig {
  budgetCredits: number;
  reserveCredits: number;
  ledgerPath: string;
  allowSol: boolean;
  runId?: string;
}

export interface CodexCreditReceiptScope extends CodexCliNativeUsage {
  calls: number;
  budgetUnits: number;
  accountBalanceResolutionCount: number;
  conservativeResolutionChargeUnits: number;
  models: Array<
    CodexCliNativeUsage & {
      model: string;
      calls: number;
      budgetUnits: number;
    }
  >;
}

export interface CodexCreditReconciliationReceipt {
  schemaVersion: 2;
  priorLedgerSha256: string;
  ledgerSha256: string;
  at: string;
  attribution: "account-wide-observation-window";
  affectedRunId: string;
  priorRecordedSpentUnits: number;
  beforeAccountBalance: string;
  afterAccountBalance: string;
  observedAccountDebit: string;
  localBudgetChargeUnits: number;
  totalSpentUnits: number;
  remainingPlannedSpendUnits: number;
  affectedBlockedEventSha256: string;
}

export interface CodexCreditReceipt {
  schemaVersion: 2;
  ledgerSha256: string;
  budgetUnits: number;
  reserveUnits: number;
  plannedSpendCeilingUnits: number;
  totalSpentUnits: number;
  remainingBudgetUnits: number;
  blocked: boolean;
  cumulative: CodexCreditReceiptScope;
  run?: CodexCreditReceiptScope & { id: string };
}

// Conservative upper bound for one supported text-model turn. GPT-5.6 Terra's
// full 1.05M-token context plus 128K output costs well under this amount.
const MAX_BOUNDED_CALL_CREDITS = 300;
const LEGACY_LEDGER_FLOAT_DRIFT_TOLERANCE = 1e-9;
const SOL_MODEL = /^gpt-5\.6-sol$/i;
const CREDIT_RATES: ReadonlyArray<[RegExp, CodexCreditRate]> = [
  // The unsuffixed GPT-5.6 route is a distinct supported Codex model. Charge
  // it at the highest named-tier rate so bounded runs remain conservative
  // without selecting or permitting the explicitly-disallowed Sol model.
  [/^gpt-5\.6$/i, { input: 125, cachedInput: 12.5, output: 750 }],
  [/^gpt-5\.6-sol$/i, { input: 125, cachedInput: 12.5, output: 750 }],
  [/^gpt-5\.6-terra$/i, { input: 62.5, cachedInput: 6.25, output: 375 }],
  [/^gpt-5\.6-luna$/i, { input: 25, cachedInput: 2.5, output: 150 }],
  [/^gpt-5\.5$/i, { input: 125, cachedInput: 12.5, output: 750 }],
  [/^gpt-5\.4-mini$/i, { input: 18.75, cachedInput: 1.875, output: 113 }],
  [/^gpt-5\.4$/i, { input: 62.5, cachedInput: 6.25, output: 375 }],
  [/^gpt-5\.3-codex$/i, { input: 43.75, cachedInput: 4.375, output: 350 }],
  [/^gpt-5\.2$/i, { input: 43.75, cachedInput: 4.375, output: 350 }],
];

let completionQueue: Promise<void> = Promise.resolve();
let failNextSettledLockWriteForTest = false;
let failNextOwnedLockRemovalForTest = false;
let failNextLedgerSetupForTest = false;
let failNextLedgerWriteForTest = false;

export class CodexCreditAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCreditAccountingError";
  }
}

/** The Codex child was confirmed not to have started, so no credits were charged. */
export class CodexCreditDispatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexCreditDispatchError";
  }
}

export async function reconcileCodexCreditLedger(args: {
  ledgerPath: string;
  priorLedgerSha256: string;
  beforeAccountBalance: string;
  afterAccountBalance: string;
  sameAccountConfirmed: true;
  snapshotsBracketBlockedEventConfirmed: true;
  balanceSettledConfirmed: true;
  noCreditsAddedOrRefundedConfirmed: true;
  noInterveningCodexActivityConfirmed?: true;
  affectedRunId: string;
}): Promise<CodexCreditReconciliationReceipt> {
  if (args.sameAccountConfirmed !== true) {
    throw new Error("Codex credit reconciliation requires confirmation that both balances belong to the same account");
  }
  if (args.snapshotsBracketBlockedEventConfirmed !== true) {
    throw new Error("Codex credit reconciliation requires confirmation that the snapshots bracket the blocked event");
  }
  if (args.balanceSettledConfirmed !== true) {
    throw new Error("Codex credit reconciliation requires confirmation that the displayed balances are settled");
  }
  if (args.noCreditsAddedOrRefundedConfirmed !== true) {
    throw new Error(
      "Codex credit reconciliation requires confirmation that no credits were added or refunded between snapshots"
    );
  }
  if (!isSha256(args.priorLedgerSha256)) {
    throw new Error("priorLedgerSha256 must be a lowercase SHA-256 digest");
  }
  const beforeAccountBalance = parseExactDecimal(args.beforeAccountBalance, "beforeAccountBalance");
  const afterAccountBalance = parseExactDecimal(args.afterAccountBalance, "afterAccountBalance");
  const observedAccountDebit = subtractExactDecimals(beforeAccountBalance, afterAccountBalance);
  if (observedAccountDebit.startsWith("-")) {
    throw new Error("afterAccountBalance exceeds beforeAccountBalance; reconciliation refused");
  }
  const localBudgetChargeUnits = observedAccountDebit === "0" ? 0 : MAX_BOUNDED_CALL_CREDITS;
  if (localBudgetChargeUnits > 0 && args.noInterveningCodexActivityConfirmed !== true) {
    throw new Error(
      "a positive account-wide debit requires confirmation that no other Codex activity occurred between snapshots"
    );
  }
  const affectedRunId = parseRequiredRunId(args.affectedRunId, "affectedRunId");
  const ledgerPath = path.resolve(expandHomeRelativePath(args.ledgerPath));

  const previous = completionQueue;
  let release!: () => void;
  completionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const lockPath = `${ledgerPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      await prepareLedgerDirectory(lockPath);
    } catch (error) {
      throw infrastructureUnavailableError(error);
    }
    lock = await acquireLedgerLock(lockPath);
    const contents = await readFile(ledgerPath);
    const currentSha256 = sha256(contents);
    if (currentSha256 !== args.priorLedgerSha256) {
      throw new Error(
        `Codex credit ledger changed since operator observation: expected ${args.priorLedgerSha256}, ` +
          `found ${currentSha256}; obtain a fresh ledger hash and remaining balance`
      );
    }
    const ledger = parseLedger(JSON.parse(contents.toString("utf8")), contents);
    if (!ledger.blockedEvent) {
      throw new Error("Codex credit ledger is not blocked; reconciliation is not permitted");
    }
    if (ledger.blockedEvent.runId && ledger.blockedEvent.runId !== affectedRunId) {
      throw new Error(
        `affectedRunId does not match the blocked event run ID ${JSON.stringify(ledger.blockedEvent.runId)}`
      );
    }
    const plannedSpendCeilingNanounits =
      budgetUnitsToNanounits(ledger.budgetUnits) - budgetUnitsToNanounits(ledger.reserveUnits);
    const spentNanounits = ledgerSpentNanounits(ledger);
    const localBudgetChargeNanounits = budgetUnitsToNanounits(localBudgetChargeUnits);
    if (plannedSpendCeilingNanounits - spentNanounits < localBudgetChargeNanounits) {
      throw new Error(
        `reconciliation requires ${localBudgetChargeUnits} local budget units but only ` +
          `${nanounitsToBudgetUnits(
            plannedSpendCeilingNanounits > spentNanounits ? plannedSpendCeilingNanounits - spentNanounits : 0n
          )} remain below the planned-spend ceiling`
      );
    }
    const totalSpentNanounits = spentNanounits + localBudgetChargeNanounits;
    const totalSpentUnits = nanounitsToBudgetUnits(totalSpentNanounits);
    const at = new Date().toISOString();
    const affectedBlockedEvent = ledger.blockedEvent;
    const resolution: CodexCreditLedgerResolution = {
      at,
      basis: "operator-observed-account-balance-delta",
      attribution: "account-wide-observation-window",
      priorLedgerSha256: currentSha256,
      priorRecordedSpentUnits: nanounitsToBudgetUnits(spentNanounits),
      priorEntryCount: ledger.entries.length,
      beforeAccountBalance,
      afterAccountBalance,
      observedAccountDebit,
      localBudgetChargeUnits,
      confirmations: {
        sameAccount: true,
        snapshotsBracketBlockedEvent: true,
        balanceSettled: true,
        noCreditsAddedOrRefunded: true,
        ...(args.noInterveningCodexActivityConfirmed === true ? { noInterveningCodexActivity: true as const } : {}),
      },
      affectedRunId,
      affectedBlockedEvent,
    };
    const nextLedger: CodexCreditLedger = {
      ...ledger,
      spentUnits: totalSpentUnits,
      resolutions: [...(ledger.resolutions ?? []), resolution],
      blockedEvent: undefined,
    };
    const committed = await writeLedger(ledgerPath, nextLedger);
    await bestEffortSettleLock(lock);
    return {
      schemaVersion: 2,
      priorLedgerSha256: currentSha256,
      ledgerSha256: committed.sha256,
      at,
      attribution: "account-wide-observation-window",
      affectedRunId,
      priorRecordedSpentUnits: nanounitsToBudgetUnits(spentNanounits),
      beforeAccountBalance,
      afterAccountBalance,
      observedAccountDebit,
      localBudgetChargeUnits,
      totalSpentUnits,
      remainingPlannedSpendUnits: nanounitsToBudgetUnits(plannedSpendCeilingNanounits - totalSpentNanounits),
      affectedBlockedEventSha256: sha256(JSON.stringify(affectedBlockedEvent)),
    };
  } finally {
    try {
      if (lock) {
        try {
          await bestEffortCloseLock(lock);
        } finally {
          await bestEffortRemoveOwnedLedgerLock(lockPath);
        }
      }
    } finally {
      release();
    }
  }
}

export function resolveCodexCreditBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
  fallbackRunId?: string
): CodexCreditBudgetConfig | undefined {
  const rawBudget = env.REMNIC_BENCH_CODEX_CREDIT_BUDGET?.trim();
  if (!rawBudget) return undefined;

  const budgetCredits = parsePositiveNumber(rawBudget, "REMNIC_BENCH_CODEX_CREDIT_BUDGET");
  const reserveCredits = parseNonNegativeNumber(
    env.REMNIC_BENCH_CODEX_CREDIT_RESERVE?.trim() ?? "473",
    "REMNIC_BENCH_CODEX_CREDIT_RESERVE"
  );
  if (reserveCredits >= budgetCredits) {
    throw new Error("REMNIC_BENCH_CODEX_CREDIT_RESERVE must be smaller than REMNIC_BENCH_CODEX_CREDIT_BUDGET");
  }
  if (reserveCredits < MAX_BOUNDED_CALL_CREDITS) {
    throw new Error(
      `REMNIC_BENCH_CODEX_CREDIT_RESERVE must be at least ${MAX_BOUNDED_CALL_CREDITS} credits to cover the conservative maximum cost of the one serialized in-flight call`
    );
  }

  const ledgerPath = path.resolve(
    expandHomeRelativePath(env.REMNIC_BENCH_CODEX_CREDIT_LEDGER?.trim() || ".remnic/bench/codex-credit-ledger.json")
  );
  const runId = parseOptionalRunId(env.REMNIC_BENCH_RUN_ID) ?? parseOptionalRunId(fallbackRunId);
  return {
    budgetCredits,
    reserveCredits,
    ledgerPath,
    allowSol: /^(?:1|true|yes|on)$/i.test(env.REMNIC_BENCH_CODEX_ALLOW_SOL?.trim() ?? ""),
    ...(runId ? { runId } : {}),
  };
}

export async function runWithinCodexCreditBudget<T>(args: {
  config: CodexCreditBudgetConfig | undefined;
  model: string;
  run: () => Promise<{ value: T; usage: CodexCliNativeUsage }>;
  onUsagePersisted?: (usage: CodexCliNativeUsage) => void;
}): Promise<T> {
  if (!args.config) {
    return (await args.run()).value;
  }
  try {
    budgetUnitsToNanounits(args.config.budgetCredits);
    budgetUnitsToNanounits(args.config.reserveCredits);
  } catch (error) {
    throw infrastructureUnavailableError(error);
  }

  const previous = completionQueue;
  let release!: () => void;
  completionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const lockPath = `${args.config.ledgerPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let dispatchStarted = false;
  let accountingSettled = false;
  let ledgerCommitted = false;
  try {
    try {
      await prepareLedgerDirectory(lockPath);
    } catch (error) {
      throw infrastructureUnavailableError(error);
    }
    lock = await acquireLedgerLock(lockPath);
    assertModelAllowed(args.model, args.config);
    const ledger = await readLedger(args.config);
    if (ledger.blockedEvent) {
      throw new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.ManualReconciliationRequired,
        "Codex credit ledger requires manual reconciliation.",
        { cause: new Error(`Private ledger block: ${ledger.blockedEvent.reason}`) }
      );
    }
    const usableNanounits =
      budgetUnitsToNanounits(args.config.budgetCredits) - budgetUnitsToNanounits(args.config.reserveCredits);
    const usableCredits = nanounitsToBudgetUnits(usableNanounits);
    const spentNanounits = ledgerSpentNanounits(ledger);
    const dispatchHeadroomNanounits = usableNanounits - spentNanounits;
    if (dispatchHeadroomNanounits < budgetUnitsToNanounits(MAX_BOUNDED_CALL_CREDITS)) {
      throw new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.SpendHeadroomExhausted,
        "Codex credit budget lacks conservative dispatch headroom.",
        {
          cause: new Error(
            `${nanounitsToBudgetUnits(spentNanounits)} local units spent; ` +
              `${nanounitsToBudgetUnits(dispatchHeadroomNanounits)} available; ` +
              `${MAX_BOUNDED_CALL_CREDITS} required.`
          ),
        }
      );
    }

    await writeLockState(lock, "in-flight");
    dispatchStarted = true;
    let result: Awaited<ReturnType<typeof args.run>>;
    try {
      result = await args.run();
    } catch (error) {
      if (error instanceof CodexCreditDispatchError) {
        accountingSettled = true;
        await bestEffortSettleLock(lock);
        throw new BenchmarkRunBlockedError(
          BenchmarkRunBlockReason.InfrastructureUnavailable,
          "Codex CLI infrastructure was unavailable before dispatch.",
          { cause: error }
        );
      }
      const blockedLedger: CodexCreditLedger = {
        ...ledger,
        blockedEvent: {
          at: new Date().toISOString(),
          ...(args.config.runId ? { runId: args.config.runId } : {}),
          model: args.model,
          reason:
            error instanceof CodexCreditAccountingError
              ? error.message
              : `Codex dispatch outcome is unknown after an unexpected error: ${safeErrorMessage(error)}`,
        },
      };
      try {
        await writeLedger(args.config.ledgerPath, blockedLedger);
      } catch (persistenceError) {
        throw accountingPersistenceBlockedError(persistenceError, error);
      }
      ledgerCommitted = true;
      accountingSettled = true;
      await bestEffortSettleLock(lock);
      throw new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.ManualReconciliationRequired,
        "Codex usage accounting is uncertain; manual reconciliation is required.",
        {
          cause: error,
        }
      );
    }
    const creditNanounits = calculateCodexBudgetNanounits(args.model, result.usage);
    const credits = nanounitsToBudgetUnits(creditNanounits);
    const nextSpentNanounits = spentNanounits + creditNanounits;
    const nextSpent = nanounitsToBudgetUnits(nextSpentNanounits);
    const nextLedger: CodexCreditLedger = {
      ...ledger,
      spentUnits: nextSpent,
      entries: [
        ...ledger.entries,
        {
          at: new Date().toISOString(),
          model: args.model,
          budgetUnits: credits,
          ...(args.config.runId ? { runId: args.config.runId } : {}),
          ...result.usage,
        },
      ],
    };
    try {
      await writeLedger(args.config.ledgerPath, nextLedger);
    } catch (error) {
      throw accountingPersistenceBlockedError(error);
    }
    ledgerCommitted = true;
    accountingSettled = true;
    await bestEffortSettleLock(lock);
    try {
      args.onUsagePersisted?.(result.usage);
    } catch {
      // The ledger commit is authoritative; an observer cannot roll it back.
    }
    if (nextSpentNanounits > usableNanounits) {
      throw new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.SpendCeilingExceeded,
        "Codex planned-spend ceiling was exceeded by committed usage.",
        { cause: new Error(`${nextSpent} local units spent exceeds the ${usableCredits} planned ceiling.`) }
      );
    }
    return result.value;
  } finally {
    try {
      if (lock) {
        try {
          await bestEffortCloseLock(lock);
        } finally {
          if (!dispatchStarted || accountingSettled || ledgerCommitted) {
            await bestEffortRemoveOwnedLedgerLock(lockPath);
          }
        }
      }
    } finally {
      release();
    }
  }
}

async function acquireLedgerLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw infrastructureUnavailableError(error);
      const owner = await readLockOwner(lockPath);
      if (!owner || isProcessAlive(owner.pid) || owner.phase === "in-flight") {
        throw resourceLockedError(
          new Error(
            `Codex credit ledger is locked${owner?.phase === "in-flight" ? " with unreconciled in-flight usage" : " by another benchmark process"} ` +
              `(${lockPath}); refusing credit spend.`
          )
        );
      }
      await reclaimStaleLedgerLock(lockPath, owner);
      continue;
    }

    let createdLock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(lockHeldPath(lockPath));
      createdLock = await open(lockOwnerPath(lockPath), "wx", 0o600);
      await writeLockState(createdLock, "preflight");
      return createdLock;
    } catch (error) {
      await createdLock?.close().catch(() => undefined);
      await unlink(lockOwnerPath(lockPath)).catch(() => undefined);
      await rmdir(lockHeldPath(lockPath)).catch(() => undefined);
      await rmdir(lockPath).catch(() => undefined);
      throw infrastructureUnavailableError(error);
    }
  }
  throw resourceLockedError(new Error(`Unable to acquire Codex credit ledger lock (${lockPath})`));
}

async function readLockOwner(lockPath: string): Promise<{ pid: number; phase: LedgerLockPhase } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockOwnerPath(lockPath), "utf8")) as {
      pid?: unknown;
      phase?: unknown;
    };
    if (
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      (parsed.phase !== "preflight" && parsed.phase !== "in-flight" && parsed.phase !== "settled")
    ) {
      return undefined;
    }
    return { pid: parsed.pid as number, phase: parsed.phase };
  } catch {
    return undefined;
  }
}

async function reclaimStaleLedgerLock(
  lockPath: string,
  expectedOwner: { pid: number; phase: LedgerLockPhase }
): Promise<void> {
  try {
    await rmdir(lockHeldPath(lockPath));
  } catch (error) {
    throw resourceLockedError(
      new Error(
        `Codex credit ledger stale-lock reclamation is already claimed or incomplete (${lockPath}); refusing credit spend: ${safeErrorMessage(error)}`,
        { cause: error }
      )
    );
  }

  const currentOwner = await readLockOwner(lockPath);
  if (
    !currentOwner ||
    currentOwner.pid !== expectedOwner.pid ||
    currentOwner.phase !== expectedOwner.phase ||
    isProcessAlive(currentOwner.pid) ||
    currentOwner.phase === "in-flight"
  ) {
    throw resourceLockedError(
      new Error(`Codex credit ledger owner changed during stale-lock reclamation (${lockPath}); refusing credit spend.`)
    );
  }

  await unlink(lockOwnerPath(lockPath));
  await rmdir(lockPath);
}

async function removeOwnedLedgerLock(lockPath: string): Promise<void> {
  await rmdir(lockHeldPath(lockPath));
  await unlink(lockOwnerPath(lockPath));
  await rmdir(lockPath);
}

function lockOwnerPath(lockPath: string): string {
  return path.join(lockPath, "owner.json");
}

function lockHeldPath(lockPath: string): string {
  return path.join(lockPath, "held");
}

async function writeLockState(lock: Awaited<ReturnType<typeof open>>, phase: LedgerLockPhase): Promise<void> {
  if (phase === "settled" && failNextSettledLockWriteForTest) {
    failNextSettledLockWriteForTest = false;
    throw new Error("injected settled lock-state failure");
  }
  const contents = `${JSON.stringify({
    pid: process.pid,
    phase,
    updatedAt: new Date().toISOString(),
  })}\n`;
  await lock.truncate(0);
  await lock.write(contents, 0, "utf8");
  await lock.sync();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function parseCodexJsonlUsage(output: string): CodexCliNativeUsage | undefined {
  let usage: CodexCliNativeUsage | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        usage?: Record<string, unknown>;
      };
      if (event.type !== "turn.completed" || !event.usage) continue;
      const inputTokens = readCounter(event.usage.input_tokens);
      const outputTokens = readCounter(event.usage.output_tokens);
      const cachedInputTokens = readOptionalCounter(event.usage.cached_input_tokens);
      const reasoningOutputTokens = readOptionalCounter(event.usage.reasoning_output_tokens);
      if (
        inputTokens !== undefined &&
        outputTokens !== undefined &&
        cachedInputTokens !== undefined &&
        reasoningOutputTokens !== undefined
      ) {
        usage = {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens,
        };
      }
    } catch {
      // Codex may print non-JSON status text alongside JSONL. Ignore it.
    }
  }
  return usage;
}

export function calculateCodexBudgetUnits(model: string, usage: CodexCliNativeUsage): number {
  return nanounitsToBudgetUnits(calculateCodexBudgetNanounits(model, usage));
}

function calculateCodexBudgetNanounits(model: string, usage: CodexCliNativeUsage): bigint {
  const rate = resolveRate(model);
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncached = usage.inputTokens - cached;
  return (
    BigInt(uncached) * rateNanounitsPerToken(rate.input) +
    BigInt(cached) * rateNanounitsPerToken(rate.cachedInput) +
    BigInt(usage.outputTokens) * rateNanounitsPerToken(rate.output)
  );
}

/** @deprecated Use calculateCodexBudgetUnits; this value is a local budget unit, not an account debit. */
export function calculateCodexCredits(model: string, usage: CodexCliNativeUsage): number {
  return calculateCodexBudgetUnits(model, usage);
}

export async function buildCodexCreditReceipt(ledgerPath: string, runId?: string): Promise<CodexCreditReceipt> {
  const resolvedPath = path.resolve(expandHomeRelativePath(ledgerPath));
  const contents = await readFile(resolvedPath);
  const ledger = parseLedger(JSON.parse(contents.toString("utf8")), contents);
  const normalizedRunId = parseOptionalRunId(runId);
  const spentNanounits = ledgerSpentNanounits(ledger);
  const budgetNanounits = budgetUnitsToNanounits(ledger.budgetUnits);
  const reserveNanounits = budgetUnitsToNanounits(ledger.reserveUnits);
  const cumulative = summarizeLedgerEntries(
    ledger.entries,
    ledger.resolutions ?? [],
    ledger.legacyReconciliations ?? []
  );
  const runEntries = normalizedRunId ? ledger.entries.filter((entry) => entry.runId === normalizedRunId) : [];
  return {
    schemaVersion: 2,
    ledgerSha256: sha256(contents),
    budgetUnits: ledger.budgetUnits,
    reserveUnits: ledger.reserveUnits,
    plannedSpendCeilingUnits: nanounitsToBudgetUnits(budgetNanounits - reserveNanounits),
    totalSpentUnits: nanounitsToBudgetUnits(spentNanounits),
    remainingBudgetUnits: nanounitsToBudgetUnits(budgetNanounits - spentNanounits),
    blocked: ledger.blockedEvent !== undefined,
    cumulative,
    ...(normalizedRunId
      ? {
          run: {
            id: normalizedRunId,
            ...summarizeLedgerEntries(runEntries),
          },
        }
      : {}),
  };
}

function resolveRate(model: string): CodexCreditRate {
  const match = CREDIT_RATES.find(([pattern]) => pattern.test(model));
  if (!match) {
    throw new Error(
      `No Codex credit rate is configured for model ${JSON.stringify(model)}; refusing to run under a bounded credit budget.`
    );
  }
  return match[1];
}

function assertModelAllowed(model: string, config: CodexCreditBudgetConfig): void {
  try {
    resolveRate(model);
  } catch (error) {
    throw new BenchmarkRunBlockedError(
      BenchmarkRunBlockReason.InfrastructureUnavailable,
      "Configured Codex model is unsupported by the bounded budget.",
      { cause: error }
    );
  }
  if (SOL_MODEL.test(model) && !config.allowSol) {
    throw new BenchmarkRunBlockedError(
      BenchmarkRunBlockReason.InfrastructureUnavailable,
      "Configured Codex model is disallowed by bounded-budget policy.",
      {
        cause: new Error(
          "gpt-5.6-sol is disabled for bounded benchmark runs because it is the most expensive GPT-5.6 tier. " +
            "Use gpt-5.6-terra or gpt-5.6-luna, or explicitly set REMNIC_BENCH_CODEX_ALLOW_SOL=1."
        ),
      }
    );
  }
}

async function readLedger(config: CodexCreditBudgetConfig): Promise<CodexCreditLedger> {
  try {
    const contents = await readFile(config.ledgerPath);
    const parsed = parseLedger(JSON.parse(contents.toString("utf8")), contents);
    if (parsed.budgetUnits !== config.budgetCredits || parsed.reserveUnits !== config.reserveCredits) {
      throw new Error("ledger schema or budget does not match this run");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.ManualReconciliationRequired,
        "Codex credit ledger is invalid or incompatible with this run.",
        { cause: new Error(`Invalid Codex credit ledger at ${config.ledgerPath}: ${String(error)}`, { cause: error }) }
      );
    }
    return {
      schemaVersion: 2,
      budgetUnits: config.budgetCredits,
      reserveUnits: config.reserveCredits,
      spentUnits: 0,
      entries: [],
    };
  }
}

function parseLedger(parsed: unknown, sourceContents?: string | Uint8Array): CodexCreditLedger {
  if (isLedgerV1(parsed)) return migrateLedgerV1(parsed, sourceContents);
  if (!parsed || typeof parsed !== "object") throw new Error("ledger schema is invalid");
  const candidate = parsed as Partial<CodexCreditLedger>;
  if (
    candidate.schemaVersion !== 2 ||
    !isPositiveFinite(candidate.budgetUnits) ||
    !isSupportedBudgetUnits(candidate.budgetUnits) ||
    !isNonNegativeFinite(candidate.reserveUnits) ||
    !isSupportedBudgetUnits(candidate.reserveUnits) ||
    candidate.reserveUnits >= candidate.budgetUnits ||
    !isNonNegativeFinite(candidate.spentUnits) ||
    !Array.isArray(candidate.entries) ||
    !candidate.entries.every(isLedgerEntry) ||
    (candidate.resolutions !== undefined &&
      (!Array.isArray(candidate.resolutions) || !candidate.resolutions.every(isLedgerResolution))) ||
    (candidate.legacyReconciliations !== undefined &&
      (!Array.isArray(candidate.legacyReconciliations) ||
        !candidate.legacyReconciliations.every(isLedgerReconciliationV1))) ||
    !isLedgerSpentConsistent(candidate as CodexCreditLedger) ||
    !isResolutionHistoryConsistent(candidate as CodexCreditLedger) ||
    !isMigrationWitnessConsistent(candidate as CodexCreditLedger) ||
    (candidate.blockedEvent !== undefined && !isBlockedEvent(candidate.blockedEvent)) ||
    (candidate.migratedFromV1Sha256 !== undefined && !isSha256(candidate.migratedFromV1Sha256))
  ) {
    throw new Error("ledger schema is invalid");
  }
  return candidate as CodexCreditLedger;
}

function isLedgerV1(value: unknown): value is CodexCreditLedgerV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodexCreditLedgerV1>;
  const entries = candidate.entries;
  const reconciliations = candidate.reconciliations;
  return (
    candidate.schemaVersion === 1 &&
    isPositiveFinite(candidate.budgetCredits) &&
    isSupportedBudgetUnits(candidate.budgetCredits) &&
    isNonNegativeFinite(candidate.reserveCredits) &&
    isSupportedBudgetUnits(candidate.reserveCredits) &&
    candidate.reserveCredits < candidate.budgetCredits &&
    isNonNegativeFinite(candidate.spentCredits) &&
    Array.isArray(entries) &&
    entries.every(isLedgerEntryV1) &&
    (reconciliations === undefined ||
      (Array.isArray(reconciliations) &&
        reconciliations.every((item) => isLedgerReconciliationWithinBudgetV1(item, candidate.budgetCredits)))) &&
    isLedgerV1SpentConsistent(candidate as CodexCreditLedgerV1) &&
    (candidate.blockedReason === undefined ||
      (typeof candidate.blockedReason === "string" && candidate.blockedReason.length > 0))
  );
}

function migrateLedgerV1(ledger: CodexCreditLedgerV1, sourceContents?: string | Uint8Array): CodexCreditLedger {
  const source = sourceContents ? Buffer.from(sourceContents).toString("utf8") : `${JSON.stringify(ledger)}\n`;
  const spentUnits = nanounitsToBudgetUnits(ledgerV1SpentNanounits(ledger));
  return {
    schemaVersion: 2,
    budgetUnits: ledger.budgetCredits,
    reserveUnits: ledger.reserveCredits,
    spentUnits,
    entries: ledger.entries.map(({ credits, ...entry }) => ({ ...entry, budgetUnits: credits })),
    ...(ledger.reconciliations?.length ? { legacyReconciliations: ledger.reconciliations } : {}),
    migratedFromV1Sha256: sha256(source),
    migrationWitnessV1: { source },
    ...(ledger.blockedReason ? { blockedEvent: { reason: ledger.blockedReason } } : {}),
  };
}

function isLedgerReconciliationV1(value: unknown): value is CodexCreditLedgerReconciliationV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodexCreditLedgerReconciliationV1>;
  const forbiddenUsageFields = [
    "runId",
    "unknownEvent",
    "model",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ];
  return (
    forbiddenUsageFields.every((field) => !Object.prototype.hasOwnProperty.call(candidate, field)) &&
    isIsoTimestamp(candidate.at) &&
    candidate.basis === "operator-observed-original-budget-balance" &&
    candidate.attribution === "account-wide-unattributed" &&
    isSha256(candidate.priorLedgerSha256) &&
    typeof candidate.originalBudgetCredits === "number" &&
    Number.isFinite(candidate.originalBudgetCredits) &&
    candidate.originalBudgetCredits > 0 &&
    isSupportedBudgetUnits(candidate.originalBudgetCredits) &&
    typeof candidate.priorRecordedSpentCredits === "number" &&
    Number.isFinite(candidate.priorRecordedSpentCredits) &&
    candidate.priorRecordedSpentCredits >= 0 &&
    isSupportedBudgetUnits(candidate.priorRecordedSpentCredits) &&
    typeof candidate.observedRemainingCredits === "number" &&
    Number.isFinite(candidate.observedRemainingCredits) &&
    candidate.observedRemainingCredits >= 0 &&
    isSupportedBudgetUnits(candidate.observedRemainingCredits) &&
    typeof candidate.credits === "number" &&
    Number.isFinite(candidate.credits) &&
    candidate.credits >= 0 &&
    isSupportedBudgetUnits(candidate.credits) &&
    candidate.confirmations?.observedBalanceBelongsToOriginalBudget === true &&
    candidate.confirmations.noCreditsAddedOrRefunded === true &&
    candidate.confirmations.accountWideUnattributedChargeAccepted === true &&
    isValidStoredRunId(candidate.affectedBlockedEvent?.runId) &&
    typeof candidate.affectedBlockedEvent?.blockedReason === "string" &&
    candidate.affectedBlockedEvent.blockedReason.length > 0
  );
}

function isLedgerReconciliationWithinBudgetV1(value: unknown, budget: unknown): boolean {
  return (
    typeof budget === "number" &&
    isLedgerReconciliationV1(value) &&
    value.originalBudgetCredits === budget &&
    value.observedRemainingCredits <= budget &&
    value.credits <= budget &&
    Math.abs(value.priorRecordedSpentCredits + value.credits + value.observedRemainingCredits - budget) <= 1e-9
  );
}

function isLedgerResolution(value: unknown): value is CodexCreditLedgerResolution {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodexCreditLedgerResolution>;
  return (
    isIsoTimestamp(candidate.at) &&
    candidate.basis === "operator-observed-account-balance-delta" &&
    candidate.attribution === "account-wide-observation-window" &&
    isSha256(candidate.priorLedgerSha256) &&
    isNonNegativeFinite(candidate.priorRecordedSpentUnits) &&
    Number.isSafeInteger(candidate.priorEntryCount) &&
    (candidate.priorEntryCount as number) >= 0 &&
    typeof candidate.beforeAccountBalance === "string" &&
    isExactDecimal(candidate.beforeAccountBalance) &&
    typeof candidate.afterAccountBalance === "string" &&
    isExactDecimal(candidate.afterAccountBalance) &&
    typeof candidate.observedAccountDebit === "string" &&
    isExactDecimal(candidate.observedAccountDebit) &&
    subtractExactDecimals(candidate.beforeAccountBalance, candidate.afterAccountBalance) ===
      candidate.observedAccountDebit &&
    (candidate.localBudgetChargeUnits === 0 || candidate.localBudgetChargeUnits === MAX_BOUNDED_CALL_CREDITS) &&
    (candidate.observedAccountDebit === "0"
      ? candidate.localBudgetChargeUnits === 0
      : candidate.localBudgetChargeUnits === MAX_BOUNDED_CALL_CREDITS) &&
    candidate.confirmations?.sameAccount === true &&
    candidate.confirmations.snapshotsBracketBlockedEvent === true &&
    candidate.confirmations.balanceSettled === true &&
    candidate.confirmations.noCreditsAddedOrRefunded === true &&
    (candidate.observedAccountDebit === "0" || candidate.confirmations.noInterveningCodexActivity === true) &&
    isValidStoredRunId(candidate.affectedRunId) &&
    isBlockedEvent(candidate.affectedBlockedEvent) &&
    (candidate.affectedBlockedEvent.runId === undefined ||
      candidate.affectedBlockedEvent.runId === candidate.affectedRunId)
  );
}

function isResolutionHistoryConsistent(ledger: CodexCreditLedger): boolean {
  const resolutions = ledger.resolutions ?? [];
  if (resolutions.length === 0) return true;
  const legacyNanounits = sumBudgetUnitNanounits(
    (ledger.legacyReconciliations ?? []).map((reconciliation) => reconciliation.credits)
  );
  let priorResolutionNanounits = 0n;
  let priorEntryCount = 0;
  const seenHashes = new Set<string>();

  for (let index = 0; index < resolutions.length; index += 1) {
    const resolution = resolutions[index];
    if (!resolution) return false;
    if (seenHashes.has(resolution.priorLedgerSha256)) return false;
    seenHashes.add(resolution.priorLedgerSha256);
    if (resolution.priorEntryCount < priorEntryCount || resolution.priorEntryCount > ledger.entries.length)
      return false;
    const entriesBeforeResolution = ledger.entries.slice(0, resolution.priorEntryCount);
    const expectedPriorSpentNanounits =
      sumBudgetUnitNanounits(entriesBeforeResolution.map((entry) => entry.budgetUnits)) +
      legacyNanounits +
      priorResolutionNanounits;
    if (budgetUnitsToNanounits(resolution.priorRecordedSpentUnits) !== expectedPriorSpentNanounits) return false;

    if (!(index === 0 && isDirectV1PredecessorResolution(ledger, resolution))) {
      const priorLedger: CodexCreditLedger = {
        ...ledger,
        spentUnits: resolution.priorRecordedSpentUnits,
        entries: entriesBeforeResolution,
        resolutions: index > 0 ? resolutions.slice(0, index) : undefined,
        blockedEvent: resolution.affectedBlockedEvent,
      };
      if (sha256(serializeLedger(priorLedger)) !== resolution.priorLedgerSha256) return false;
    }
    priorResolutionNanounits += budgetUnitsToNanounits(resolution.localBudgetChargeUnits);
    priorEntryCount = resolution.priorEntryCount;
  }
  return true;
}

function isMigrationWitnessConsistent(ledger: CodexCreditLedger): boolean {
  if (!ledger.migratedFromV1Sha256 && !ledger.migrationWitnessV1) return true;
  if (!ledger.migratedFromV1Sha256 || !ledger.migrationWitnessV1) return false;
  const source = ledger.migrationWitnessV1.source;
  if (typeof source !== "string" || sha256(source) !== ledger.migratedFromV1Sha256) return false;
  let predecessor: unknown;
  try {
    predecessor = JSON.parse(source);
  } catch {
    return false;
  }
  if (!isLedgerV1(predecessor)) return false;
  if (predecessor.budgetCredits !== ledger.budgetUnits || predecessor.reserveCredits !== ledger.reserveUnits)
    return false;
  if (JSON.stringify(predecessor.reconciliations ?? []) !== JSON.stringify(ledger.legacyReconciliations ?? [])) {
    return false;
  }
  const migratedEntries = predecessor.entries.map(({ credits, ...entry }) => ({ ...entry, budgetUnits: credits }));
  const firstResolution = ledger.resolutions?.[0];
  const entriesAtMigration = firstResolution
    ? ledger.entries.slice(0, firstResolution.priorEntryCount)
    : ledger.entries.slice(0, migratedEntries.length);
  if (JSON.stringify(migratedEntries) !== JSON.stringify(entriesAtMigration.slice(0, migratedEntries.length))) {
    return false;
  }
  return true;
}

function isDirectV1PredecessorResolution(ledger: CodexCreditLedger, resolution: CodexCreditLedgerResolution): boolean {
  if (!ledger.migratedFromV1Sha256 || !ledger.migrationWitnessV1) return false;
  let predecessor: unknown;
  try {
    predecessor = JSON.parse(ledger.migrationWitnessV1.source);
  } catch {
    return false;
  }
  return (
    isLedgerV1(predecessor) &&
    resolution.priorEntryCount === predecessor.entries.length &&
    resolution.priorLedgerSha256 === ledger.migratedFromV1Sha256 &&
    budgetUnitsToNanounits(resolution.priorRecordedSpentUnits) === ledgerV1SpentNanounits(predecessor) &&
    predecessor.blockedReason === resolution.affectedBlockedEvent.reason
  );
}

function isBlockedEvent(value: unknown): value is CodexCreditBlockedEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodexCreditBlockedEvent>;
  return (
    typeof candidate.reason === "string" &&
    candidate.reason.length > 0 &&
    (candidate.at === undefined || isIsoTimestamp(candidate.at)) &&
    (candidate.runId === undefined || isValidStoredRunId(candidate.runId)) &&
    (candidate.model === undefined || (typeof candidate.model === "string" && candidate.model.length > 0))
  );
}

function isLedgerEntryV1(entry: unknown): entry is CodexCreditLedgerEntryV1 {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<CodexCreditLedgerEntryV1>;
  return (
    isLedgerEntryCommon(candidate) &&
    isNonNegativeFinite(candidate.credits) &&
    isSupportedBudgetUnits(candidate.credits) &&
    isEntryCreditConsistentV1(candidate as CodexCreditLedgerEntryV1)
  );
}

function isLedgerEntry(entry: unknown): entry is CodexCreditLedgerEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<CodexCreditLedgerEntry>;
  return (
    isIsoTimestamp(candidate.at) &&
    typeof candidate.model === "string" &&
    candidate.model.length > 0 &&
    isNonNegativeFinite(candidate.budgetUnits) &&
    (candidate.runId === undefined || isValidStoredRunId(candidate.runId)) &&
    readCounter(candidate.inputTokens) !== undefined &&
    readCounter(candidate.cachedInputTokens) !== undefined &&
    readCounter(candidate.outputTokens) !== undefined &&
    readCounter(candidate.reasoningOutputTokens) !== undefined &&
    (candidate.cachedInputTokens ?? 0) <= (candidate.inputTokens ?? 0) &&
    isEntryBudgetUnitConsistent(candidate as CodexCreditLedgerEntry)
  );
}

function isLedgerEntryCommon(candidate: Partial<CodexCreditLedgerEntryV1>): boolean {
  return (
    isIsoTimestamp(candidate.at) &&
    typeof candidate.model === "string" &&
    candidate.model.length > 0 &&
    (candidate.runId === undefined || isValidStoredRunId(candidate.runId)) &&
    readCounter(candidate.inputTokens) !== undefined &&
    readCounter(candidate.cachedInputTokens) !== undefined &&
    readCounter(candidate.outputTokens) !== undefined &&
    readCounter(candidate.reasoningOutputTokens) !== undefined &&
    (candidate.cachedInputTokens ?? 0) <= (candidate.inputTokens ?? 0)
  );
}

function isEntryCreditConsistentV1(entry: CodexCreditLedgerEntryV1): boolean {
  try {
    return Math.abs(calculateCodexBudgetUnits(entry.model, entry) - entry.credits) <= 1e-9;
  } catch {
    return false;
  }
}

function isEntryBudgetUnitConsistent(entry: CodexCreditLedgerEntry): boolean {
  try {
    return Math.abs(calculateCodexBudgetUnits(entry.model, entry) - entry.budgetUnits) <= 1e-9;
  } catch {
    return false;
  }
}

function summarizeLedgerEntries(
  entries: CodexCreditLedgerEntry[],
  resolutions: CodexCreditLedgerResolution[] = [],
  legacyReconciliations: CodexCreditLedgerReconciliationV1[] = []
): CodexCreditReceiptScope {
  const byModel = new Map<string, CodexCreditLedgerEntry[]>();
  for (const entry of entries) {
    const modelEntries = byModel.get(entry.model) ?? [];
    modelEntries.push(entry);
    byModel.set(entry.model, modelEntries);
  }
  const totals = summarizeUsage(entries);
  return {
    calls: entries.length,
    budgetUnits: nanounitsToBudgetUnits(
      sumBudgetUnitNanounits(entries.map((entry) => entry.budgetUnits)) +
        sumBudgetUnitNanounits(resolutions.map((resolution) => resolution.localBudgetChargeUnits)) +
        sumBudgetUnitNanounits(legacyReconciliations.map((reconciliation) => reconciliation.credits))
    ),
    accountBalanceResolutionCount: resolutions.length + legacyReconciliations.length,
    conservativeResolutionChargeUnits: nanounitsToBudgetUnits(
      sumBudgetUnitNanounits(resolutions.map((resolution) => resolution.localBudgetChargeUnits)) +
        sumBudgetUnitNanounits(legacyReconciliations.map((reconciliation) => reconciliation.credits))
    ),
    ...totals,
    models: [...byModel.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([model, modelEntries]) => ({
        model,
        calls: modelEntries.length,
        budgetUnits: nanounitsToBudgetUnits(sumBudgetUnitNanounits(modelEntries.map((entry) => entry.budgetUnits))),
        ...summarizeUsage(modelEntries),
      })),
  };
}

function summarizeUsage(entries: CodexCreditLedgerEntry[]): CodexCliNativeUsage {
  return entries.reduce<CodexCliNativeUsage>(
    (totals, entry) => ({
      inputTokens: totals.inputTokens + entry.inputTokens,
      cachedInputTokens: totals.cachedInputTokens + entry.cachedInputTokens,
      outputTokens: totals.outputTokens + entry.outputTokens,
      reasoningOutputTokens: totals.reasoningOutputTokens + entry.reasoningOutputTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
  );
}

async function writeLedger(filePath: string, ledger: CodexCreditLedger): Promise<{ contents: string; sha256: string }> {
  if (failNextLedgerWriteForTest) {
    failNextLedgerWriteForTest = false;
    throw new Error(`injected ledger write failure for ${filePath}`);
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const contents = serializeLedger(ledger);
  await writeFile(tempPath, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, filePath);
  return { contents, sha256: sha256(contents) };
}

function serializeLedger(ledger: CodexCreditLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

function readCounter(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function readOptionalCounter(value: unknown): number | undefined {
  return value === undefined ? 0 : readCounter(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resourceLockedError(cause: unknown): BenchmarkRunBlockedError {
  const original = cause instanceof Error ? cause : new Error("Codex credit ledger lock acquisition failed.");
  return new BenchmarkRunBlockedError(
    BenchmarkRunBlockReason.ResourceLocked,
    "Codex credit ledger resource is locked.",
    { cause: original }
  );
}

function infrastructureUnavailableError(cause: unknown): BenchmarkRunBlockedError {
  const original = cause instanceof Error ? cause : new Error("Codex ledger infrastructure setup failed.");
  return new BenchmarkRunBlockedError(
    BenchmarkRunBlockReason.InfrastructureUnavailable,
    "Codex ledger infrastructure is unavailable.",
    { cause: original }
  );
}

function accountingPersistenceBlockedError(
  persistenceError: unknown,
  underlyingRunError?: unknown
): BenchmarkRunBlockedError {
  const persistenceCause =
    persistenceError instanceof Error ? persistenceError : new Error("Codex ledger persistence failed.");
  const cause =
    underlyingRunError === undefined
      ? persistenceCause
      : new AggregateError(
          [persistenceCause, underlyingRunError],
          "Codex ledger persistence failed after an uncertain dispatch outcome."
        );
  return new BenchmarkRunBlockedError(
    BenchmarkRunBlockReason.ManualReconciliationRequired,
    "Codex usage accounting could not be persisted; manual reconciliation is required.",
    { cause }
  );
}

async function prepareLedgerDirectory(lockPath: string): Promise<void> {
  if (failNextLedgerSetupForTest) {
    failNextLedgerSetupForTest = false;
    throw new Error(`injected setup failure for ${lockPath}`);
  }
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
}

async function bestEffortSettleLock(lock: Awaited<ReturnType<typeof open>>): Promise<void> {
  await writeLockState(lock, "settled").catch(() => undefined);
}

async function bestEffortCloseLock(lock: Awaited<ReturnType<typeof open>>): Promise<void> {
  await lock.close().catch(() => undefined);
}

async function bestEffortRemoveOwnedLedgerLock(lockPath: string): Promise<void> {
  if (failNextOwnedLockRemovalForTest) {
    failNextOwnedLockRemovalForTest = false;
    failNextLedgerSetupForTest = false;
    return;
  }
  await removeOwnedLedgerLock(lockPath).catch(() => undefined);
}

function expandHomeRelativePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite number greater than zero`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return parsed;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSupportedBudgetUnits(value: unknown): value is number {
  if (typeof value !== "number") return false;
  try {
    budgetUnitsToNanounits(value);
    return true;
  } catch {
    return false;
  }
}

const BUDGET_UNIT_SCALE = 1_000_000_000;

function rateNanounitsPerToken(rate: number): bigint {
  const scaled = rate * 1_000;
  if (!Number.isSafeInteger(scaled)) throw new Error("Codex credit rate exceeds nanounit precision");
  return BigInt(scaled);
}

function budgetUnitsToNanounits(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error("budget units must be finite and non-negative");
  const fixed = value.toFixed(9);
  if (Number(fixed) !== value) {
    throw new Error("budget units exceed supported nanounit precision");
  }
  const [integer = "0", fraction = ""] = fixed.split(".");
  const nanounits = BigInt(integer) * BigInt(BUDGET_UNIT_SCALE) + BigInt(fraction.padEnd(9, "0"));
  if (nanounits > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("budget units exceed safe integer range");
  return nanounits;
}

function nanounitsToBudgetUnits(value: bigint): number {
  return Number(value) / BUDGET_UNIT_SCALE;
}

function sumBudgetUnitNanounits(values: number[]): bigint {
  return values.reduce((sum, value) => sum + budgetUnitsToNanounits(value), 0n);
}

function ledgerV1SpentNanounits(ledger: CodexCreditLedgerV1): bigint {
  return (
    sumBudgetUnitNanounits(ledger.entries.map((entry) => entry.credits)) +
    sumBudgetUnitNanounits((ledger.reconciliations ?? []).map((reconciliation) => reconciliation.credits))
  );
}

function isLedgerV1SpentConsistent(ledger: CodexCreditLedgerV1): boolean {
  try {
    const exactSpentNanounits = ledgerV1SpentNanounits(ledger);
    if (exactSpentNanounits > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    const exactSpentUnits = nanounitsToBudgetUnits(exactSpentNanounits);
    return Math.abs(exactSpentUnits - ledger.spentCredits) <= LEGACY_LEDGER_FLOAT_DRIFT_TOLERANCE;
  } catch {
    return false;
  }
}

function ledgerSpentNanounits(ledger: CodexCreditLedger): bigint {
  return (
    sumBudgetUnitNanounits(ledger.entries.map((entry) => entry.budgetUnits)) +
    sumBudgetUnitNanounits((ledger.resolutions ?? []).map((resolution) => resolution.localBudgetChargeUnits)) +
    sumBudgetUnitNanounits((ledger.legacyReconciliations ?? []).map((reconciliation) => reconciliation.credits))
  );
}

function isLedgerSpentConsistent(ledger: CodexCreditLedger): boolean {
  try {
    return budgetUnitsToNanounits(ledger.spentUnits) === ledgerSpentNanounits(ledger);
  } catch {
    return false;
  }
}

function sameBudgetUnits(left: number, right: number): boolean {
  try {
    return budgetUnitsToNanounits(left) === budgetUnitsToNanounits(right);
  } catch {
    return false;
  }
}

function parseExactDecimal(value: string, name: string): string {
  if (typeof value !== "string" || value !== value.trim() || !isExactDecimal(value)) {
    throw new Error(`${name} must be a non-negative plain decimal string`);
  }
  return value;
}

function isExactDecimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.length <= 128;
}

function subtractExactDecimals(before: string, after: string): string {
  const beforeParts = splitExactDecimal(before);
  const afterParts = splitExactDecimal(after);
  const scale = Math.max(beforeParts.fraction.length, afterParts.fraction.length);
  const beforeScaled = BigInt(`${beforeParts.integer}${beforeParts.fraction.padEnd(scale, "0")}`);
  const afterScaled = BigInt(`${afterParts.integer}${afterParts.fraction.padEnd(scale, "0")}`);
  const difference = beforeScaled - afterScaled;
  const sign = difference < 0n ? "-" : "";
  const digits = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${sign}${digits}`;
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${sign}${integer}.${fraction}` : `${sign}${integer}`;
}

function splitExactDecimal(value: string): { integer: string; fraction: string } {
  const [integer, fraction = ""] = value.split(".");
  return { integer: integer ?? "", fraction };
}

function parseOptionalRunId(value: string | undefined): string | undefined {
  const runId = value?.trim();
  if (!runId) return undefined;
  if (runId.length > 128 || hasControlCharacters(runId)) {
    throw new Error("REMNIC_BENCH_RUN_ID must be at most 128 characters without control characters");
  }
  return runId;
}

function isValidStoredRunId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function parseRequiredRunId(value: string, name: string): string {
  const runId = value?.trim();
  if (!runId || !isValidStoredRunId(runId)) {
    throw new Error(`${name} must be 1 to 128 trimmed characters without control characters`);
  }
  return runId;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export const __codexCreditBudgetTestHooks = {
  resetQueue: () => {
    completionQueue = Promise.resolve();
    failNextSettledLockWriteForTest = false;
    failNextOwnedLockRemovalForTest = false;
    failNextLedgerSetupForTest = false;
    failNextLedgerWriteForTest = false;
  },
  failNextSettledLockWrite: () => {
    failNextSettledLockWriteForTest = true;
  },
  failNextOwnedLockRemoval: () => {
    failNextOwnedLockRemovalForTest = true;
  },
  failNextLedgerSetup: () => {
    failNextLedgerSetupForTest = true;
  },
  failNextLedgerWrite: () => {
    failNextLedgerWriteForTest = true;
  },
};
