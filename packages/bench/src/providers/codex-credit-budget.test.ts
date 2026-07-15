import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexCreditAccountingError,
  CodexCreditDispatchError,
  __codexCreditBudgetTestHooks,
  buildCodexCreditReceipt,
  calculateCodexCredits,
  parseCodexJsonlUsage,
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
