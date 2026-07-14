import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
}

interface CodexCreditLedger {
  schemaVersion: 1;
  budgetCredits: number;
  reserveCredits: number;
  spentCredits: number;
  entries: CodexCreditLedgerEntry[];
}

export interface CodexCreditBudgetConfig {
  budgetCredits: number;
  reserveCredits: number;
  ledgerPath: string;
  allowSol: boolean;
}

const ONE_MILLION = 1_000_000;
const SOL_MODEL = /^gpt-5\.6-sol(?:-|$)/i;
const CREDIT_RATES: ReadonlyArray<[RegExp, CodexCreditRate]> = [
  [/^gpt-5\.6-sol(?:-|$)/i, { input: 125, cachedInput: 12.5, output: 750 }],
  [/^gpt-5\.6-terra(?:-|$)/i, { input: 62.5, cachedInput: 6.25, output: 375 }],
  [/^gpt-5\.6-luna(?:-|$)/i, { input: 25, cachedInput: 2.5, output: 150 }],
  [/^gpt-5\.5(?:-|$)/i, { input: 125, cachedInput: 12.5, output: 750 }],
  [/^gpt-5\.4-mini(?:-|$)/i, { input: 18.75, cachedInput: 1.875, output: 113 }],
  [/^gpt-5\.4(?:-|$)/i, { input: 62.5, cachedInput: 6.25, output: 375 }],
  [/^gpt-5\.3-codex(?:-|$)/i, { input: 43.75, cachedInput: 4.375, output: 350 }],
  [/^gpt-5\.2(?:-|$)/i, { input: 43.75, cachedInput: 4.375, output: 350 }],
];

let completionQueue: Promise<void> = Promise.resolve();

export function resolveCodexCreditBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
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

  const ledgerPath = path.resolve(
    env.REMNIC_BENCH_CODEX_CREDIT_LEDGER?.trim() ||
      ".remnic/bench/codex-credit-ledger.json",
  );
  return {
    budgetCredits,
    reserveCredits,
    ledgerPath,
    allowSol: /^(?:1|true|yes|on)$/i.test(
      env.REMNIC_BENCH_CODEX_ALLOW_SOL?.trim() ?? "",
    ),
  };
}

export async function runWithinCodexCreditBudget<T>(args: {
  config: CodexCreditBudgetConfig | undefined;
  model: string;
  run: () => Promise<{ value: T; usage: CodexCliNativeUsage }>;
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
  try {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Codex credit ledger is locked by another benchmark process (${lockPath}); ` +
            "refusing concurrent credit spend.",
        );
      }
      throw error;
    }
    assertModelAllowed(args.model, args.config);
    const ledger = await readLedger(args.config);
    const usableCredits = args.config.budgetCredits - args.config.reserveCredits;
    if (ledger.spentCredits >= usableCredits) {
      throw new Error(
        `Codex credit budget exhausted: ${ledger.spentCredits.toFixed(3)} spent; ` +
          `${usableCredits.toFixed(3)} usable after the ${args.config.reserveCredits.toFixed(3)} safety reserve.`,
      );
    }

    const result = await args.run();
    const credits = calculateCodexCredits(args.model, result.usage);
    const nextSpent = ledger.spentCredits + credits;
    if (nextSpent > args.config.budgetCredits) {
      throw new Error(
        `Codex credit budget exceeded by completed call: ${nextSpent.toFixed(3)} > ` +
          `${args.config.budgetCredits.toFixed(3)} credits. Stop the benchmark immediately.`,
      );
    }

    const nextLedger: CodexCreditLedger = {
      ...ledger,
      spentCredits: nextSpent,
      entries: [
        ...ledger.entries,
        {
          at: new Date().toISOString(),
          model: args.model,
          credits,
          ...result.usage,
        },
      ],
    };
    await writeLedger(args.config.ledgerPath, nextLedger);
    return result.value;
  } finally {
    if (lock) {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
    release();
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
      const parsed = {
        inputTokens: readCounter(event.usage.input_tokens),
        cachedInputTokens: readCounter(event.usage.cached_input_tokens),
        outputTokens: readCounter(event.usage.output_tokens),
        reasoningOutputTokens: readCounter(event.usage.reasoning_output_tokens),
      };
      if (Object.values(parsed).every((value) => value !== undefined)) {
        usage = parsed as CodexCliNativeUsage;
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
    const parsed = JSON.parse(await readFile(config.ledgerPath, "utf8")) as Partial<CodexCreditLedger>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.budgetCredits !== config.budgetCredits ||
      parsed.reserveCredits !== config.reserveCredits ||
      typeof parsed.spentCredits !== "number" ||
      !Number.isFinite(parsed.spentCredits) ||
      parsed.spentCredits < 0 ||
      !Array.isArray(parsed.entries)
    ) {
      throw new Error("ledger schema or budget does not match this run");
    }
    return parsed as CodexCreditLedger;
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

export const __codexCreditBudgetTestHooks = {
  resetQueue: () => {
    completionQueue = Promise.resolve();
  },
};
