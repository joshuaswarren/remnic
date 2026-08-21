import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { recordWorkProductLedgerEntry } from "../src/work-product-ledger.js";

async function buildWorkProductRecallHarness(options: {
  workProductRecallEnabled: boolean;
  recallSectionEnabled?: boolean;
}) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-recall-"));
  await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-readme-reuse",
      recordedAt: "2026-03-07T23:29:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "artifact",
      action: "created",
      scope: "README.md",
      summary: "Created a public README contributor guide ready for future reuse.",
      artifactPath: "README.md",
      tags: ["docs", "reuse", "oss"],
    },
  });

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    creationMemoryEnabled: true,
    workProductRecallEnabled: options.workProductRecallEnabled,
    recallPipeline: [
      {
        id: "work-products",
        enabled: options.recallSectionEnabled ?? true,
        maxResults: 2,
        maxChars: 1400,
      },
    ],
  });

  return new Orchestrator(cfg);
}

test("recall injects work-product section when recovery retrieval is enabled", async () => {
  const orchestrator = await buildWorkProductRecallHarness({
    workProductRecallEnabled: true,
  });

  const context = await (orchestrator as any).recallInternal(
    "Can we reuse the README contributor guide we created for open source docs?",
    "agent:main",
  );

  assert.match(context, /## Work Products/);
  assert.match(context, /README contributor guide ready for future reuse/i);
  assert.match(context, /artifact/i);
});

test("recall omits work-product section when retrieval flag is disabled", async () => {
  const orchestrator = await buildWorkProductRecallHarness({
    workProductRecallEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Can we reuse the README contributor guide we created for open source docs?",
    "agent:main",
  );

  assert.equal(context.includes("## Work Products"), false);
});

test("recall omits work-product section when pipeline section is disabled", async () => {
  const orchestrator = await buildWorkProductRecallHarness({
    workProductRecallEnabled: true,
    recallSectionEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Can we reuse the README contributor guide we created for open source docs?",
    "agent:main",
  );

  assert.equal(context.includes("## Work Products"), false);
});
