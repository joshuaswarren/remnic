import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseReconcileCodexCreditLedgerArgs } from "../../../../scripts/bench/reconcile-codex-credit-ledger.ts";
import { BenchmarkRunBlockReason, BenchmarkRunBlockedError } from "../benchmark-run-blocked-error.ts";
import {
  CodexCreditAccountingError,
  CodexCreditDispatchError,
  __codexCreditBudgetTestHooks,
  buildCodexCreditReceipt,
  calculateCodexBudgetUnits,
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
    parseCodexJsonlUsage(
      [
        "Reading additional input from stdin...",
        '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":1}}',
        '{"type":"turn.completed","usage":{"input_tokens":24669,"cached_input_tokens":4480,"output_tokens":20,"reasoning_output_tokens":9}}',
      ].join("\n")
    ),
    {
      inputTokens: 24_669,
      cachedInputTokens: 4_480,
      outputTokens: 20,
      reasoningOutputTokens: 9,
    }
  );
});

test("defaults omitted supplemental usage counters to zero", () => {
  assert.deepEqual(parseCodexJsonlUsage('{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}'), {
    inputTokens: 12,
    cachedInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 0,
  });
  assert.equal(
    parseCodexJsonlUsage(
      '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":"bad","output_tokens":3}}'
    ),
    undefined
  );
});

test("prices GPT-5.6 tiers using uncached, cached, and output rates", () => {
  assert.equal(calculateCodexBudgetUnits("gpt-5.6-luna", usage), 3.55);
  assert.equal(calculateCodexCredits("gpt-5.6-sol", usage), 17.75);
  assert.equal(calculateCodexCredits("gpt-5.6-terra", usage), 8.875);
  assert.equal(calculateCodexCredits("gpt-5.6-luna", usage), 3.55);
  assert.equal(calculateCodexCredits("gpt-5.5", usage), 17.75);
  assert.equal(calculateCodexCredits("gpt-5.3-codex", usage), 7.0875);
});

