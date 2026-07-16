import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExplicitCueRecallSection,
  buildTrajectoryAnalysisRecallSection,
  type ExplicitCueRecallEngine,
  type TrajectoryAnalysisLineReceipt,
} from "./explicit-cue-recall.js";
import type { EvidencePackSelectionReceipt } from "./evidence-pack.js";

interface ReceiptRow {
  id?: number;
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
}

class ReceiptEngine implements ExplicitCueRecallEngine {
  constructor(private readonly rows: ReceiptRow[]) {}

  async expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
  ): Promise<ReceiptRow[]> {
    return this.rows.filter((row) =>
      row.session_id === sessionId &&
      row.turn_index >= fromTurn &&
      row.turn_index <= toTurn
    );
  }

  async searchContextFull(): Promise<Array<ReceiptRow & { score: number }>> {
    return [];
  }

  async getStats(): Promise<{ totalMessages: number; maxTurnIndex?: number }> {
    return {
      totalMessages: this.rows.length,
      maxTurnIndex: this.rows.length > 0
        ? Math.max(...this.rows.map((row) => row.turn_index))
        : undefined,
    };
  }
}

test("explicit-cue receipts identify only blocks that survive selection", async () => {
  const engine = new ReceiptEngine([
    {
      id: 101,
      session_id: "s",
      turn_index: 7,
      role: "user",
      content: "first selected row",
    },
    {
      id: 102,
      session_id: "s",
      turn_index: 7,
      role: "assistant",
      content: "second row that the deliberately narrow section budget rejects",
    },
  ]);
  const receipts: EvidencePackSelectionReceipt[] = [];
  const options = {
    engine,
    sessionId: "s",
    query: "Review turn 7",
    maxChars:
      "## Explicit Cue Evidence".length +
      2 +
      "[s, turn 7, user]: first selected row".length,
    maxItemChars: 200,
  };

  const baseline = await buildExplicitCueRecallSection(options);
  const traced = await buildExplicitCueRecallSection({
    ...options,
    onEvidenceSelected: (receipt) => receipts.push(receipt),
  });

  assert.equal(traced, baseline);
  assert.deepEqual(receipts.map((receipt) => receipt.item.archiveRowId), [101]);
  assert.equal(
    traced.slice(receipts[0]!.blockStart, receipts[0]!.blockEnd).includes(
      "first selected row",
    ),
    true,
  );
  assert.equal(JSON.stringify(receipts).includes("first selected row"), false);
  assert.equal(JSON.stringify(receipts).includes("second row"), false);
});

