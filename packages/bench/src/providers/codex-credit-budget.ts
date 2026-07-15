import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

interface CodexCreditLedgerEntry extends CodexCliNativeUsage {
  at: string;
  model: string;
  credits: number;
  runId?: string;
}

interface CodexCreditLedgerReconciliation {
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

interface CodexCreditLedger {
  schemaVersion: 1;
  budgetCredits: number;
  reserveCredits: number;
  spentCredits: number;
  entries: CodexCreditLedgerEntry[];
  reconciliations?: CodexCreditLedgerReconciliation[];
  blockedReason?: string;
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
  credits: number;
  unattributedReconciliationCount: number;
  unattributedReconciledCredits: number;
  models: Array<
    CodexCliNativeUsage & {
      model: string;
      calls: number;
      credits: number;
    }
  >;
}

export interface CodexCreditReconciliationReceipt {
  schemaVersion: 1;
  priorLedgerSha256: string;
  ledgerSha256: string;
  at: string;
  attribution: "account-wide-unattributed";
  affectedRunId: string;
  originalBudgetCredits: number;
  priorRecordedSpentCredits: number;
  observedRemainingCredits: number;
  unattributedCredits: number;
  totalSpentCredits: number;
  totalRemainingCredits: number;
  affectedBlockedEventSha256: string;
}

export interface CodexCreditReceipt {
  schemaVersion: 1;
  ledgerSha256: string;
  budgetCredits: number;
  reserveCredits: number;
  plannedSpendCeilingCredits: number;
  totalSpentCredits: number;
  totalRemainingCredits: number;
  blocked: boolean;
  cumulative: CodexCreditReceiptScope;
  run?: CodexCreditReceiptScope & { id: string };
}

const ONE_MILLION = 1_000_000;
const CREDIT_EPSILON = 1e-9;
// Conservative upper bound for one supported text-model turn. GPT-5.6 Terra's
// full 1.05M-token context plus 128K output costs well under this amount.
const MAX_BOUNDED_CALL_CREDITS = 300;
const SOL_MODEL = /^gpt-5\.6-sol$/i;
const CREDIT_RATES: ReadonlyArray<[RegExp, CodexCreditRate]> = [
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
  observedRemainingCredits: number;
  originalBudgetBalanceConfirmed: true;
  noCreditsAddedOrRefundedConfirmed: true;
  accountWideUnattributedChargeAccepted: true;
  affectedRunId: string;
}): Promise<CodexCreditReconciliationReceipt> {
  if (args.originalBudgetBalanceConfirmed !== true) {
    throw new Error(
      "Codex credit reconciliation requires confirmation that the observed balance belongs to the ledger's original budget",
    );
  }
  if (args.noCreditsAddedOrRefundedConfirmed !== true) {
    throw new Error(
      "Codex credit reconciliation requires confirmation that no credits were added or refunded after the original budget was established",
    );
  }
  if (args.accountWideUnattributedChargeAccepted !== true) {
    throw new Error(
      "Codex credit reconciliation requires acknowledgment that all unexplained account activity will be charged as account-wide unattributed spend",
    );
  }
  if (!isSha256(args.priorLedgerSha256)) {
    throw new Error("priorLedgerSha256 must be a lowercase SHA-256 digest");
  }
  if (!Number.isFinite(args.observedRemainingCredits) || args.observedRemainingCredits < 0) {
    throw new Error("observedRemainingCredits must be a finite non-negative number");
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
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    lock = await acquireLedgerLock(lockPath);
    const contents = await readFile(ledgerPath);
    const currentSha256 = sha256(contents);
    if (currentSha256 !== args.priorLedgerSha256) {
      throw new Error(
        `Codex credit ledger changed since operator observation: expected ${args.priorLedgerSha256}, ` +
          `found ${currentSha256}; obtain a fresh ledger hash and remaining balance`,
      );
    }
    const ledger = parseLedger(JSON.parse(contents.toString("utf8")) as Partial<CodexCreditLedger>);
    if (!ledger.blockedReason) {
      throw new Error("Codex credit ledger is not blocked; reconciliation is not permitted");
    }
    if (args.observedRemainingCredits > ledger.budgetCredits) {
      throw new Error("observedRemainingCredits cannot exceed the ledger budget");
    }
    const rawUnattributedCredits =
      ledger.budgetCredits - args.observedRemainingCredits - ledger.spentCredits;
    if (
      !Number.isFinite(rawUnattributedCredits) ||
      rawUnattributedCredits < -CREDIT_EPSILON
    ) {
      throw new Error(
        "observedRemainingCredits implies less spend than the ledger already records; reconciliation refused",
      );
    }
    const unattributedCredits =
      Math.abs(rawUnattributedCredits) <= CREDIT_EPSILON
        ? 0
        : rawUnattributedCredits;
    const observedSpentCredits = ledger.spentCredits + unattributedCredits;
    const at = new Date().toISOString();
    const reconciliation: CodexCreditLedgerReconciliation = {
      at,
      basis: "operator-observed-original-budget-balance",
      attribution: "account-wide-unattributed",
      priorLedgerSha256: currentSha256,
      originalBudgetCredits: ledger.budgetCredits,
      priorRecordedSpentCredits: ledger.spentCredits,
      observedRemainingCredits: args.observedRemainingCredits,
      credits: normalizeZero(unattributedCredits),
      confirmations: {
        observedBalanceBelongsToOriginalBudget: true,
        noCreditsAddedOrRefunded: true,
        accountWideUnattributedChargeAccepted: true,
      },
      affectedBlockedEvent: {
        runId: affectedRunId,
        blockedReason: ledger.blockedReason,
      },
    };
    const nextLedger: CodexCreditLedger = {
      ...ledger,
      spentCredits: observedSpentCredits,
      reconciliations: [...(ledger.reconciliations ?? []), reconciliation],
      blockedReason: undefined,
    };
    await writeLedger(ledgerPath, nextLedger);
    await writeLockState(lock, "settled");
    const nextContents = await readFile(ledgerPath);
    return {
      schemaVersion: 1,
      priorLedgerSha256: currentSha256,
      ledgerSha256: sha256(nextContents),
      at,
      attribution: "account-wide-unattributed",
      affectedRunId,
      originalBudgetCredits: ledger.budgetCredits,
      priorRecordedSpentCredits: ledger.spentCredits,
      observedRemainingCredits: args.observedRemainingCredits,
      unattributedCredits: reconciliation.credits,
      totalSpentCredits: observedSpentCredits,
      totalRemainingCredits: args.observedRemainingCredits,
      affectedBlockedEventSha256: sha256(
        JSON.stringify(reconciliation.affectedBlockedEvent),
      ),
    };
  } finally {
    try {
      if (lock) {
        try {
          await lock.close();
        } finally {
          await removeOwnedLedgerLock(lockPath);
        }
      }
    } finally {
      release();
    }
  }
}

