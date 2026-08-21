import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runBulkImportPipeline,
  formatBatchTranscript,
  resolveBulkImportContext,
  validateBatchSize,
  type ProcessBatchContext,
  type ProcessBatchFn,
} from "./pipeline.js";
import type {
  BulkImportSource,
  ImportTurn,
} from "./types.js";

function makeTurn(
  index: number,
  overrides?: Partial<ImportTurn>,
): ImportTurn {
  return {
    role: "user",
    content: `Message ${index}`,
    timestamp: `2024-06-15T10:${String(index).padStart(2, "0")}:00.000Z`,
    ...overrides,
  };
}

function makeSource(
  turnCount: number,
  overrides?: Partial<ImportTurn>,
): BulkImportSource {
  const turns: ImportTurn[] = [];
  for (let i = 0; i < turnCount; i += 1) {
    turns.push(makeTurn(i, overrides));
  }
  return {
    turns,
    metadata: {
      source: "test",
      exportDate: "2024-06-15T00:00:00.000Z",
      messageCount: turnCount,
      dateRange: {
        from: "2024-01-01T00:00:00.000Z",
        to: "2024-06-15T00:00:00.000Z",
      },
    },
  };
}

function trackingProcessBatch(): {
  fn: ProcessBatchFn;
  calls: ImportTurn[][];
  contexts: ProcessBatchContext[];
} {
  const calls: ImportTurn[][] = [];
  const contexts: ProcessBatchContext[] = [];
  const fn: ProcessBatchFn = async (turns, context) => {
    calls.push([...turns]);
    contexts.push(context);
    return { memoriesCreated: turns.length, duplicatesSkipped: 0 };
  };
  return { fn, calls, contexts };
}

