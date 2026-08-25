/**
 * standing-memory-block.test.ts — issue #2971 foundation slice.
 *
 * Pins the prefix-cache contract:
 *  - the block is byte-identical across consecutive builds with an unchanged
 *    store (same entries), regardless of input order and of the evaluation
 *    instant (the clock classifies bands but never renders);
 *  - the volatility lint refuses clocks, dates, and counters at build time;
 *  - three-band layering (pinned full, fresh full, older compressed to a
 *    recognition hook) with a hook ledger that makes steady-state rebuilds
 *    free and lets a later model slice pre-seed hooks;
 *  - the mechanical trim fallback drops compressed lines from the tail and
 *    never a pinned line;
 *  - zero-diff: with the feature off (and even on, pre-wiring), the live
 *    recall output is byte-identical and contains no standing block.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import type { PluginConfig } from "./types.js";
import {
  buildStandingMemoryBlock,
  lintStandingBlockVolatility,
  parseRecallStandingBlock,
  parseStandingBlockFreshDays,
  parseStandingBlockMaxChars,
  standingHookLedgerKey,
  StandingBlockBudgetError,
  StandingBlockVolatilityError,
  type StandingMemoryEntry,
} from "./standing-memory-block.js";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

const PINNED: StandingMemoryEntry = {
  id: "p-core",
  description: "Deploys always go through the blue pipeline, never green.",
  pinned: true,
};
const PINNED2: StandingMemoryEntry = {
  id: "p-two",
  description: "Every release tag is signed with the release key.",
  pinned: true,
};
const FRESH: StandingMemoryEntry = {
  id: "f-recent",
  description: "The auth service owner is Priya.",
  lastChangedAt: "2026-08-20T09:00:00.000Z",
};
const OLD_LONG: StandingMemoryEntry = {
  id: "o-history",
  description:
    "The billing stack migrated off the legacy invoice service after the Q3 review " +
    "because duplicate charges surfaced twice and the team rebuilt invoicing around " +
    "the ledger event stream that the finance group already trusted.",
  lastChangedAt: "2025-11-01T00:00:00.000Z",
};

test("parseConfig: standing block keys default off with byte-identical behavior", () => {
  const base = { memoryDir: "/tmp/remnic-standing-config-test" };
  const parsed = parseConfig(base);
  assert.equal(parsed.recallStandingBlock, false, "absent → false");
  assert.equal(parsed.standingBlockFreshDays, 14);
  assert.equal(parsed.standingBlockMaxChars, 2048);
  assert.equal(parseConfig({ ...base, recallStandingBlock: false }).recallStandingBlock, false);
  assert.equal(parseConfig({ ...base, recallStandingBlock: 0 }).recallStandingBlock, false);
  assert.equal(parseConfig({ ...base, recallStandingBlock: "false" }).recallStandingBlock, false);
  assert.equal(parseConfig({ ...base, recallStandingBlock: true }).recallStandingBlock, true);
  assert.equal(parseConfig({ ...base, recallStandingBlock: 1 }).recallStandingBlock, true);
  assert.equal(parseConfig({ ...base, recallStandingBlock: "true" }).recallStandingBlock, true);
  assert.equal(parseStandingBlockFreshDays("30"), 30);
  assert.equal(parseStandingBlockMaxChars(1024), 1024);
  assert.throws(() => parseStandingBlockFreshDays(-1), /Invalid standingBlockFreshDays/);
  assert.throws(() => parseStandingBlockMaxChars(0), /Invalid standingBlockMaxChars/);
});

test("block is byte-identical across consecutive builds with an unchanged store", () => {
  const entries = [PINNED, FRESH, OLD_LONG];
  const first = buildStandingMemoryBlock({ entries, nowMs: NOW });
  const second = buildStandingMemoryBlock({ entries, nowMs: NOW });
  assert.equal(first.text, second.text);
  assert.equal(first.text, buildStandingMemoryBlock({ entries: [...entries].reverse(), nowMs: NOW }).text);
  assert.equal(
    first.text,
    buildStandingMemoryBlock({ entries, nowMs: NOW + 3_600_000, ledger: first.ledger }).text,
    "the evaluation clock must never render into the block",
  );
  assert.ok(first.text.startsWith("## Standing Memory (Remnic)"));
});

test("volatility lint refuses dates, clocks, relative dates, and counters at build time", () => {
  assert.deepEqual(lintStandingBlockVolatility("shipped 2026-08-01"), [
    { kind: "iso-date", token: "2026-08-01" },
  ]);
  assert.deepEqual(lintStandingBlockVolatility("standup at 10:30 sharp"), [
    { kind: "clock-time", token: "10:30" },
  ]);
  assert.deepEqual(lintStandingBlockVolatility("fixed yesterday"), [
    { kind: "relative-date", token: "yesterday" },
  ]);
  assert.deepEqual(lintStandingBlockVolatility("index has memories: 42 rows"), [
    { kind: "counter", token: "memories: 42" },
  ]);
  assert.deepEqual(lintStandingBlockVolatility("quiet, stable line"), []);

  const refuses = (entry: StandingMemoryEntry, kind: string) => {
    assert.throws(
      () => buildStandingMemoryBlock({ entries: [entry], nowMs: NOW }),
      (err: unknown) => {
        assert.ok(err instanceof StandingBlockVolatilityError);
        assert.equal(err.matches[0]?.kind, kind);
        return true;
      },
      `expected refusal for ${kind}`,
    );
  };
  refuses({ id: "d1", description: "Deployed on 2026-08-01 to prod." }, "iso-date");
  refuses({ id: "d2", description: "The standup moved to 09:15." }, "clock-time");
  refuses({ id: "d3", description: "The on-call rota changed yesterday." }, "relative-date");
});

test("three-band layering: pinned full first, fresh full, older compressed to a hook", () => {
  const built = buildStandingMemoryBlock({ entries: [OLD_LONG, FRESH, PINNED], nowMs: NOW });
  const body = built.lines.filter((line) => line.startsWith("- "));
  assert.deepEqual(built.bandCounts, { pinned: 1, fresh: 1, compressed: 1, dropped: 0 });
  // Band rank, then id order: pinned band has p-core alone.
  assert.equal(body[0], `- ${PINNED.description}`);
  assert.equal(body[1], `- ${FRESH.description}`);
  const hookLine = body[2] ?? "";
  assert.ok(hookLine.startsWith("- "), "compressed line must render");
  assert.ok(hookLine.endsWith("..."), "mechanical hook marks truncation");
  assert.ok(hookLine.length <= 2 + 96 + 3, "hook stays inside the char budget");
  assert.ok(
    built.ledger.get(standingHookLedgerKey(OLD_LONG.description, 96))?.endsWith("..."),
    "generated hook lands in the ledger",
  );
});

test("hook ledger: pre-seeded hooks are used verbatim; reuse keeps bytes identical", () => {
  const seeded = new Map([[standingHookLedgerKey(OLD_LONG.description, 96), "Billing moved to the ledger stream."]]);
  const built = buildStandingMemoryBlock({ entries: [OLD_LONG], nowMs: NOW, ledger: seeded });
  assert.ok(built.text.includes("- Billing moved to the ledger stream."));
  const rebuilt = buildStandingMemoryBlock({ entries: [OLD_LONG], nowMs: NOW, ledger: built.ledger });
  assert.equal(built.text, rebuilt.text);
  assert.equal(seeded.size, 1, "input ledger is never mutated");
});

test("mechanical trim: drops compressed lines from the tail, never pinned lines", () => {
  const built = buildStandingMemoryBlock({ entries: [OLD_LONG, FRESH, PINNED], nowMs: NOW, maxChars: 220 });
  assert.equal(built.bandCounts.pinned, 1, "pinned line survives");
  assert.ok(built.bandCounts.dropped >= 1, "tail lines dropped");
  assert.ok(built.text.includes("- ...(older lines trimmed)"));
  assert.ok(!built.text.includes(OLD_LONG.description.slice(0, 40)), "the longest compressed line is gone");
  assert.throws(
    () => buildStandingMemoryBlock({ entries: [PINNED, PINNED2], nowMs: NOW, maxChars: 80 }),
    StandingBlockBudgetError,
  );
});

test("no entries render an empty block; bad input is refused loudly", () => {
  assert.equal(buildStandingMemoryBlock({ entries: [], nowMs: NOW }).text, "");
  assert.throws(
    () => buildStandingMemoryBlock({ entries: [{ id: "x", description: "" }], nowMs: NOW }),
    /requires a non-empty description/,
  );
  assert.throws(
    () =>
      buildStandingMemoryBlock({
        entries: [
          { id: "x", description: "One." },
          { id: "x", description: "Two." },
        ],
        nowMs: NOW,
      }),
    /ids must be unique/,
  );
  assert.throws(
    () => buildStandingMemoryBlock({ entries: [{ id: "x", description: "One.", lastChangedAt: "nope" }], nowMs: NOW }),
    /unparseable lastChangedAt/,
  );
});

/**
 * Zero-diff proof for the foundation slice: nothing on the live recall path
 * reads the new keys yet, so recall output must stay byte-identical whether
 * the flag is absent or explicitly true, and must contain no standing block.
 * When the server wiring slice lands, this test flips to assert the block IS
 * prepended when on — that flip is the wiring PR's fail-before receipt.
 */