export function resolveCodexCreditBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
  fallbackRunId?: string,
): CodexCreditBudgetConfig | undefined {
  const rawBudget = env.REMNIC_BENCH_CODEX_CREDIT_BUDGET?.trim();
  if (!rawBudget) return undefined;

  const budgetCredits = parsePositiveNumber(
    rawBudget,
    "REMNIC_BENCH_CODEX_CREDIT_BUDGET",
  );
  const reserveCredits = parseNonNegativeNumber(
    env.REMNIC_BENCH_CODEX_CREDIT_RESERVE?.trim() ?? "473",
    "REMNIC_BENCH_CODEX_CREDIT_RESERVE",
  );
  if (reserveCredits >= budgetCredits) {
    throw new Error(
      "REMNIC_BENCH_CODEX_CREDIT_RESERVE must be smaller than REMNIC_BENCH_CODEX_CREDIT_BUDGET",
    );
  }
  if (reserveCredits < MAX_BOUNDED_CALL_CREDITS) {
    throw new Error(
      `REMNIC_BENCH_CODEX_CREDIT_RESERVE must be at least ${MAX_BOUNDED_CALL_CREDITS} credits ` +
        "to cover the conservative maximum cost of the one serialized in-flight call",
    );
  }

  const ledgerPath = path.resolve(
    expandHomeRelativePath(
      env.REMNIC_BENCH_CODEX_CREDIT_LEDGER?.trim() ||
        ".remnic/bench/codex-credit-ledger.json",
    ),
  );
  const runId = parseOptionalRunId(env.REMNIC_BENCH_RUN_ID) ?? parseOptionalRunId(fallbackRunId);
  return {
    budgetCredits,
    reserveCredits,
    ledgerPath,
    allowSol: /^(?:1|true|yes|on)$/i.test(
      env.REMNIC_BENCH_CODEX_ALLOW_SOL?.trim() ?? "",
    ),
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
  try {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    lock = await acquireLedgerLock(lockPath);
    assertModelAllowed(args.model, args.config);
    const ledger = await readLedger(args.config);
    if (ledger.blockedReason) {
      throw new Error(
        `Codex credit ledger is blocked pending manual reconciliation: ${ledger.blockedReason}`,
      );
    }
    const usableCredits = args.config.budgetCredits - args.config.reserveCredits;
    const dispatchHeadroom = usableCredits - ledger.spentCredits;
    if (dispatchHeadroom < MAX_BOUNDED_CALL_CREDITS) {
      throw new Error(
        `Codex credit budget cannot safely dispatch another call: ${ledger.spentCredits.toFixed(3)} spent; ` +
          `${dispatchHeadroom.toFixed(3)} remains below the ${usableCredits.toFixed(3)} planned-spend ceiling, ` +
          `but ${MAX_BOUNDED_CALL_CREDITS.toFixed(3)} credits of worst-case call headroom are required.`,
      );
    }

    await writeLockState(lock, "in-flight");
    dispatchStarted = true;
    let result: Awaited<ReturnType<typeof args.run>>;
    try {
      result = await args.run();
    } catch (error) {
      if (error instanceof CodexCreditDispatchError) {
        await writeLockState(lock, "settled");
        accountingSettled = true;
      } else {
        const blockedLedger: CodexCreditLedger = {
          ...ledger,
          blockedReason: error instanceof CodexCreditAccountingError
            ? error.message
            : `Codex dispatch outcome is unknown after an unexpected error: ${safeErrorMessage(error)}`,
        };
        await writeLedger(args.config.ledgerPath, blockedLedger);
        await writeLockState(lock, "settled");
        accountingSettled = true;
      }
      throw error;
    }
    const credits = calculateCodexCredits(args.model, result.usage);
    const nextSpent = ledger.spentCredits + credits;
    const nextLedger: CodexCreditLedger = {
      ...ledger,
      spentCredits: nextSpent,
      entries: [
        ...ledger.entries,
        {
          at: new Date().toISOString(),
          model: args.model,
          credits,
          ...(args.config.runId ? { runId: args.config.runId } : {}),
          ...result.usage,
        },
      ],
    };
    await writeLedger(args.config.ledgerPath, nextLedger);
    await writeLockState(lock, "settled");
    accountingSettled = true;
    args.onUsagePersisted?.(result.usage);
    if (nextSpent > usableCredits) {
      throw new Error(
        `Codex planned-spend ceiling exceeded by completed call: ${nextSpent.toFixed(3)} > ` +
          `${usableCredits.toFixed(3)} credits. Usage was persisted; stop the benchmark immediately.`,
      );
    }
    return result.value;
  } finally {
    try {
      if (lock) {
        try {
          await lock.close();
        } finally {
          if (!dispatchStarted || accountingSettled) {
            await removeOwnedLedgerLock(lockPath);
          }
        }
      }
    } finally {
      release();
    }
  }
}

async function acquireLedgerLock(
  lockPath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockPath);
      if (
        !owner ||
        isProcessAlive(owner.pid) ||
        owner.phase === "in-flight"
      ) {
        throw new Error(
          `Codex credit ledger is locked${owner?.phase === "in-flight" ? " with unreconciled in-flight usage" : " by another benchmark process"} ` +
            `(${lockPath}); refusing credit spend.`,
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
      throw error;
    }
  }
  throw new Error(`Unable to acquire Codex credit ledger lock (${lockPath})`);
}