test("integer nanounit accounting remains reproducible across the reported three-call sequence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-nanounits-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false };
  const calls = [
    {
      model: "gpt-5.4-mini",
      usage: { inputTokens: 286_087, cachedInputTokens: 62_359, outputTokens: 41_558, reasoningOutputTokens: 0 },
      expected: 9.007877125,
    },
    {
      model: "gpt-5.6-luna",
      usage: { inputTokens: 314_314, cachedInputTokens: 314_281, outputTokens: 76_716, reasoningOutputTokens: 0 },
      expected: 12.2939275,
    },
    {
      model: "gpt-5.6-terra",
      usage: { inputTokens: 310_212, cachedInputTokens: 174_025, outputTokens: 98_061, reasoningOutputTokens: 0 },
      expected: 46.37221875,
    },
  ];
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    for (const call of calls) {
      assert.equal(calculateCodexBudgetUnits(call.model, call.usage), call.expected);
      assert.equal(
        await runWithinCodexCreditBudget({
          config,
          model: call.model,
          run: async () => ({ value: call.model, usage: call.usage }),
        }),
        call.model
      );
    }
    const afterThree = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      spentUnits: number;
      entries: Array<{ budgetUnits: number }>;
    };
    assert.equal(afterThree.spentUnits, 67.674023375);
    assert.equal(
      afterThree.entries.reduce((sum, entry) => sum + entry.budgetUnits, 0),
      67.674023375
    );
    assert.equal(
      await runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({
          value: "fourth dispatched",
          usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        }),
      }),
      "fourth dispatched"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    assert.throws(() => calculateCodexCredits(model, usage), /No Codex credit rate is configured/, model);
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
    (error: unknown) =>
      error instanceof BenchmarkRunBlockedError &&
      error.reason === BenchmarkRunBlockReason.InfrastructureUnavailable &&
      error.message === "Configured Codex model is unsupported by the bounded budget." &&
      !error.message.includes("gpt-5.3-codex-spark")
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
    (error: unknown) =>
      error instanceof BenchmarkRunBlockedError &&
      error.reason === BenchmarkRunBlockReason.InfrastructureUnavailable &&
      error.message === "Configured Codex model is disallowed by bounded-budget policy." &&
      !error.message.includes("gpt-5.6-sol")
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
      "ok"
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      spentUnits: number;
      entries: Array<Record<string, unknown>>;
    };
    assert.equal(ledger.spentUnits, 8.875);
    assert.equal(ledger.entries[0]?.budgetUnits, 8.875);
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
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError && error.reason === BenchmarkRunBlockReason.SpendHeadroomExhausted
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
    }
  );
  assert.throws(() => resolveCodexCreditBudgetConfig({ REMNIC_BENCH_CODEX_CREDIT_BUDGET: "abc" }), /finite number/);
  assert.throws(
    () =>
      resolveCodexCreditBudgetConfig({
        REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
        REMNIC_BENCH_CODEX_CREDIT_RESERVE: "299",
      }),
    /at least 300 credits/
  );
  assert.equal(
    resolveCodexCreditBudgetConfig({
      REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
      REMNIC_BENCH_CODEX_CREDIT_LEDGER: "~/.remnic/bench/credits.json",
    })?.ledgerPath,
    path.join(os.homedir(), ".remnic/bench/credits.json")
  );
  assert.equal(
    resolveCodexCreditBudgetConfig({ REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473" }, "generated-run-id")?.runId,
    "generated-run-id"
  );
  assert.equal(
    resolveCodexCreditBudgetConfig(
      {
        REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
        REMNIC_BENCH_RUN_ID: "explicit-run-id",
      },
      "generated-run-id"
    )?.runId,
    "explicit-run-id"
  );
  for (const explicitRunId of ["", "   "]) {
    assert.equal(
      resolveCodexCreditBudgetConfig(
        {
          REMNIC_BENCH_CODEX_CREDIT_BUDGET: "2473",
          REMNIC_BENCH_RUN_ID: explicitRunId,
        },
        "generated-run-id"
      )?.runId,
      "generated-run-id"
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
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.SpendCeilingExceeded &&
        error.message === "Codex planned-spend ceiling was exceeded by committed usage."
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      spentUnits: number;
      entries: unknown[];
    };
    assert.equal(ledger.spentUnits, 500);
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
      { mode: 0o600 }
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
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.SpendHeadroomExhausted &&
        error.message === "Codex credit budget lacks conservative dispatch headroom."
    );
    assert.equal(called, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the exact 300-unit boundary dispatches while a one-nanounit shortfall fails closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-boundary-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false };
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    const ledger = {
      schemaVersion: 1,
      budgetCredits: 2_473,
      reserveCredits: 473,
      spentCredits: 1_700,
      entries: [
        {
          at: "2026-07-15T00:00:00.000Z",
          model: "gpt-5.6-luna",
          credits: 1_700,
          inputTokens: 68_000_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
      ],
    };
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    assert.equal(
      await runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({
          value: "boundary allowed",
          usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        }),
      }),
      "boundary allowed"
    );

    ledger.budgetCredits = 2_472.999999999;
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    await assert.rejects(
      runWithinCodexCreditBudget({
        config: { ...config, budgetCredits: 2_472.999999999 },
        model: "gpt-5.6-luna",
        run: async () => ({ value: "no", usage }),
      }),
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError && error.reason === BenchmarkRunBlockReason.SpendHeadroomExhausted
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt or budget-mismatched ledgers fail terminally without exposing paths or contents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-secret-ledger-"));
  const ledgerPath = path.join(directory, "token=secret-ledger.json");
  const config = { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false };
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    for (const contents of [
      "token=secret-ledger invalid json\n",
      `${JSON.stringify({ schemaVersion: 1, budgetCredits: 2_000, reserveCredits: 473, spentCredits: 0, entries: [] })}\n`,
    ]) {
      await writeFile(ledgerPath, contents, { mode: 0o600 });
      await assert.rejects(
        runWithinCodexCreditBudget({ config, model: "gpt-5.6-luna", run: async () => ({ value: "no", usage }) }),
        (error: unknown) =>
          error instanceof BenchmarkRunBlockedError &&
          error.reason === BenchmarkRunBlockReason.ManualReconciliationRequired &&
          error.message === "Codex credit ledger is invalid or incompatible with this run." &&
          !error.message.includes(directory) &&
          !error.message.includes("secret-ledger") &&
          error.cause instanceof Error &&
          error.cause.message.includes(ledgerPath)
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-dispatch ledger setup failures are sanitized terminal infrastructure errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-secret-setup-"));
  const ledgerPath = path.join(directory, "token=secret-setup.json");
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    __codexCreditBudgetTestHooks.failNextLedgerSetup();
    await assert.rejects(
      runWithinCodexCreditBudget({
        config: { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false },
        model: "gpt-5.6-luna",
        run: async () => ({ value: "no", usage }),
      }),
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.InfrastructureUnavailable &&
        error.message === "Codex ledger infrastructure is unavailable." &&
        !error.message.includes(directory) &&
        error.cause instanceof Error &&
        error.cause.message.includes(ledgerPath)
    );
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
      { mode: 0o600 }
    );
    const receipt = await buildCodexCreditReceipt(ledgerPath, "run-a");
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.plannedSpendCeilingUnits, 2_000);
    assert.equal(receipt.totalSpentUnits, 12.425);
    assert.equal(receipt.blocked, true);
    assert.equal(receipt.cumulative.calls, 2);
    assert.equal(receipt.run?.budgetUnits, 12.425);
    assert.deepEqual(
      receipt.run?.models.map((model) => model.model),
      ["gpt-5.6-luna", "gpt-5.6-terra"]
    );
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
      { mode: 0o600 }
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
      { mode: 0o600 }
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
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.ManualReconciliationRequired &&
        error.message === "Codex usage accounting is uncertain; manual reconciliation is required."
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
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.ManualReconciliationRequired &&
        error.message === "Codex credit ledger requires manual reconciliation."
    );
    assert.equal(called, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1 migration can add entries before its first blocked-event reconciliation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-v1-lifecycle-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = {
    budgetCredits: 2_473,
    reserveCredits: 473,
    ledgerPath,
    allowSol: false,
    runId: "run-v1-lifecycle",
  };
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
      })}\n`,
      { mode: 0o600 }
    );
    assert.equal(
      await runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "migrated completion", usage }),
      }),
      "migrated completion"
    );
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => {
          throw new CodexCreditAccountingError("missing usage after migrated completion");
        },
      }),
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.ManualReconciliationRequired
    );
    const blockedContents = await readFile(ledgerPath);
    const blockedSha256 = createHash("sha256").update(blockedContents).digest("hex");
    const reconciliation = await reconcileCodexCreditLedger({
      ledgerPath,
      priorLedgerSha256: blockedSha256,
      beforeAccountBalance: "2500.1250000000",
      afterAccountBalance: "2500.1250000000",
      affectedRunId: "run-v1-lifecycle",
      sameAccountConfirmed: true,
      snapshotsBracketBlockedEventConfirmed: true,
      balanceSettledConfirmed: true,
      noCreditsAddedOrRefundedConfirmed: true,
    });
    assert.equal(reconciliation.priorRecordedSpentUnits, 3.55);
    const receipt = await buildCodexCreditReceipt(ledgerPath, "run-v1-lifecycle");
    assert.equal(receipt.totalSpentUnits, 3.55);
    assert.equal(receipt.cumulative.accountBalanceResolutionCount, 1);
    const committed = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      migrationWitnessV1: { source: string };
      resolutions: Array<{ priorEntryCount: number; priorLedgerSha256: string }>;
    };
    assert.equal(committed.resolutions[0]?.priorEntryCount, 1);
    assert.notEqual(
      committed.resolutions[0]?.priorLedgerSha256,
      createHash("sha256").update(committed.migrationWitnessV1.source).digest("hex")
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("equal account balances migrate v1 and clear a block without changing local spend", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-zero-delta-"));
  const ledgerPath = path.join(directory, "ledger.json");
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          budgetCredits: 2_473,
          reserveCredits: 473,
          spentCredits: 500.4525625,
          entries: [
            {
              at: "2026-07-15T00:00:00.000Z",
              model: "gpt-5.6-luna",
              runId: "run-a",
              credits: 500.4525625,
              inputTokens: 200_181_025,
              cachedInputTokens: 200_181_025,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
          ],
          blockedReason: "missing terminal usage",
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    const before = await readFile(ledgerPath);
    const priorLedgerSha256 = createHash("sha256").update(before).digest("hex");
    __codexCreditBudgetTestHooks.failNextSettledLockWrite();
    const receipt = await reconcileCodexCreditLedger({
      ledgerPath,
      priorLedgerSha256,
      beforeAccountBalance: "2500.1250000000",
      afterAccountBalance: "2500.1250000000",
      affectedRunId: "run-a",
      sameAccountConfirmed: true,
      snapshotsBracketBlockedEventConfirmed: true,
      balanceSettledConfirmed: true,
      noCreditsAddedOrRefundedConfirmed: true,
    });
    assert.equal(receipt.observedAccountDebit, "0");
    assert.equal(receipt.localBudgetChargeUnits, 0);
    assert.equal(receipt.totalSpentUnits, 500.4525625);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<string, unknown>;
    assert.equal(ledger.schemaVersion, 2);
    assert.equal(ledger.spentUnits, 500.4525625);
    assert.equal(ledger.blockedEvent, undefined);
    assert.equal(ledger.migratedFromV1Sha256, priorLedgerSha256);
    const publicReceipt = await buildCodexCreditReceipt(ledgerPath, "run-a");
    assert.equal(publicReceipt.totalSpentUnits, 500.4525625);
    assert.equal(publicReceipt.cumulative.accountBalanceResolutionCount, 1);
    assert.equal(publicReceipt.cumulative.conservativeResolutionChargeUnits, 0);
    const validV2 = await readFile(ledgerPath, "utf8");
    assert.equal(receipt.ledgerSha256, createHash("sha256").update(validV2).digest("hex"));
    const sameTimestampEntry = JSON.parse(validV2) as {
      spentUnits: number;
      entries: Array<Record<string, unknown>>;
      resolutions: Array<{ at: string; priorEntryCount: number }>;
    };
    const firstResolution = sameTimestampEntry.resolutions[0];
    assert.ok(firstResolution);
    sameTimestampEntry.entries.push({
      at: firstResolution.at,
      model: "gpt-5.6-luna",
      runId: "run-after-resolution",
      budgetUnits: 3.55,
      ...usage,
    });
    sameTimestampEntry.spentUnits += 3.55;
    await writeFile(ledgerPath, `${JSON.stringify(sameTimestampEntry, null, 2)}\n`, { mode: 0o600 });
    const sameTimestampReceipt = await buildCodexCreditReceipt(ledgerPath);
    assert.equal(sameTimestampReceipt.totalSpentUnits, 504.0025625);
    assert.equal(firstResolution.priorEntryCount, 1);
    await writeFile(ledgerPath, validV2, { mode: 0o600 });
    const forgedSpend = JSON.parse(validV2) as {
      resolutions: Array<{ priorRecordedSpentUnits: number; priorLedgerSha256: string }>;
    };
    const forgedSpendResolution = forgedSpend.resolutions[0];
    assert.ok(forgedSpendResolution);
    forgedSpendResolution.priorRecordedSpentUnits += 1;
    await writeFile(ledgerPath, `${JSON.stringify(forgedSpend)}\n`, { mode: 0o600 });
    await assert.rejects(buildCodexCreditReceipt(ledgerPath), /ledger schema is invalid/);
    const forgedHash = JSON.parse(validV2) as {
      migratedFromV1Sha256: string;
      resolutions: Array<{ priorLedgerSha256: string }>;
    };
    const forgedHashResolution = forgedHash.resolutions[0];
    assert.ok(forgedHashResolution);
    forgedHashResolution.priorLedgerSha256 = "f".repeat(64);
    forgedHash.migratedFromV1Sha256 = "f".repeat(64);
    await writeFile(ledgerPath, `${JSON.stringify(forgedHash)}\n`, { mode: 0o600 });
    await assert.rejects(buildCodexCreditReceipt(ledgerPath), /ledger schema is invalid/);
    await writeFile(ledgerPath, validV2, { mode: 0o600 });
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    await assert.rejects(stat(`${ledgerPath}.lock`), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("positive account-wide debit charges 300 local units and requires exclusivity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-positive-delta-"));
  const ledgerPath = path.join(directory, "ledger.json");
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
      { mode: 0o600 }
    );
    const before = await readFile(ledgerPath);
    const base = {
      ledgerPath,
      priorLedgerSha256: createHash("sha256").update(before).digest("hex"),
      beforeAccountBalance: "2500.1250000000",
      afterAccountBalance: "2498.6250000000",
      affectedRunId: "run-a",
      sameAccountConfirmed: true as const,
      snapshotsBracketBlockedEventConfirmed: true as const,
      balanceSettledConfirmed: true as const,
      noCreditsAddedOrRefundedConfirmed: true as const,
    };
    await assert.rejects(reconcileCodexCreditLedger(base), /positive account-wide debit requires/);
    assert.deepEqual(await readFile(ledgerPath), before);
    const receipt = await reconcileCodexCreditLedger({ ...base, noInterveningCodexActivityConfirmed: true });
    assert.equal(receipt.observedAccountDebit, "1.5");
    assert.equal(receipt.localBudgetChargeUnits, 300);
    assert.equal(receipt.totalSpentUnits, 300);
    const publicReceipt = await buildCodexCreditReceipt(ledgerPath, "run-a");
    assert.equal(publicReceipt.totalSpentUnits, 300);
    assert.equal(publicReceipt.cumulative.accountBalanceResolutionCount, 1);
    assert.equal(publicReceipt.cumulative.conservativeResolutionChargeUnits, 300);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("balance increases and insufficient positive-delta headroom fail without mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-reject-delta-"));
  const ledgerPath = path.join(directory, "ledger.json");
  try {
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        budgetCredits: 2_473,
        reserveCredits: 473,
        spentCredits: 1_800,
        entries: [
          {
            at: "2026-07-15T00:00:00.000Z",
            model: "gpt-5.6-luna",
            credits: 1_800,
            inputTokens: 72_000_000,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        ],
        blockedReason: "unknown usage",
      })}\n`,
      { mode: 0o600 }
    );
    const before = await readFile(ledgerPath);
    const base = {
      ledgerPath,
      priorLedgerSha256: createHash("sha256").update(before).digest("hex"),
      affectedRunId: "run-a",
      sameAccountConfirmed: true as const,
      snapshotsBracketBlockedEventConfirmed: true as const,
      balanceSettledConfirmed: true as const,
      noCreditsAddedOrRefundedConfirmed: true as const,
      noInterveningCodexActivityConfirmed: true as const,
    };
    await assert.rejects(
      reconcileCodexCreditLedger({ ...base, beforeAccountBalance: "10", afterAccountBalance: "11" }),
      /exceeds before/
    );
    await assert.rejects(
      reconcileCodexCreditLedger({ ...base, beforeAccountBalance: "11", afterAccountBalance: "10" }),
      /only 200 remain/
    );
    assert.deepEqual(await readFile(ledgerPath), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciliation CLI parses exact balances and confirmations", () => {
  const parsed = parseReconcileCodexCreditLedgerArgs([
    "--ledger",
    "/tmp/ledger.json",
    "--prior-ledger-sha256",
    "a".repeat(64),
    "--before-account-balance",
    "2500.1250000000",
    "--after-account-balance",
    "2500.1250000000",
    "--affected-run-id",
    "run-a",
    "--confirm-same-account",
    "--confirm-snapshots-bracket-event",
    "--confirm-balance-settled",
    "--confirm-no-credit-additions-or-refunds",
  ]);
  assert.equal(parsed.beforeAccountBalance, "2500.1250000000");
  assert.equal(parsed.afterAccountBalance, "2500.1250000000");
  assert.equal(parsed.noInterveningCodexActivityConfirmed, undefined);
});

