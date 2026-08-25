/**
 * recall-state-view-budget.test.ts — issue #2928.
 *
 * Final output budgeting must keep state-view packets atomic: a historical
 * row and its linked successor share ONE canonical packet key
 * (`stateViewPacketKeys`), so the final character/token cap admits BOTH or
 * NEITHER — never one side alone. Post-cap follow-up to the #2877/#2859
 * state-view work: the packet cap upstream counts packets, but the section
 * coordinator's final assembly still admitted rows one by one and could
 * split a pair at the budget boundary.
 *
 * Zero-diff guarantee: rows without a packetKey (state views off, non-state
 * rows) keep the pre-#2928 per-row admission exactly.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { RecallSectionCoordinator } from "./orchestration/recall-section-coordinator.js";
import type {
  RecallSectionBuckets,
  RecallSectionChunk,
} from "./orchestration/recall-section-coordinator.js";
import { capStateViewPackets, stateViewPacketKeys } from "./recall-state-view.js";
import type { PluginConfig, QmdSearchResult } from "./types.js";

const HEADING = "## Relevant Memories";
const PRED = "[superseded 2026-08-01 by sv-new] Job title used to be Senior Engineer.";
const SUCC = "Current job title: Staff Engineer.";
const PAIR_BLOCK = `${PRED}\n\n${SUCC}`;

// Token ceiling far above every character budget used here, so the
// character budget is the only binding constraint (deterministic).
const TOKENS = 1_000_000;

function makeCoordinator(recallBudgetChars: number): RecallSectionCoordinator {
  const config = parseConfig({
    maxMemoryTokens: TOKENS,
    recallBudgetChars,
    recallPipeline: [{ id: "memories", enabled: true }],
  });
  return new RecallSectionCoordinator({ getConfig: () => config });
}

interface RowOptions {
  memoryId: string;
  packetKey?: string;
  memoryNamespace?: string;
}

function appendRow(
  coordinator: RecallSectionCoordinator,
  buckets: RecallSectionBuckets,
  content: string,
  options: RowOptions,
): void {
  coordinator.appendRecallSection(buckets, "memories", content, {
    atomic: true,
    memoryId: options.memoryId,
    memoryPath: `facts/${options.memoryId}.md`,
    ...(options.packetKey ? { packetKey: options.packetKey } : {}),
    ...(options.memoryNamespace ? { memoryNamespace: options.memoryNamespace } : {}),
  });
}

function appendPair(
  coordinator: RecallSectionCoordinator,
  buckets: RecallSectionBuckets,
  predId: string,
  succId: string,
  packetKey: string,
  predContent = PRED,
  succContent = SUCC,
  memoryNamespace?: string,
): void {
  appendRow(coordinator, buckets, predContent, { memoryId: predId, packetKey, memoryNamespace });
  appendRow(coordinator, buckets, succContent, { memoryId: succId, packetKey, memoryNamespace });
}

function newBuckets(): RecallSectionBuckets {
  return new Map<string, Array<string | RecallSectionChunk>>();
}

function heading(buckets: RecallSectionBuckets, coordinator: RecallSectionCoordinator): void {
  coordinator.appendRecallSection(buckets, "memories", HEADING);
}

test("exact fit admits the historical row and its successor together", () => {
  const coordinator = makeCoordinator(HEADING.length + 2 + PAIR_BLOCK.length);
  const buckets = newBuckets();
  heading(buckets, coordinator);
  appendPair(coordinator, buckets, "sv-old", "sv-new", "pkt-1");

  const assembled = coordinator.assembleRecallSections(buckets);

  assert.deepEqual(assembled.includedMemoryIds, ["sv-old", "sv-new"]);
  assert.equal(assembled.sections[0], `${HEADING}\n\n${PAIR_BLOCK}`);
  assert.equal(assembled.truncated, false);
});

test("one char short of the packet alone drops BOTH rows — never one side", () => {
  const coordinator = makeCoordinator(PAIR_BLOCK.length - 1);
  const buckets = newBuckets();
  heading(buckets, coordinator);
  appendPair(coordinator, buckets, "sv-old", "sv-new", "pkt-1");

  const assembled = coordinator.assembleRecallSections(buckets);

  assert.deepEqual(assembled.includedMemoryIds, []);
  assert.deepEqual(assembled.omittedMemoryIds, ["sv-old", "sv-new"]);
  assert.equal(assembled.truncated, true);
  assert.equal(assembled.sections.length, 0);
});

test("one char short of heading+packet still keeps the packet whole (restart drops the heading, not the pair)", () => {
  const budget = HEADING.length + 2 + PAIR_BLOCK.length - 1;
  const coordinator = makeCoordinator(budget);
  const buckets = newBuckets();
  heading(buckets, coordinator);
  appendPair(coordinator, buckets, "sv-old", "sv-new", "pkt-1");

  const assembled = coordinator.assembleRecallSections(buckets);

  assert.deepEqual(assembled.includedMemoryIds, ["sv-old", "sv-new"]);
  assert.equal(assembled.sections[0], PAIR_BLOCK);
});

test("predecessor-first order is preserved on admission", () => {
  const coordinator = makeCoordinator(HEADING.length + 2 + PAIR_BLOCK.length);
  const buckets = newBuckets();
  heading(buckets, coordinator);
  appendPair(coordinator, buckets, "sv-old", "sv-new", "pkt-1");

  const out = coordinator.assembleRecallSections(buckets).sections[0] ?? "";
  assert.ok(out.indexOf(PRED) < out.indexOf(SUCC), "historical row must render before its successor");
});

test("successor-first order is preserved and still never splits the packet", () => {
  // Successor ranks first: the packet block renders at the FIRST member's
  // position with members in incoming order.
  const fits = makeCoordinator(HEADING.length + 2 + PAIR_BLOCK.length);
  const fitsBuckets = newBuckets();
  heading(fitsBuckets, fits);
  appendRow(fits, fitsBuckets, SUCC, { memoryId: "sv-new", packetKey: "pkt-1" });
  appendRow(fits, fitsBuckets, PRED, { memoryId: "sv-old", packetKey: "pkt-1" });
  const fitted = fits.assembleRecallSections(fitsBuckets);

  assert.deepEqual(fitted.includedMemoryIds, ["sv-new", "sv-old"]);
  const out = fitted.sections[0] ?? "";
  assert.ok(out.indexOf(SUCC) < out.indexOf(PRED));

  // One char short of the packet alone: the lone successor must NOT slip in.
  const tight = makeCoordinator(PAIR_BLOCK.length - 1);
  const tightBuckets = newBuckets();
  heading(tightBuckets, tight);
  appendRow(tight, tightBuckets, SUCC, { memoryId: "sv-new", packetKey: "pkt-1" });
  appendRow(tight, tightBuckets, PRED, { memoryId: "sv-old", packetKey: "pkt-1" });

  const dropped = tight.assembleRecallSections(tightBuckets);
  assert.deepEqual(dropped.includedMemoryIds, []);
  assert.equal(dropped.sections.length, 0);
});

test("multiple packets: a tight budget keeps whole packets, never a half pair", () => {
  const PRED2 = "[superseded 2026-08-01 by sv-new2] Old office was Austin.";
  const SUCC2 = "Current office: Denver.";
  const block1 = PAIR_BLOCK;
  const block2 = `${PRED2}\n\n${SUCC2}`;
  const fitBoth = HEADING.length + 2 + block1.length + 2 + block2.length;

  const all = makeCoordinator(fitBoth);
  const allBuckets = newBuckets();
  heading(allBuckets, all);
  appendPair(all, allBuckets, "sv-old", "sv-new", "pkt-1");
  appendPair(all, allBuckets, "sv-old2", "sv-new2", "pkt-2", PRED2, SUCC2);
  const assembledAll = all.assembleRecallSections(allBuckets);
  assert.deepEqual(assembledAll.includedMemoryIds, ["sv-old", "sv-new", "sv-old2", "sv-new2"]);
  assert.equal(assembledAll.truncated, false);

  // One char short of both packets: the first packet stays whole, the second
  // drops whole — no half pair on either side of the boundary.
  const one = makeCoordinator(fitBoth - 1);
  const oneBuckets = newBuckets();
  heading(oneBuckets, one);
  appendPair(one, oneBuckets, "sv-old", "sv-new", "pkt-1");
  appendPair(one, oneBuckets, "sv-old2", "sv-new2", "pkt-2", PRED2, SUCC2);
  const assembledOne = one.assembleRecallSections(oneBuckets);

  assert.deepEqual(assembledOne.includedMemoryIds, ["sv-old", "sv-new"]);
  assert.deepEqual(assembledOne.omittedMemoryIds, ["sv-old2", "sv-new2"]);
  assert.equal(assembledOne.truncated, true);
  const out = assembledOne.sections[0] ?? "";
  assert.ok(out.includes(PRED) && out.includes(SUCC));
  assert.ok(!out.includes(PRED2) && !out.includes(SUCC2));
});

test("namespace collision: identical ids in different namespaces are separate packets", () => {
  // Canonical packet keys are namespace-qualified — same memory ids across
  // two namespaces must never merge into one packet (#2859 pair-key rule).
  const rows: QmdSearchResult[] = [
    { id: "sv-old", namespace: "ns-a", supersededBy: "sv-new" } as QmdSearchResult,
    { id: "sv-new", namespace: "ns-a" } as QmdSearchResult,
    { id: "sv-old", namespace: "ns-b", supersededBy: "sv-new" } as QmdSearchResult,
    { id: "sv-new", namespace: "ns-b" } as QmdSearchResult,
  ];
  const keys = stateViewPacketKeys(rows);
  assert.equal(keys[0], keys[1], "ns-a pair shares one root");
  assert.equal(keys[2], keys[3], "ns-b pair shares one root");
  assert.notEqual(keys[0], keys[2], "same ids in different namespaces must not merge");

  const fitBoth = HEADING.length + 2 + PAIR_BLOCK.length * 2 + 2;
  const all = makeCoordinator(fitBoth);
  const allBuckets = newBuckets();
  heading(allBuckets, all);
  appendPair(all, allBuckets, "sv-old", "sv-new", keys[0]!, PRED, SUCC, "ns-a");
  appendPair(all, allBuckets, "sv-old", "sv-new", keys[2]!, PRED, SUCC, "ns-b");
  const assembledAll = all.assembleRecallSections(allBuckets);
  assert.equal(assembledAll.includedMemoryIds.length, 4, "both namespaces' packets admitted");

  // Budget for the heading plus ONE packet minus a char: whichever packet is
  // dropped goes whole — the identical foreign-namespace id never rescues it.
  const one = makeCoordinator(HEADING.length + 2 + PAIR_BLOCK.length + 1);
  const oneBuckets = newBuckets();
  heading(oneBuckets, one);
  appendPair(one, oneBuckets, "sv-old", "sv-new", keys[0]!, PRED, SUCC, "ns-a");
  appendPair(one, oneBuckets, "sv-old", "sv-new", keys[2]!, PRED, SUCC, "ns-b");
  const assembledOne = one.assembleRecallSections(oneBuckets);

  assert.equal(assembledOne.includedMemoryIds.length, 2, "exactly one whole packet admitted");
  assert.deepEqual(assembledOne.omittedMemoryIds, ["sv-old", "sv-new"]);
});

test("non-state rows between packet members stay admitted in rank order", () => {
  const OTHER = "An unrelated active fact about coffee.";
  const budget = HEADING.length + 2 + PAIR_BLOCK.length + 2 + OTHER.length;
  const coordinator = makeCoordinator(budget);
  const buckets = newBuckets();
  heading(buckets, coordinator);
  appendRow(coordinator, buckets, PRED, { memoryId: "sv-old", packetKey: "pkt-1" });
  appendRow(coordinator, buckets, OTHER, { memoryId: "other" });
  appendRow(coordinator, buckets, SUCC, { memoryId: "sv-new", packetKey: "pkt-1" });

  const assembled = coordinator.assembleRecallSections(buckets);
  const out = assembled.sections[0] ?? "";
  assert.deepEqual(assembled.includedMemoryIds, ["sv-old", "sv-new", "other"]);
  assert.ok(out.indexOf(PRED) < out.indexOf(SUCC));
  assert.ok(out.includes(OTHER));
});

test("zero-diff: rows without a packetKey keep per-row admission (split allowed)", () => {
  // Pre-#2928 semantics for non-state rows: the budget admits whatever fits,
  // including one row of an (unmarked) pair. Pinning this proves the packet
  // gate is opt-in via packetKey, not a global behavior change.
  const budget = HEADING.length + 2 + PRED.length + 1;
  const coordinator = makeCoordinator(budget);
  const buckets = newBuckets();
  heading(buckets, coordinator);
  appendRow(coordinator, buckets, PRED, { memoryId: "sv-old" });
  appendRow(coordinator, buckets, SUCC, { memoryId: "sv-new" });

  const assembled = coordinator.assembleRecallSections(buckets);
  assert.deepEqual(assembled.includedMemoryIds, ["sv-old"]);
  assert.equal(assembled.truncated, true);
});

test("stateViewPacketKeys: chains share one root, back-pointers anchor, blank ids stay singletons", () => {
  const chain = [
    { id: "a", supersededBy: "b" },
    { id: "b", supersededBy: "c" },
    { id: "c" },
    { id: "d" },
  ] as QmdSearchResult[];
  const keys = stateViewPacketKeys(chain);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[1], keys[2]);
  assert.notEqual(keys[0], keys[3]);

  // A successor's `supersedes` back-pointer anchors the pair even when the
  // predecessor lacks `supersededBy` (buildSuccessorMap precedence).
  const backPointer = [
    { id: "old" },
    { id: "new", supersedes: "old" },
  ] as QmdSearchResult[];
  const backKeys = stateViewPacketKeys(backPointer);
  assert.equal(backKeys[0], backKeys[1]);

  // Blank-key rows are distinct singletons.
  const blanks = [{}, {}] as QmdSearchResult[];
  const blankKeys = stateViewPacketKeys(blanks);
  assert.notEqual(blankKeys[0], blankKeys[1]);

  // capStateViewPackets keeps counting a whole chain as one slot (#2859).
  assert.deepEqual(
    capStateViewPackets(chain, 1).map((row) => row.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    capStateViewPackets(chain, 2).map((row) => row.id),
    ["a", "b", "c", "d"],
  );
});

// ---------------------------------------------------------------------------
// End to end: the publish seam threads real packet keys into the final
// budget, so a tight memories-section cap on a live recall output can never
// emit one side of a supersession pair (recent-scan path, QMD disabled).
// ---------------------------------------------------------------------------

const QUERY = "when did the job title change";

async function makeOrchestrator(
  overrides: Partial<PluginConfig> = {},
): Promise<{ orchestrator: Orchestrator; memoryDir: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-sv-budget-"));
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
    temporalSupersessionEnabled: true,
    temporalSupersessionIncludeInRecall: false,
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

async function writePair(memoryDir: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const factsDir = path.join(memoryDir, "facts", today);
  await mkdir(factsDir, { recursive: true });
  const now = new Date().toISOString();
  const successor = [
    "---",
    "id: sv-new",
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
    "Current job title: Staff Engineer.",
    "",
  ];
  const predecessor = [
    "---",
    "id: sv-old",
    "category: fact",
    `created: ${now}`,
    `updated: ${now}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    "status: superseded",
    "supersededBy: sv-new",
    "supersededAt: 2026-08-01",
    "---",
    "",
    "Job title history: the job title used to be Senior Engineer.",
    "",
  ];
  await writeFile(path.join(factsDir, "sv-new.md"), `${successor.join("\n")}\n`, "utf-8");
  await writeFile(path.join(factsDir, "sv-old.md"), `${predecessor.join("\n")}\n`, "utf-8");
}

test("end to end: a tight memories cap emits neither side of the pair (#2928)", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator({
    recallPipeline: [{ id: "memories", enabled: true, maxChars: 40 }],
  });
  try {
    await writePair(memoryDir);
    await orchestrator.initialize();
    const out = await orchestrator.recall(QUERY, "sess-sv-budget-tight", { stateView: true });

    // Atomicity is the XOR property: never exactly one side.
    const hasPred = out.includes("Senior Engineer");
    const hasSucc = out.includes("Staff Engineer");
    assert.ok(
      hasPred === hasSucc,
      `pair must be admitted or dropped together, got pred=${hasPred} succ=${hasSucc}:\n${out}`,
    );
    assert.ok(!hasPred && !hasSucc, "a 40-char cap cannot fit the packet, so both sides must be absent");
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("end to end: a generous cap emits both sides of the pair (#2928)", async () => {
  const { orchestrator, memoryDir } = await makeOrchestrator({
    recallPipeline: [{ id: "memories", enabled: true, maxChars: 4000 }],
  });
  try {
    await writePair(memoryDir);
    await orchestrator.initialize();
    const out = await orchestrator.recall(QUERY, "sess-sv-budget-wide", { stateView: true });

    assert.ok(out.includes("Senior Engineer"), "historical row must render, got:\n" + out);
    assert.ok(out.includes("Staff Engineer"), "successor row must render, got:\n" + out);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
