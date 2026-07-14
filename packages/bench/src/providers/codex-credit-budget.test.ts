import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __codexCreditBudgetTestHooks,
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

test("prices GPT-5.6 tiers using uncached, cached, and output rates", () => {
  assert.equal(calculateCodexCredits("gpt-5.6-sol", usage), 17.75);
  assert.equal(calculateCodexCredits("gpt-5.6-terra", usage), 8.875);
  assert.equal(calculateCodexCredits("gpt-5.6-luna", usage), 3.55);
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

test("bounded runs persist exact usage and stop at the safety-reserve boundary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-credit-ledger-"));
  const ledgerPath = path.join(directory, "ledger.json");
  const config = {
    budgetCredits: 9.875,
    reserveCredits: 1,
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
      /budget exhausted/,
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
});