test("reconciliation CLI help documents every guard without touching a ledger", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-reconcile-help-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const sentinel = "private ledger sentinel\n";
  try {
    await writeFile(ledgerPath, sentinel, { mode: 0o600 });
    const scriptPath = path.resolve(import.meta.dirname, "../../../../scripts/bench/reconcile-codex-credit-ledger.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--help", "--ledger", ledgerPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    for (const flag of [
      "--ledger",
      "--prior-ledger-sha256",
      "--before-account-balance",
      "--after-account-balance",
      "--affected-run-id",
      "--confirm-same-account",
      "--confirm-snapshots-bracket-event",
      "--confirm-balance-settled",
      "--confirm-no-credit-additions-or-refunds",
      "--confirm-no-intervening-codex-activity",
    ]) {
      assert.match(result.stdout, new RegExp(flag));
    }
    assert.match(result.stdout, /not attribution to the failed call/);
    assert.match(result.stdout, /Local token-rate budget units remain separate/);
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
    const dispatchError = new CodexCreditDispatchError("token=secret-dispatch executable not found");
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => {
          throw dispatchError;
        },
      }),
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.InfrastructureUnavailable &&
        error.message === "Codex CLI infrastructure was unavailable before dispatch." &&
        !error.message.includes("secret-dispatch") &&
        error.cause === dispatchError
    );
    await assert.rejects(readFile(ledgerPath, "utf8"), { code: "ENOENT" });
    assert.equal(
      await runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "retry succeeded", usage }),
      }),
      "retry succeeded"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-commit lock-state and cleanup failures cannot turn a committed completion into a failed call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-post-commit-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false };
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    __codexCreditBudgetTestHooks.failNextSettledLockWrite();
    __codexCreditBudgetTestHooks.failNextOwnedLockRemoval();
    assert.equal(
      await runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "committed", usage }),
      }),
      "committed"
    );
    const contents = await readFile(ledgerPath);
    const ledger = JSON.parse(contents.toString("utf8")) as { spentUnits: number; entries: unknown[] };
    assert.equal(ledger.spentUnits, 3.55);
    assert.equal(ledger.entries.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    __codexCreditBudgetTestHooks.resetQueue();
  }
});