test("trajectory receipts retain row lineage only for emitted clipped lines", async () => {
  const engine = new ReceiptEngine([
    {
      id: 201,
      session_id: "ama",
      turn_index: 1,
      role: "user",
      content: "[Action 1]: move right",
    },
    {
      id: 202,
      session_id: "ama",
      turn_index: 1,
      role: "assistant",
      content: "[Observation 1]: reached the wall",
    },
    {
      id: 203,
      session_id: "ama",
      turn_index: 2,
      role: "user",
      content: "[Action 2]: move left",
    },
    {
      id: 204,
      session_id: "ama",
      turn_index: 2,
      role: "assistant",
      content: "[Observation 2]: reached the door",
    },
  ]);
  const receipts: TrajectoryAnalysisLineReceipt[] = [];
  const options = {
    engine,
    sessionId: "ama",
    query:
      "What will be the resulting state at action 1? Provide the full observation.",
    maxChars: 4_000,
  };

  const baseline = await buildTrajectoryAnalysisRecallSection(options);
  const traced = await buildTrajectoryAnalysisRecallSection({
    ...options,
    onLineSelected: (receipt) => receipts.push(receipt),
  });

  assert.equal(traced, baseline);
  const actionOne = receipts.find((receipt) =>
    traced.slice(receipt.lineStart, receipt.lineEnd).startsWith("[Action 1]")
  );
  const observationOne = receipts.find((receipt) =>
    traced.slice(receipt.lineStart, receipt.lineEnd).startsWith("[Observation 1]")
  );
  assert.ok(actionOne);
  assert.ok(observationOne);
  assert.equal(actionOne.lineageStatus, "exact");
  assert.equal(observationOne.lineageStatus, "exact");
  assert.deepEqual(actionOne.actionArchiveRowIds, [201]);
  assert.deepEqual(actionOne.observationArchiveRowIds, []);
  assert.deepEqual(observationOne.actionArchiveRowIds, []);
  assert.deepEqual(observationOne.observationArchiveRowIds, [202]);
  assert.equal(actionOne.actionArchiveRowIds.includes(203), false);
  assert.equal(observationOne.observationArchiveRowIds.includes(204), false);

  const clippedReceipts: TrajectoryAnalysisLineReceipt[] = [];
  const clipped = await buildTrajectoryAnalysisRecallSection({
    ...options,
    maxChars: actionOne.lineStart + 8,
    onLineSelected: (receipt) => clippedReceipts.push(receipt),
  });
  const partialAction = clippedReceipts.at(-1)!;
  assert.equal(partialAction.lineStart, actionOne.lineStart);
  assert.equal(partialAction.lineEnd, clipped.length);
  assert.equal(partialAction.lineageStatus, "exact");
  assert.deepEqual(partialAction.actionArchiveRowIds, [201]);
  assert.equal(partialAction.actionArchiveRowIds.includes(203), false);
  assert.equal(JSON.stringify(receipts).includes("move right"), false);
  assert.equal(JSON.stringify(receipts).includes("reached the wall"), false);
});

test("spatial derived-line receipts mark lineage unavailable without guessing siblings", async () => {
  const engine = new ReceiptEngine([
    {
      id: 301,
      session_id: "ama",
      turn_index: 20,
      role: "user",
      content: "[Action 20]: right",
    },
    {
      id: 302,
      session_id: "ama",
      turn_index: 20,
      role: "assistant",
      content: [
        "[Observation 20]: Active rules:",
        "baba is you",
        "",
        "Objects on the map:",
        "rule `win` 3 step to the left",
      ].join("\n"),
    },
    {
      id: 303,
      session_id: "ama",
      turn_index: 21,
      role: "user",
      content: "[Action 21]: left",
    },
    {
      id: 304,
      session_id: "ama",
      turn_index: 21,
      role: "assistant",
      content: [
        "[Observation 21]: Active rules:",
        "baba is you",
        "",
        "Objects on the map:",
        "rule `win` 2 step to the left",
      ].join("\n"),
    },
  ]);
  const receipts: TrajectoryAnalysisLineReceipt[] = [];
  const options = {
    engine,
    sessionId: "ama",
    query:
      "Between steps 20 and 21, the rule 'win' block's relative position changed from 3 step to the left to 2 step to the left. What was the actual movement?",
    maxChars: 4_000,
  };

  const baseline = await buildTrajectoryAnalysisRecallSection(options);
  const traced = await buildTrajectoryAnalysisRecallSection({
    ...options,
    onLineSelected: (receipt) => receipts.push(receipt),
  });

  assert.equal(traced, baseline);
  const heading = receipts.find((receipt) =>
    traced.slice(receipt.lineStart, receipt.lineEnd) === "Relative-position movement cues:"
  );
  const movement = receipts.find((receipt) =>
    traced.slice(receipt.lineStart, receipt.lineEnd).startsWith("Observation 20->21:")
  );
  assert.ok(heading);
  assert.ok(movement);
  assert.equal(heading.lineageStatus, "exact");
  assert.deepEqual(heading.actionArchiveRowIds, []);
  assert.deepEqual(heading.observationArchiveRowIds, []);
  assert.equal(movement.lineageStatus, "unavailable");
  assert.deepEqual(movement.actionArchiveRowIds, []);
  assert.deepEqual(movement.observationArchiveRowIds, []);
  assert.equal(JSON.stringify(movement).includes("rule win"), false);
});

