import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseReconcileCodexCreditLedgerArgs } from "../../../../scripts/bench/reconcile-codex-credit-ledger.ts";
import {
  CodexCreditAccountingError,
  CodexCreditDispatchError,
  __codexCreditBudgetTestHooks,
  buildCodexCreditReceipt,
  calculateCodexCredits,
  parseCodexJsonlUsage,
  reconcileCodexCreditLedger,
  resolveCodexCreditBudgetConfig,
  runWithinCodexCreditBudget,
} from "./codex-credit-budget.ts";

const usage = {
  inputTokens: 100_000,
  cachedInputTokens: 20_000,
  outputTokens: 10_000,
  reasoningOutputTokens: 8_000,
};

test("parses the final native turn.completed usage event losslessly", () => {
  assert.deepEqual(
    parseCodexJsonlUsage([
      "Reading additional input from stdin...",
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":1}}',
      '{"type":"turn.completed","usage":{"input_tokens":24669,"cached_input_tokens":4480,"output_tokens":20,"reasoning_output_tokens":9}}',
    ].join("\n")),
    {
      inputTokens: 24_669,
      cachedInputTokens: 4_480,
      outputTokens: 20,
      reasoningOutputTokens: 9,
    },
  );
});

test("defaults omitted supplemental usage counters to zero", () => {
  assert.deepEqual(
    parseCodexJsonlUsage(
      '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}',
    ),
    {
      inputTokens: 12,
      cachedInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 0,
    },
  );
  assert.equal(
    parseCodexJsonlUsage(
      '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":"bad","output_tokens":3}}',
    ),
    undefined,
  );
});

test("prices GPT-5.6 tiers using uncached, cached, and output rates", () => {
  assert.equal(calculateCodexCredits("gpt-5.6-sol", usage), 17.75);
  assert.equal(calculateCodexCredits("gpt-5.6-terra", usage), 8.875);
  assert.equal(calculateCodexCredits("gpt-5.6-luna", usage), 3.55);
  assert.equal(calculateCodexCredits("gpt-5.5", usage), 17.75);
  assert.equal(calculateCodexCredits("gpt-5.3-codex", usage), 7.0875);
});

test("credit pricing fails closed for unlisted model variants", () => {
  for (const model of [
    "gpt-5.6-sol-preview",
    "gpt-5.6-terra-preview",
    "gpt-5.6-luna-preview",
    "gpt-5.5-cyber",
    "gpt-5.4-mini-preview",
    "gpt-5.4-pro",
    "gpt-5.3-codex-spark",
    "gpt-5.2-codex",
  ]) {
    assert.throws(
      () => calculateCodexCredits(model, usage),
      /No Codex credit rate is configured/,
      model,
    );
  }
});

test("bounded runs reject unlisted model variants before dispatch", async () => {
  __codexCreditBudgetTestHooks.resetQueue();
  let called = false;
  await assert.rejects(
    runWithinCodexCreditBudget({
      config: {
        budgetCredits: 2_473,
        reserveCredits: 473,
        ledgerPath: path.join(os.tmpdir(), "unused-variant-codex-ledger.json"),
        allowSol: false,
      },
      model: "gpt-5.3-codex-spark",
      run: async () => {
        called = true;
        return { value: "unexpected", usage };
      },
    }),
    /No Codex credit rate is configured/,
  );
  assert.equal(called, false);
});

test("bounded runs reject Sol unless explicitly opted in", async () => {
  __codexCreditBudgetTestHooks.resetQueue();
  await assert.rejects(
    runWithinCodexCreditBudget({
      config: {
        budgetCredits: 2_473,
        reserveCredits: 473,
        ledgerPath: path.join(os.tmpdir(), "unused-codex-ledger.json"),
        allowSol: false,
      },
      model: "gpt-5.6-sol",
      run: async () => ({ value: "unexpected", usage }),
    }),
    /gpt-5\.6-sol is disabled/,
  );
});