async function makeOrchestrator(
  overrides: Partial<PluginConfig> = {},
): Promise<{ orchestrator: Orchestrator; memoryDir: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-standing-zero-diff-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    multiGraphMemoryEnabled: false,
    entityGraphEnabled: false,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    extractionJudgeEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
    initGateTimeoutMs: 200,
    ...overrides,
  });
  return { orchestrator: new Orchestrator(config), memoryDir };
}

async function writeFact(memoryDir: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const factsDir = path.join(memoryDir, "facts", today);
  await mkdir(factsDir, { recursive: true });
  const now = new Date().toISOString();
  const fact = [
    "---",
    "id: standing-fact",
    "category: fact",
    `created: ${now}`,
    `updated: ${now}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    "status: active",
    "---",
    "",
    "The blue pipeline is the only deploy path.",
    "",
  ];
  await writeFile(path.join(factsDir, "standing-fact.md"), `${fact.join("\n")}\n`, "utf-8");
}

test("zero-diff: recall output is byte-identical with the flag off vs on (pre-wiring)", async () => {
  const off = await makeOrchestrator();
  const on = await makeOrchestrator({ recallStandingBlock: true });
  try {
    await writeFact(off.memoryDir);
    await writeFact(on.memoryDir);
    const outOff = await off.orchestrator.recall("how do deploys go out", "sess-standing-off");
    const outOn = await on.orchestrator.recall("how do deploys go out", "sess-standing-on");
    assert.equal(outOn, outOff, "recall must not change until the wiring slice lands");
    assert.ok(!outOn.includes("## Standing Memory (Remnic)"), "no standing block in recall output");
    assert.ok(outOn.includes("blue pipeline"), "sanity: the fact is recalled");
  } finally {
    await off.orchestrator.destroy();
    await on.orchestrator.destroy();
    await rm(off.memoryDir, { recursive: true, force: true });
    await rm(on.memoryDir, { recursive: true, force: true });
  }
});