describe("runBulkImportPipeline", () => {
  it("processes turns in batches of correct size", async () => {
    const source = makeSource(5);
    const { fn, calls } = trackingProcessBatch();
    const result = await runBulkImportPipeline(
      source,
      { batchSize: 2 },
      fn,
    );
    assert.equal(calls.length, 3); // 2 + 2 + 1
    assert.equal(calls[0].length, 2);
    assert.equal(calls[1].length, 2);
    assert.equal(calls[2].length, 1);
    assert.equal(result.turnsProcessed, 5);
    assert.equal(result.batchesProcessed, 3);
    assert.equal(result.memoriesCreated, 5);
  });

  it("dryRun mode does not call processBatch", async () => {
    const source = makeSource(10);
    const { fn, calls } = trackingProcessBatch();
    const result = await runBulkImportPipeline(
      source,
      { dryRun: true, batchSize: 3 },
      fn,
    );
    assert.equal(calls.length, 0);
    assert.equal(result.turnsProcessed, 10);
    assert.equal(result.batchesProcessed, 4); // ceil(10/3)
    assert.equal(result.memoriesCreated, 0);
  });

  it("returns zero counts for empty turns", async () => {
    const source = makeSource(0);
    const { fn, calls } = trackingProcessBatch();
    const result = await runBulkImportPipeline(source, {}, fn);
    assert.equal(calls.length, 0);
    assert.equal(result.turnsProcessed, 0);
    assert.equal(result.batchesProcessed, 0);
    assert.equal(result.memoriesCreated, 0);
    assert.equal(result.errors.length, 0);
  });

  it("respects custom batchSize", async () => {
    const source = makeSource(10);
    const { fn, calls } = trackingProcessBatch();
    await runBulkImportPipeline(source, { batchSize: 5 }, fn);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].length, 5);
    assert.equal(calls[1].length, 5);
  });

  it("default batchSize is 20", async () => {
    const source = makeSource(25);
    const { fn, calls } = trackingProcessBatch();
    await runBulkImportPipeline(source, {}, fn);
    assert.equal(calls.length, 2); // 20 + 5
    assert.equal(calls[0].length, 20);
    assert.equal(calls[1].length, 5);
  });

  it("passes effective import options to every processBatch call", async () => {
    const source = makeSource(5);
    const { fn, contexts } = trackingProcessBatch();
    await runBulkImportPipeline(
      source,
      {
        batchSize: 2,
        dedup: false,
        trustLevel: "import",
        namespace: "tenant-a",
      },
      fn,
    );

    assert.deepEqual(contexts, [
      { dedup: false, trustLevel: "import", namespace: "tenant-a" },
      { dedup: false, trustLevel: "import", namespace: "tenant-a" },
      { dedup: false, trustLevel: "import", namespace: "tenant-a" },
    ]);
  });

  it("uses explicit defaults for omitted import options", async () => {
    const source = makeSource(1);
    const { fn, contexts } = trackingProcessBatch();
    await runBulkImportPipeline(source, {}, fn);

    assert.deepEqual(contexts, [{ dedup: true, trustLevel: "import" }]);
  });

  it("validates no-op import option values before processing", () => {
    assert.throws(
      () => resolveBulkImportContext({ dedup: "false" as unknown as boolean }),
      /dedup must be a boolean/,
    );
    assert.throws(
      () => resolveBulkImportContext({ namespace: "" }),
      /namespace must be a non-empty string/,
    );
    assert.throws(
      () => resolveBulkImportContext({ trustLevel: "local" as "import" }),
      /trustLevel must be 'import'/,
    );
  });

  it("collects errors from processBatch in result.errors", async () => {
    const source = makeSource(6);
    let callCount = 0;
    const failingFn: ProcessBatchFn = async () => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("extraction failed");
      }
      return { memoriesCreated: 1, duplicatesSkipped: 0 };
    };
    const result = await runBulkImportPipeline(
      source,
      { batchSize: 2 },
      failingFn,
    );
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].batchIndex, 1);
    assert.ok(result.errors[0].message.includes("extraction failed"));
    // Other batches still processed
    assert.equal(result.batchesProcessed, 3);
    assert.equal(result.memoriesCreated, 2); // batch 0 + batch 2
  });

  it("skips invalid turns and reports validation errors", async () => {
    const source: BulkImportSource = {
      turns: [
        makeTurn(0),
        makeTurn(1, { role: "bad" as ImportTurn["role"] }),
        makeTurn(2),
      ],
      metadata: {
        source: "test",
        exportDate: "2024-06-15T00:00:00.000Z",
        messageCount: 3,
        dateRange: {
          from: "2024-01-01T00:00:00.000Z",
          to: "2024-06-15T00:00:00.000Z",
        },
      },
    };
    const { fn, calls } = trackingProcessBatch();
    const result = await runBulkImportPipeline(
      source,
      { batchSize: 10 },
      fn,
    );
    // Only 2 valid turns processed
    assert.equal(result.turnsProcessed, 2);
    // 1 validation error for the invalid turn
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].message.includes("role"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 2);
  });

  it("reports zero memoriesCreated when processBatch always throws", async () => {
    const source = makeSource(4);
    const notWiredFn: ProcessBatchFn = async () => {
      throw new Error(
        "Bulk import persistence is not yet wired. " +
          "Use --dryRun to validate without persisting.",
      );
    };
    const result = await runBulkImportPipeline(
      source,
      { batchSize: 2 },
      notWiredFn,
    );
    assert.equal(result.memoriesCreated, 0);
    assert.equal(result.duplicatesSkipped, 0);
    assert.equal(result.turnsProcessed, 4);
    assert.equal(result.batchesProcessed, 2);
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors[0].message.includes("not yet wired"));
    assert.ok(result.errors[1].message.includes("not yet wired"));
  });

  it("accumulates duplicatesSkipped from processBatch", async () => {
    const source = makeSource(4);
    const dupFn: ProcessBatchFn = async () => ({
      memoriesCreated: 0,
      duplicatesSkipped: 2,
    });
    const result = await runBulkImportPipeline(
      source,
      { batchSize: 2 },
      dupFn,
    );
    assert.equal(result.duplicatesSkipped, 4);
    assert.equal(result.memoriesCreated, 0);
  });

  it("accumulates entitiesCreated from processBatch", async () => {
    const source = makeSource(6);
    const fn: ProcessBatchFn = async () => ({
      memoriesCreated: 1,
      duplicatesSkipped: 0,
      entitiesCreated: 3,
    });
    const result = await runBulkImportPipeline(
      source,
      { batchSize: 2 },
      fn,
    );
    // 3 batches × 3 entities = 9
    assert.equal(result.entitiesCreated, 9);
  });

  it("treats missing entitiesCreated as zero", async () => {
    const source = makeSource(4);
    const fn: ProcessBatchFn = async () => ({
      memoriesCreated: 1,
      duplicatesSkipped: 0,
    });
    const result = await runBulkImportPipeline(
      source,
      { batchSize: 2 },
      fn,
    );
    assert.equal(result.entitiesCreated, 0);
  });
});