async function readLockOwner(
  lockPath: string,
): Promise<{ pid: number; phase: LedgerLockPhase } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockOwnerPath(lockPath), "utf8")) as {
      pid?: unknown;
      phase?: unknown;
    };
    if (
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      (parsed.phase !== "preflight" &&
        parsed.phase !== "in-flight" &&
        parsed.phase !== "settled")
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
  expectedOwner: { pid: number; phase: LedgerLockPhase },
): Promise<void> {
  try {
    await rmdir(lockHeldPath(lockPath));
  } catch (error) {
    throw new Error(
      `Codex credit ledger stale-lock reclamation is already claimed or incomplete ` +
        `(${lockPath}); refusing credit spend: ${safeErrorMessage(error)}`,
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
    throw new Error(
      `Codex credit ledger owner changed during stale-lock reclamation ` +
        `(${lockPath}); refusing credit spend.`,
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

async function writeLockState(
  lock: Awaited<ReturnType<typeof open>>,
  phase: LedgerLockPhase,
): Promise<void> {
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
      const cachedInputTokens = readOptionalCounter(
        event.usage.cached_input_tokens,
      );
      const reasoningOutputTokens = readOptionalCounter(
        event.usage.reasoning_output_tokens,
      );
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

export function calculateCodexCredits(
  model: string,
  usage: CodexCliNativeUsage,
): number {
  const rate = resolveRate(model);
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncached = usage.inputTokens - cached;
  return (
    (uncached * rate.input + cached * rate.cachedInput + usage.outputTokens * rate.output) /
    ONE_MILLION
  );
}

export async function buildCodexCreditReceipt(
  ledgerPath: string,
  runId?: string,
): Promise<CodexCreditReceipt> {
  const resolvedPath = path.resolve(expandHomeRelativePath(ledgerPath));
  const contents = await readFile(resolvedPath);
  const ledger = parseLedger(JSON.parse(contents.toString("utf8")) as Partial<CodexCreditLedger>);
  const normalizedRunId = parseOptionalRunId(runId);
  const reconciliations = ledger.reconciliations ?? [];
  const cumulative = summarizeLedgerEntries(ledger.entries, reconciliations);
  const runEntries = normalizedRunId
    ? ledger.entries.filter((entry) => entry.runId === normalizedRunId)
    : [];
  return {
    schemaVersion: 1,
    ledgerSha256: sha256(contents),
    budgetCredits: ledger.budgetCredits,
    reserveCredits: ledger.reserveCredits,
    plannedSpendCeilingCredits: ledger.budgetCredits - ledger.reserveCredits,
    totalSpentCredits: ledger.spentCredits,
    totalRemainingCredits: ledger.budgetCredits - ledger.spentCredits,
    blocked: ledger.blockedReason !== undefined,
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
      `No Codex credit rate is configured for model ${JSON.stringify(model)}; ` +
        "refusing to run under a bounded credit budget.",
    );
  }
  return match[1];
}

function assertModelAllowed(model: string, config: CodexCreditBudgetConfig): void {
  resolveRate(model);
  if (SOL_MODEL.test(model) && !config.allowSol) {
    throw new Error(
      "gpt-5.6-sol is disabled for bounded benchmark runs because it is the most expensive GPT-5.6 tier. " +
        "Use gpt-5.6-terra or gpt-5.6-luna, or explicitly set REMNIC_BENCH_CODEX_ALLOW_SOL=1.",
    );
  }
}

async function readLedger(config: CodexCreditBudgetConfig): Promise<CodexCreditLedger> {
  try {
    const parsed = parseLedger(
      JSON.parse(await readFile(config.ledgerPath, "utf8")) as Partial<CodexCreditLedger>,
    );
    if (
      parsed.budgetCredits !== config.budgetCredits ||
      parsed.reserveCredits !== config.reserveCredits
    ) {
      throw new Error("ledger schema or budget does not match this run");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Invalid Codex credit ledger at ${config.ledgerPath}: ${String(error)}`);
    }
    return {
      schemaVersion: 1,
      budgetCredits: config.budgetCredits,
      reserveCredits: config.reserveCredits,
      spentCredits: 0,
      entries: [],
    };
  }
}

function parseLedger(parsed: Partial<CodexCreditLedger>): CodexCreditLedger {
  const entryCredits = Array.isArray(parsed.entries)
    ? parsed.entries.reduce(
        (sum, entry) =>
          sum +
          (typeof (entry as Partial<CodexCreditLedgerEntry>)?.credits === "number"
            ? (entry as Partial<CodexCreditLedgerEntry>).credits ?? 0
            : 0),
        0,
      )
    : Number.NaN;
  const reconciliationCredits = parsed.reconciliations === undefined
    ? 0
    : Array.isArray(parsed.reconciliations)
      ? parsed.reconciliations.reduce(
          (sum, reconciliation) =>
            sum +
            (typeof (reconciliation as Partial<CodexCreditLedgerReconciliation>)?.credits === "number"
              ? (reconciliation as Partial<CodexCreditLedgerReconciliation>).credits ?? 0
              : 0),
          0,
        )
      : Number.NaN;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.budgetCredits !== "number" ||
    !Number.isFinite(parsed.budgetCredits) ||
    parsed.budgetCredits <= 0 ||
    typeof parsed.reserveCredits !== "number" ||
    !Number.isFinite(parsed.reserveCredits) ||
    parsed.reserveCredits < 0 ||
    parsed.reserveCredits >= parsed.budgetCredits ||
    typeof parsed.spentCredits !== "number" ||
    !Number.isFinite(parsed.spentCredits) ||
    parsed.spentCredits < 0 ||
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every(isLedgerEntry) ||
    (parsed.reconciliations !== undefined &&
      (!Array.isArray(parsed.reconciliations) ||
        !parsed.reconciliations.every((reconciliation) =>
          isLedgerReconciliationWithinBudget(reconciliation, parsed.budgetCredits),
        ))) ||
    Math.abs(entryCredits + reconciliationCredits - parsed.spentCredits) > 1e-9 ||
    (parsed.blockedReason !== undefined && typeof parsed.blockedReason !== "string")
  ) {
    throw new Error("ledger schema is invalid");
  }
  return parsed as CodexCreditLedger;
}

function isLedgerReconciliation(value: unknown): value is CodexCreditLedgerReconciliation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodexCreditLedgerReconciliation>;
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
    typeof candidate.priorRecordedSpentCredits === "number" &&
    Number.isFinite(candidate.priorRecordedSpentCredits) &&
    candidate.priorRecordedSpentCredits >= 0 &&
    typeof candidate.observedRemainingCredits === "number" &&
    Number.isFinite(candidate.observedRemainingCredits) &&
    candidate.observedRemainingCredits >= 0 &&
    typeof candidate.credits === "number" &&
    Number.isFinite(candidate.credits) &&
    candidate.credits >= 0 &&
    candidate.confirmations?.observedBalanceBelongsToOriginalBudget === true &&
    candidate.confirmations.noCreditsAddedOrRefunded === true &&
    candidate.confirmations.accountWideUnattributedChargeAccepted === true &&
    isValidStoredRunId(candidate.affectedBlockedEvent?.runId) &&
    typeof candidate.affectedBlockedEvent?.blockedReason === "string" &&
    candidate.affectedBlockedEvent.blockedReason.length > 0
  );
}

function isLedgerReconciliationWithinBudget(value: unknown, budget: unknown): boolean {
  return (
    typeof budget === "number" &&
    isLedgerReconciliation(value) &&
    value.originalBudgetCredits === budget &&
    value.observedRemainingCredits <= budget &&
    value.credits <= budget &&
    Math.abs(
      value.priorRecordedSpentCredits +
        value.credits +
        value.observedRemainingCredits -
        budget,
    ) <= 1e-9
  );
}

function isLedgerEntry(entry: unknown): entry is CodexCreditLedgerEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<CodexCreditLedgerEntry>;
  return (
    typeof candidate.at === "string" &&
    typeof candidate.model === "string" &&
    candidate.model.length > 0 &&
    typeof candidate.credits === "number" &&
    Number.isFinite(candidate.credits) &&
    candidate.credits >= 0 &&
    (candidate.runId === undefined || isValidStoredRunId(candidate.runId)) &&
    readCounter(candidate.inputTokens) !== undefined &&
    readCounter(candidate.cachedInputTokens) !== undefined &&
    readCounter(candidate.outputTokens) !== undefined &&
    readCounter(candidate.reasoningOutputTokens) !== undefined &&
    (candidate.cachedInputTokens ?? 0) <= (candidate.inputTokens ?? 0) &&
    isEntryCreditConsistent(candidate as CodexCreditLedgerEntry)
  );
}

function isEntryCreditConsistent(entry: CodexCreditLedgerEntry): boolean {
  try {
    return Math.abs(calculateCodexCredits(entry.model, entry) - entry.credits) <= 1e-9;
  } catch {
    return false;
  }
}

function summarizeLedgerEntries(
  entries: CodexCreditLedgerEntry[],
  reconciliations: CodexCreditLedgerReconciliation[] = [],
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
    credits:
      entries.reduce((sum, entry) => sum + entry.credits, 0) +
      reconciliations.reduce((sum, reconciliation) => sum + reconciliation.credits, 0),
    unattributedReconciliationCount: reconciliations.length,
    unattributedReconciledCredits: reconciliations.reduce(
      (sum, reconciliation) => sum + reconciliation.credits,
      0,
    ),
    ...totals,
    models: [...byModel.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([model, modelEntries]) => ({
        model,
        calls: modelEntries.length,
        credits: modelEntries.reduce((sum, entry) => sum + entry.credits, 0),
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
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
  );
}

async function writeLedger(filePath: string, ledger: CodexCreditLedger): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, filePath);
}

function readCounter(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function readOptionalCounter(value: unknown): number | undefined {
  return value === undefined ? 0 : readCounter(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
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
  },
};