test("bounded runs persist exact usage and preserve worst-case headroom at the planned-spend boundary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-ledger-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = {
    budgetCredits: 608.874,
    reserveCredits: 300,
    ledgerPath,
    allowSol: false,
  };
  __codexCreditBudgetTestHooks.resetQueue();

  try {
    assert.equal(
      await runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-terra",
        run: async () => ({ value: "ok", usage }),
      }),
      "ok",
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      spentCredits: number;
      entries: Array<Record<string, unknown>>;
    };
    assert.equal(ledger.spentCredits, 8.875);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0]?.cachedInputTokens, 20_000);

    let called = false;
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-terra",
        run: async () => {
          called = true;
          return { value: "unexpected", usage };
        },
      }),
      /cannot safely dispatch another call/,
    );
    assert.equal(called, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("budget environment parsing uses the competition reserve and rejects invalid values", () => {
  assert.deepEqual(
    resolveCodexCreditBudgetConfig({
      REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
      REMNIC_BENCH_CODEX_CREDIT_LEDGER: "/tmp/remnic-ledger.json",
    }),
    {
      budgetCredits: 2_473,
      reserveCredits: 473,
      ledgerPath: "/tmp/remnic-ledger.json",
      allowSol: false,
    },
  );
  assert.throws(
    () => resolveCodexCreditBudgetConfig({ REMNIC_BENCH_CODEX_CREDIT_BUDGET: "abc" }),
    /finite number/,
  );
  assert.throws(
    () => resolveCodexCreditBudgetConfig({
      REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
      REMNIC_BENCH_CODEX_CREDIT_RESERVE: "299",
    }),
    /at least 300 credits/,
  );
  assert.equal(
    resolveCodexCreditBudgetConfig({
      REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
      REMNIC_BENCH_CODEX_CREDIT_LEDGER: "~/.remnic/bench/credits.json",
    })?.ledgerPath,
    path.join(os.homedir(), ".remnic/bench/credits.json"),
  );
  assert.equal(
    resolveCodexCreditBudgetConfig(
      { REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473" },
      "generated-run-id",
    )?.runId,
    "generated-run-id",
  );
  assert.equal(
    resolveCodexCreditBudgetConfig(
      {
        REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
        REMNIC_BENCH_RUN_ID: "explicit-run-id",
      },
      "generated-run-id",
    )?.runId,
    "explicit-run-id",
  );
  for (const explicitRunId of ["", "   "]) {
    assert.equal(
      resolveCodexCreditBudgetConfig(
        {
          REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
          REMNIC_BENCH_RUN_ID: explicitRunId,
        },
        "generated-run-id",
      )?.runId,
      "generated-run-id",
    );
  }
});

test("completed usage above the conservative call bound is persisted before the planned-spend stop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-overrun-"));
  const ledgerPath = path.join(directory, "ledger.json");
  let persistedUsage: typeof usage | undefined;
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    await assert.rejects(
      runWithinCodexCreditBudget({
        config: { budgetCredits: 600, reserveCredits: 300, ledgerPath, allowSol: false },
        model: "gpt-5.6-terra",
        onUsagePersisted: (completedUsage) => {
          persistedUsage = completedUsage;
        },
        run: async () => ({
          value: "charged",
          usage: {
            inputTokens: 8_000_000,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        }),
      }),
      /planned-spend ceiling exceeded.*Usage was persisted/,
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      spentCredits: number;
      entries: unknown[];
    };
    assert.equal(ledger.spentCredits, 500);
    assert.equal(ledger.entries.length, 1);
    assert.deepEqual(persistedUsage, {
      inputTokens: 8_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded runs reject before dispatch when worst-case headroom would cross planned spend", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-headroom-"));
  const ledgerPath = path.join(directory, "ledger.json");
  let called = false;
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        budgetCredits: 2_473,
        reserveCredits: 473,
        spentCredits: 1_700.001,
        entries: [
          {
            at: "2026-07-15T00:00:00.000Z",
            model: "gpt-5.6-luna",
            credits: 1_700.001,
            inputTokens: 68_000_040,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      runWithinCodexCreditBudget({
        config: { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false },
        model: "gpt-5.6-luna",
        run: async () => {
          called = true;
          return { value: "unexpected", usage };
        },
      }),
      /299\.999 remains.*300\.000 credits of worst-case call headroom/,
    );
    assert.equal(called, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credit receipt binds the private ledger without exposing paths or blocked reasons", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-receipt-"));
  const ledgerPath = path.join(directory, "private-ledger.json");
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        budgetCredits: 2_473,
        reserveCredits: 473,
        spentCredits: 12.425,
        blockedReason: "private reconciliation detail",
        entries: [
          { at: "2026-07-15T00:00:00.000Z", model: "gpt-5.6-luna", runId: "run-a", credits: 3.55, ...usage },
          { at: "2026-07-15T00:01:00.000Z", model: "gpt-5.6-terra", runId: "run-a", credits: 8.875, ...usage },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const receipt = await buildCodexCreditReceipt(ledgerPath, "run-a");
    assert.equal(receipt.plannedSpendCeilingCredits, 2_000);
    assert.equal(receipt.totalSpentCredits, 12.425);
    assert.equal(receipt.blocked, true);
    assert.equal(receipt.cumulative.calls, 2);
    assert.equal(receipt.run?.credits, 12.425);
    assert.deepEqual(receipt.run?.models.map((model) => model.model), [
      "gpt-5.6-luna",
      "gpt-5.6-terra",
    ]);
    assert.doesNotMatch(JSON.stringify(receipt), /private-ledger|private reconciliation detail/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credit receipt rejects token accounting that does not reproduce recorded credits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-invalid-entry-"));
  const ledgerPath = path.join(directory, "ledger.json");
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        budgetCredits: 2_473,
        reserveCredits: 473,
        spentCredits: 3.55,
        entries: [
          {
            at: "2026-07-15T00:00:00.000Z",
            model: "gpt-5.6-luna",
            credits: 3.55,
            inputTokens: 1,
            cachedInputTokens: 2,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(buildCodexCreditReceipt(ledgerPath), /ledger schema is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credit receipt rejects malformed reconciliation accounting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-invalid-reconciliation-"));
  const ledgerPath = path.join(directory, "ledger.json");
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        budgetCredits: 2_473,
        reserveCredits: 473,
        spentCredits: 1,
        entries: [],
        reconciliations: [
          {
            at: "2026-07-15T00:00:00.000Z",
            basis: "operator-observed-original-budget-balance",
            attribution: "benchmark-run-exact",
            priorLedgerSha256: "a".repeat(64),
            originalBudgetCredits: 2_473,
            priorRecordedSpentCredits: 0,
            observedRemainingCredits: 2_472,
            credits: 1,
            confirmations: {
              observedBalanceBelongsToOriginalBudget: true,
              noCreditsAddedOrRefunded: true,
              accountWideUnattributedChargeAccepted: true,
            },
            affectedBlockedEvent: {
              runId: "run-a",
              blockedReason: "unknown usage",
            },
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(buildCodexCreditReceipt(ledgerPath), /ledger schema is invalid/);
    const wrongBudget = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      reconciliations: Array<Record<string, unknown>>;
    };
    const reconciliation = wrongBudget.reconciliations[0];
    assert.ok(reconciliation);
    reconciliation.attribution = "account-wide-unattributed";
    reconciliation.originalBudgetCredits = 2_472;
    await writeFile(ledgerPath, `${JSON.stringify(wrongBudget)}\n`, { mode: 0o600 });
    await assert.rejects(buildCodexCreditReceipt(ledgerPath), /ledger schema is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown charged usage blocks the ledger until manual reconciliation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-blocked-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false };
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => {
          throw new CodexCreditAccountingError("missing terminal usage");
        },
      }),
      /missing terminal usage/,
    );
    let called = false;
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => {
          called = true;
          return { value: "unexpected", usage };
        },
      }),
      /blocked pending manual reconciliation/,
    );
    assert.equal(called, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciliation charges all unexplained account activity without per-run attribution", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-reconcile-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const blockedReason = "missing terminal usage after timeout";
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        budgetCredits: 2_473,
        reserveCredits: 473,
        spentCredits: 3.55,
        entries: [
          {
            at: "2026-07-15T00:00:00.000Z",
            model: "gpt-5.6-luna",
            runId: "smoke-run",
            credits: 3.55,
            ...usage,
          },
        ],
        blockedReason,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const before = await readFile(ledgerPath);
    const priorLedgerSha256 = createHash("sha256").update(before).digest("hex");
    const receipt = await reconcileCodexCreditLedger({
      ledgerPath,
      priorLedgerSha256,
      observedRemainingCredits: 2_468,
      originalBudgetBalanceConfirmed: true,
      noCreditsAddedOrRefundedConfirmed: true,
      accountWideUnattributedChargeAccepted: true,
      affectedRunId: "smoke-run",
    });

    assert.equal(receipt.priorLedgerSha256, priorLedgerSha256);
    assert.equal(receipt.attribution, "account-wide-unattributed");
    assert.equal(receipt.affectedRunId, "smoke-run");
    assert.equal(receipt.originalBudgetCredits, 2_473);
    assert.equal(receipt.priorRecordedSpentCredits, 3.55);
    assert.ok(Math.abs(receipt.unattributedCredits - 1.45) <= 1e-9);
    assert.equal(receipt.totalSpentCredits, 5);
    assert.equal(receipt.totalRemainingCredits, 2_468);
    assert.match(receipt.affectedBlockedEventSha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(blockedReason));
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      blockedReason?: string;
      spentCredits: number;
      reconciliations: Array<Record<string, unknown>>;
    };
    assert.equal(ledger.blockedReason, undefined);
    assert.equal(ledger.spentCredits, 5);
    assert.equal(ledger.reconciliations.length, 1);
    const reconciliation = ledger.reconciliations[0];
    assert.ok(reconciliation);
    assert.equal(reconciliation.attribution, "account-wide-unattributed");
    assert.equal(reconciliation.originalBudgetCredits, 2_473);
    assert.equal(reconciliation.priorRecordedSpentCredits, 3.55);
    assert.deepEqual(reconciliation.confirmations, {
      observedBalanceBelongsToOriginalBudget: true,
      noCreditsAddedOrRefunded: true,
      accountWideUnattributedChargeAccepted: true,
    });
    assert.deepEqual(reconciliation.affectedBlockedEvent, {
      runId: "smoke-run",
      blockedReason,
    });
    assert.equal("runId" in reconciliation, false);
    assert.equal("inputTokens" in reconciliation, false);
    assert.equal("model" in reconciliation, false);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    await assert.rejects(stat(`${ledgerPath}.lock`), { code: "ENOENT" });

    const publicReceipt = await buildCodexCreditReceipt(ledgerPath, "smoke-run");
    assert.equal(publicReceipt.cumulative.credits, 5);
    assert.equal(publicReceipt.cumulative.calls, 1);
    assert.equal(publicReceipt.cumulative.unattributedReconciliationCount, 1);
    assert.ok(
      Math.abs(publicReceipt.cumulative.unattributedReconciledCredits - 1.45) <= 1e-9,
    );
    assert.equal(publicReceipt.run?.credits, 3.55);
    assert.equal(publicReceipt.run?.unattributedReconciliationCount, 0);
    assert.equal(publicReceipt.run?.unattributedReconciledCredits, 0);
    assert.doesNotMatch(JSON.stringify(publicReceipt), new RegExp(blockedReason));

    assert.equal(
      await runWithinCodexCreditBudget({
        config: { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false },
        model: "gpt-5.6-luna",
        run: async () => ({ value: "continued", usage }),
      }),
      "continued",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciliation normalizes decimal roundoff without recording phantom spend", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-reconcile-roundoff-"));
  const ledgerPath = path.join(directory, "ledger.json");
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        budgetCredits: 2_473,
        reserveCredits: 473,
        spentCredits: 0.002,
        entries: [
          {
            at: "2026-07-15T00:00:00.000Z",
            model: "gpt-5.6-luna",
            runId: "roundoff-run",
            credits: 0.002,
            inputTokens: 80,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        ],
        blockedReason: "missing terminal usage after exact recorded spend",
      })}\n`,
      { mode: 0o600 },
    );
    const before = await readFile(ledgerPath);
    const receipt = await reconcileCodexCreditLedger({
      ledgerPath,
      priorLedgerSha256: createHash("sha256").update(before).digest("hex"),
      observedRemainingCredits: 2_472.998,
      originalBudgetBalanceConfirmed: true,
      noCreditsAddedOrRefundedConfirmed: true,
      accountWideUnattributedChargeAccepted: true,
      affectedRunId: "roundoff-run",
    });

    assert.equal(receipt.unattributedCredits, 0);
    assert.equal(receipt.totalSpentCredits, 0.002);
    assert.equal(receipt.totalRemainingCredits, 2_472.998);
    const publicReceipt = await buildCodexCreditReceipt(ledgerPath, "roundoff-run");
    assert.equal(publicReceipt.totalSpentCredits, 0.002);
    assert.equal(publicReceipt.cumulative.unattributedReconciledCredits, 0);
    assert.equal(publicReceipt.run?.credits, 0.002);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciliation fails closed without changing ledger bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-reconcile-reject-"));
  const ledgerPath = path.join(directory, "ledger.json");
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        budgetCredits: 2_473,
        reserveCredits: 473,
        spentCredits: 0,
        entries: [],
        blockedReason: "unknown usage",
      })}\n`,
      { mode: 0o600 },
    );
    const before = await readFile(ledgerPath);
    const hash = createHash("sha256").update(before).digest("hex");
    const base = {
      ledgerPath,
      priorLedgerSha256: hash,
      observedRemainingCredits: 2_470,
      originalBudgetBalanceConfirmed: true as const,
      noCreditsAddedOrRefundedConfirmed: true as const,
      accountWideUnattributedChargeAccepted: true as const,
      affectedRunId: "run-a",
    };
    await assert.rejects(
      reconcileCodexCreditLedger({ ...base, priorLedgerSha256: "0".repeat(64) }),
      /changed since operator observation/,
    );
    await assert.rejects(
      reconcileCodexCreditLedger({
        ...base,
        originalBudgetBalanceConfirmed: false as unknown as true,
      }),
      /original budget/,
    );
    await assert.rejects(
      reconcileCodexCreditLedger({
        ...base,
        noCreditsAddedOrRefundedConfirmed: false as unknown as true,
      }),
      /no credits were added or refunded/,
    );
    await assert.rejects(
      reconcileCodexCreditLedger({
        ...base,
        accountWideUnattributedChargeAccepted: false as unknown as true,
      }),
      /account-wide unattributed spend/,
    );
    await assert.rejects(
      reconcileCodexCreditLedger({ ...base, observedRemainingCredits: 2_474 }),
      /cannot exceed the ledger budget/,
    );
    assert.deepEqual(await readFile(ledgerPath), before);

    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        budgetCredits: 2_473,
        reserveCredits: 473,
        spentCredits: 3.55,
        entries: [
          {
            at: "2026-07-15T00:00:00.000Z",
            model: "gpt-5.6-luna",
            credits: 3.55,
            ...usage,
          },
        ],
        blockedReason: "unknown usage",
      })}\n`,
      { mode: 0o600 },
    );
    const exactBytes = await readFile(ledgerPath);
    await assert.rejects(
      reconcileCodexCreditLedger({
        ...base,
        priorLedgerSha256: createHash("sha256").update(exactBytes).digest("hex"),
        observedRemainingCredits: 2_471,
      }),
      /implies less spend than the ledger already records/,
    );
    assert.deepEqual(await readFile(ledgerPath), exactBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciliation CLI requires original-budget and account-wide charge acknowledgments", () => {
  const hash = "a".repeat(64);
  assert.throws(
    () =>
      parseReconcileCodexCreditLedgerArgs([
        "--ledger", "/tmp/ledger.json",
        "--prior-ledger-sha256", hash,
        "--observed-remaining-credits", "2468",
        "--affected-run-id", "smoke-run",
      ]),
    /--confirm-original-budget-balance is required/,
  );
  assert.throws(
    () =>
      parseReconcileCodexCreditLedgerArgs([
        "--ledger", "/tmp/ledger.json",
        "--prior-ledger-sha256", hash,
        "--observed-remaining-credits", "2468",
        "--affected-run-id", "smoke-run",
        "--confirm-original-budget-balance",
      ]),
    /--confirm-no-credit-additions-or-refunds is required/,
  );
  assert.throws(
    () =>
      parseReconcileCodexCreditLedgerArgs([
        "--ledger", "/tmp/ledger.json",
        "--prior-ledger-sha256", hash,
        "--observed-remaining-credits", "2468",
        "--affected-run-id", "smoke-run",
        "--confirm-original-budget-balance",
        "--confirm-no-credit-additions-or-refunds",
      ]),
    /including activity outside the affected benchmark call/,
  );
  assert.deepEqual(
    parseReconcileCodexCreditLedgerArgs([
      "--ledger", "/tmp/ledger.json",
      "--prior-ledger-sha256", hash,
      "--observed-remaining-credits", "2468",
      "--affected-run-id", "smoke-run",
      "--confirm-original-budget-balance",
      "--confirm-no-credit-additions-or-refunds",
      "--acknowledge-account-wide-unattributed-charge",
    ]),
    {
      ledgerPath: "/tmp/ledger.json",
      priorLedgerSha256: hash,
      observedRemainingCredits: 2_468,
      affectedRunId: "smoke-run",
      originalBudgetBalanceConfirmed: true,
      noCreditsAddedOrRefundedConfirmed: true,
      accountWideUnattributedChargeAccepted: true,
    },
  );
});

test("reconciliation CLI help documents every guard without touching a ledger", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-reconcile-help-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const sentinel = "private ledger sentinel\n";
  try {
    await writeFile(ledgerPath, sentinel, { mode: 0o600 });
    const scriptPath = path.resolve(
      import.meta.dirname,
      "../../../../scripts/bench/reconcile-codex-credit-ledger.ts",
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--help", "--ledger", ledgerPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const flag of [
      "--ledger",
      "--prior-ledger-sha256",
      "--observed-remaining-credits",
      "--affected-run-id",
      "--confirm-original-budget-balance",
      "--confirm-no-credit-additions-or-refunds",
      "--acknowledge-account-wide-unattributed-charge",
    ]) {
      assert.match(result.stdout, new RegExp(flag));
    }
    assert.match(result.stdout, /not attribution of the account-wide delta/);
    assert.match(result.stdout, /stop every other Codex session/);
    assert.equal(await readFile(ledgerPath, "utf8"), sentinel);
    assert.deepEqual((await stat(ledgerPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("confirmed pre-dispatch failures release the lock without blocking the ledger", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-dispatch-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false };
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => {
          throw new CodexCreditDispatchError("executable not found");
        },
      }),
      /executable not found/,
    );
    assert.equal(
      await runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "retry succeeded", usage }),
      }),
      "retry succeeded",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unexpected in-flight failures persist a blocked ledger and release the raw lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-unknown-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false };
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => {
          throw new Error("unexpected transport failure");
        },
      }),
      /unexpected transport failure/,
    );
    await assert.rejects(readFile(`${ledgerPath}.lock`, "utf8"), { code: "ENOENT" });
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "unexpected", usage }),
      }),
      /blocked pending manual reconciliation/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale dead-process locks are reclaimed but live locks fail closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-lock-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const lockPath = `${ledgerPath}.lock`;
  const config = { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false };
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    await writeTestLock(lockPath, 2_147_483_647, "preflight");
    assert.equal(
      await runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "reclaimed", usage }),
      }),
      "reclaimed",
    );

    await writeTestLock(lockPath, process.pid, "preflight");
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "unexpected", usage }),
      }),
      /locked by another benchmark process/,
    );

    await rm(lockPath, { recursive: true, force: true });
    await writeTestLock(lockPath, 2_147_483_647, "in-flight");
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "unexpected", usage }),
      }),
      /unreconciled in-flight usage/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeTestLock(
  lockPath: string,
  pid: number,
  phase: "preflight" | "in-flight" | "settled",
): Promise<void> {
  await mkdir(path.join(lockPath, "held"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({ pid, phase }),
    { mode: 0o600 },
  );
}