test("trajectory receipts mark id-less and partially id-less direct sources unavailable", async () => {
  const engine = new ReceiptEngine([
    {
      session_id: "ama",
      turn_index: 1,
      role: "user",
      content: "[Action 1]: move right",
    },
    {
      id: 402,
      session_id: "ama",
      turn_index: 1,
      role: "assistant",
      content: "[Observation 1]: reached the wall",
    },
    {
      session_id: "ama",
      turn_index: 2,
      role: "user",
      content: "[Action 2]: move left",
    },
    {
      session_id: "ama",
      turn_index: 2,
      role: "assistant",
      content: "[Observation 2]: reached the door",
    },
  ]);
  const receipts: TrajectoryAnalysisLineReceipt[] = [];
  const text = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: "Compare steps 1 and 2 and provide the full observations.",
    maxChars: 4_000,
    onLineSelected: (receipt) => receipts.push(receipt),
  });
  const findLine = (prefix: string) => receipts.find((receipt) =>
    text.slice(receipt.lineStart, receipt.lineEnd).startsWith(prefix)
  );

  const idLessAction = findLine("[Action 1]");
  const identifiedObservation = findLine("[Observation 1]");
  const idLessObservation = findLine("[Observation 2]");
  assert.ok(idLessAction);
  assert.ok(identifiedObservation);
  assert.ok(idLessObservation);
  assert.equal(idLessAction.lineageStatus, "unavailable");
  assert.deepEqual(idLessAction.actionArchiveRowIds, []);
  assert.equal(identifiedObservation.lineageStatus, "exact");
  assert.deepEqual(identifiedObservation.observationArchiveRowIds, [402]);
  assert.equal(idLessObservation.lineageStatus, "unavailable");
  assert.deepEqual(idLessObservation.observationArchiveRowIds, []);
});

test("inferred-location receipts identify only the action that establishes the final location", async () => {
  const engine = new ReceiptEngine([
    {
      id: 501,
      session_id: "ama",
      turn_index: 1,
      role: "user",
      content: "[Action 1]: open cabinet 1",
    },
    {
      id: 502,
      session_id: "ama",
      turn_index: 2,
      role: "user",
      content: "[Action 2]: move cabinet 1 to kitchen",
    },
  ]);
  const receipts: TrajectoryAnalysisLineReceipt[] = [];
  const text = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "What is the state of cabinet 1 at step 2 and what was its prior whole changes history?",
    maxChars: 4_000,
    onLineSelected: (receipt) => receipts.push(receipt),
  });
  const location = receipts.find((receipt) =>
    text.slice(receipt.lineStart, receipt.lineEnd).startsWith(
      "Inferred cabinet 1 location at step 2: kitchen",
    )
  );

  assert.ok(location);
  assert.equal(location.lineageStatus, "exact");
  assert.deepEqual(location.actionArchiveRowIds, [502]);
  assert.equal(location.actionArchiveRowIds.includes(501), false);
  assert.deepEqual(location.observationArchiveRowIds, []);
});

test("stateful inventory-change lines do not publish partial current-row lineage", async () => {
  const engine = new ReceiptEngine([
    {
      id: 601,
      session_id: "ama",
      turn_index: 1,
      role: "user",
      content: "[Action 1]: take apple 1 from shelf 1",
    },
    {
      id: 602,
      session_id: "ama",
      turn_index: 2,
      role: "user",
      content: "[Action 2]: place apple 1 into bowl 1",
    },
  ]);
  const receipts: TrajectoryAnalysisLineReceipt[] = [];
  const text = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: "What changes occurred to the inventory throughout the trajectory?",
    maxChars: 4_000,
    onLineSelected: (receipt) => receipts.push(receipt),
  });
  const placed = receipts.find((receipt) =>
    text.slice(receipt.lineStart, receipt.lineEnd).startsWith(
      "[Action 2]: place apple 1 into bowl 1 => inventory removed apple 1",
    )
  );

  assert.ok(placed);
  assert.equal(placed.lineageStatus, "unavailable");
  assert.deepEqual(placed.actionArchiveRowIds, []);
  assert.deepEqual(placed.observationArchiveRowIds, []);
});