describe("formatBatchTranscript", () => {
  it("formats turns with participant names", () => {
    const turns: ImportTurn[] = [
      {
        role: "user",
        content: "Hello",
        timestamp: "2024-06-15T10:00:00.000Z",
        participantName: "Alice",
      },
      {
        role: "assistant",
        content: "Hi there",
        timestamp: "2024-06-15T10:01:00.000Z",
        participantName: "Bot",
      },
    ];
    const transcript = formatBatchTranscript(turns);
    assert.ok(transcript.includes("[2024-06-15T10:00:00.000Z] Alice: Hello"));
    assert.ok(
      transcript.includes("[2024-06-15T10:01:00.000Z] Bot: Hi there"),
    );
  });

  it("falls back to role when no participant info", () => {
    const turns: ImportTurn[] = [
      {
        role: "other",
        content: "System message",
        timestamp: "2024-06-15T10:00:00.000Z",
      },
    ];
    const transcript = formatBatchTranscript(turns);
    assert.ok(transcript.includes("other: System message"));
  });

  it("prefers participantName over participantId", () => {
    const turns: ImportTurn[] = [
      {
        role: "user",
        content: "Hey",
        timestamp: "2024-06-15T10:00:00.000Z",
        participantId: "p1",
        participantName: "Alice",
      },
    ];
    const transcript = formatBatchTranscript(turns);
    assert.ok(transcript.includes("Alice: Hey"));
    assert.ok(!transcript.includes("p1:"));
  });

  it("falls back to participantId when no name", () => {
    const turns: ImportTurn[] = [
      {
        role: "user",
        content: "Hey",
        timestamp: "2024-06-15T10:00:00.000Z",
        participantId: "p1",
      },
    ];
    const transcript = formatBatchTranscript(turns);
    assert.ok(transcript.includes("p1: Hey"));
  });
});

describe("validateBatchSize", () => {
  it("returns default when undefined", () => {
    assert.equal(validateBatchSize(undefined), 20);
  });

  it("accepts valid batch size", () => {
    assert.equal(validateBatchSize(10), 10);
  });

  it("throws for fractional values", () => {
    assert.throws(
      () => validateBatchSize(5.7),
      (err: Error) => {
        assert.ok(err.message.includes("integer"));
        return true;
      },
    );
  });

  it("throws for fractional value like 20.5", () => {
    assert.throws(
      () => validateBatchSize(20.5),
      (err: Error) => {
        assert.ok(err.message.includes("integer"));
        assert.ok(err.message.includes("20.5"));
        return true;
      },
    );
  });

  it("accepts minimum boundary (1)", () => {
    assert.equal(validateBatchSize(1), 1);
  });

  it("accepts maximum boundary (1000)", () => {
    assert.equal(validateBatchSize(1000), 1000);
  });

  it("throws for NaN", () => {
    assert.throws(
      () => validateBatchSize(NaN),
      (err: Error) => {
        assert.ok(err.message.includes("finite number"));
        return true;
      },
    );
  });

  it("throws for Infinity", () => {
    assert.throws(
      () => validateBatchSize(Infinity),
      (err: Error) => {
        assert.ok(err.message.includes("finite number"));
        return true;
      },
    );
  });

  it("throws for zero", () => {
    assert.throws(
      () => validateBatchSize(0),
      (err: Error) => {
        assert.ok(err.message.includes("between 1 and 1000"));
        return true;
      },
    );
  });

  it("throws for negative value", () => {
    assert.throws(
      () => validateBatchSize(-5),
      (err: Error) => {
        assert.ok(err.message.includes("between 1 and 1000"));
        return true;
      },
    );
  });

  it("throws for value exceeding maximum", () => {
    assert.throws(
      () => validateBatchSize(1001),
      (err: Error) => {
        assert.ok(err.message.includes("between 1 and 1000"));
        return true;
      },
    );
  });
});