test("the first uncertain accounting failure persists a block and throws a terminal error with the original cause", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-unknown-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = { budgetCredits: 2_473, reserveCredits: 473, ledgerPath, allowSol: false };
  __codexCreditBudgetTestHooks.resetQueue();
  try {
    const transportError = new CodexCreditAccountingError("token=secret-accounting terminal usage missing");
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => {
          throw transportError;
        },
      }),
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.ManualReconciliationRequired &&
        error.message === "Codex usage accounting is uncertain; manual reconciliation is required." &&
        !error.message.includes("secret-accounting") &&
        error.cause === transportError
    );
    await assert.rejects(readFile(`${ledgerPath}.lock`, "utf8"), { code: "ENOENT" });
    const blockedLedger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      blockedEvent?: { runId?: string; model?: string; reason?: string };
    };
    assert.equal(blockedLedger.blockedEvent?.model, "gpt-5.6-luna");
    assert.match(blockedLedger.blockedEvent?.reason ?? "", /secret-accounting/);
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "unexpected", usage }),
      }),
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.ManualReconciliationRequired &&
        error.message === "Codex credit ledger requires manual reconciliation." &&
        !error.message.includes("secret-accounting")
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
      "reclaimed"
    );

    await writeTestLock(lockPath, process.pid, "preflight");
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "unexpected", usage }),
      }),
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.ResourceLocked &&
        error.message === "Codex credit ledger resource is locked." &&
        !error.message.includes(directory) &&
        error.cause instanceof Error &&
        error.cause.message.includes(directory)
    );

    await rm(lockPath, { recursive: true, force: true });
    await writeTestLock(lockPath, 2_147_483_647, "in-flight");
    await assert.rejects(
      runWithinCodexCreditBudget({
        config,
        model: "gpt-5.6-luna",
        run: async () => ({ value: "unexpected", usage }),
      }),
      (error: unknown) =>
        error instanceof BenchmarkRunBlockedError &&
        error.reason === BenchmarkRunBlockReason.ResourceLocked &&
        error.message === "Codex credit ledger resource is locked." &&
        !error.message.includes(directory)
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeTestLock(
  lockPath: string,
  pid: number,
  phase: "preflight" | "in-flight" | "settled"
): Promise<void> {
  await mkdir(path.join(lockPath, "held"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid, phase }), { mode: 0o600 });
}
