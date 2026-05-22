import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_IMPORT_BATCH_SIZE,
  defaultWriteMemoriesToOrchestrator,
  importedMemoryToTurn,
  runImporter,
  validateImportBatchSize,
  validateImportRateLimit,
  type ImportedMemory,
  type ImporterAdapter,
  type ImporterWriteTarget,
} from "./base.js";
import type { ImportTurn } from "../bulk-import/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemories(count: number, sourceLabel = "fake"): ImportedMemory[] {
  const out: ImportedMemory[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      content: `Memory #${i + 1}`,
      sourceLabel,
      sourceId: `fake-${i + 1}`,
      sourceTimestamp: new Date(
        Date.UTC(2026, 0, 1, 0, i, 0),
      ).toISOString(),
      importedFromPath: "/tmp/fake-export.json",
    });
  }
  return out;
}

function makeMockTarget(): {
  target: ImporterWriteTarget;
  received: ImportTurn[][];
} {
  const received: ImportTurn[][] = [];
  const target: ImporterWriteTarget = {
    async ingestBulkImportBatch(turns) {
      // Snapshot turns so adapter mutations don't retroactively change the log.
      received.push(turns.map((t) => ({ ...t })));
    },
    bulkImportWriteNamespace() {
      return "default";
    },
  };
  return { target, received };
}

function makeFakeAdapter(
  memories: ImportedMemory[],
): ImporterAdapter<ImportedMemory[]> {
  return {
    name: "fake",
    sourceLabel: "fake",
    parse(input: unknown): ImportedMemory[] {
      if (!Array.isArray(input)) {
        throw new Error("fake adapter expects an array input");
      }
      return input as ImportedMemory[];
    },
    transform(parsed: ImportedMemory[]): ImportedMemory[] {
      // Forwards the already-shaped memories unchanged — slice-1 integration
      // test drives the pipeline without source-specific shape wrangling.
      return parsed;
    },
    async writeTo(target, batch) {
      return defaultWriteMemoriesToOrchestrator(target, batch);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateImportBatchSize", () => {
  it("returns the default when undefined", () => {
    assert.equal(validateImportBatchSize(undefined), DEFAULT_IMPORT_BATCH_SIZE);
  });

  it("accepts values in range", () => {
    assert.equal(validateImportBatchSize(10), 10);
    assert.equal(validateImportBatchSize(500), 500);
  });

  it("rejects non-finite, non-integer, and out-of-range values", () => {
    assert.throws(() => validateImportBatchSize(Number.NaN));
    assert.throws(() => validateImportBatchSize(Number.POSITIVE_INFINITY));
    assert.throws(() => validateImportBatchSize(1.5));
    assert.throws(() => validateImportBatchSize(0));
    assert.throws(() => validateImportBatchSize(-5));
    assert.throws(() => validateImportBatchSize(100_000));
  });
});

describe("validateImportRateLimit", () => {
  it("returns undefined when undefined (no rate limit requested)", () => {
    assert.equal(validateImportRateLimit(undefined), undefined);
  });

  it("accepts positive finite values", () => {
    assert.equal(validateImportRateLimit(2), 2);
    assert.equal(validateImportRateLimit(0.5), 0.5);
  });

  it("rejects zero, negative, and non-finite rates", () => {
    assert.throws(() => validateImportRateLimit(0));
    assert.throws(() => validateImportRateLimit(-1));
    assert.throws(() => validateImportRateLimit(Number.NaN));
    assert.throws(() => validateImportRateLimit(Number.POSITIVE_INFINITY));
  });
});

describe("importedMemoryToTurn", () => {
  it("uses sourceTimestamp when present", () => {
    const memory: ImportedMemory = {
      content: "hello",
      sourceLabel: "chatgpt",
      sourceTimestamp: "2026-04-10T14:25:07.000Z",
    };
    const turn = importedMemoryToTurn(memory);
    assert.equal(turn.role, "user");
    assert.equal(turn.content, "hello");
    assert.equal(turn.timestamp, "2026-04-10T14:25:07.000Z");
    assert.equal(turn.participantName, "chatgpt");
  });

  it("falls back to importedAt when sourceTimestamp is missing", () => {
    const memory: ImportedMemory = {
      content: "hello",
      sourceLabel: "claude",
      importedAt: "2026-04-20T00:00:00.000Z",
    };
    const turn = importedMemoryToTurn(memory);
    assert.equal(turn.timestamp, "2026-04-20T00:00:00.000Z");
    assert.equal(turn.participantName, "claude");
  });

  it("propagates sourceId as participantId", () => {
    const memory: ImportedMemory = {
      content: "hello",
      sourceLabel: "chatgpt",
      sourceId: "cg-abc-123",
    };
    const turn = importedMemoryToTurn(memory);
    assert.equal(turn.participantId, "cg-abc-123");
  });

  it("preserves importer provenance separately from the ingest timestamp", () => {
    const memory: ImportedMemory = {
      content: "hello",
      sourceLabel: "chatgpt",
      sourceId: "cg-abc-123",
      sourceTimestamp: "2026-04-10T14:25:07.000Z",
      importedAt: "2026-05-20T00:00:00.000Z",
      importedFromPath: "/tmp/chatgpt-export.json",
      metadata: { conversationId: "conv-1", tags: ["saved"] },
    };

    const turn = importedMemoryToTurn(memory);
    assert.equal(turn.timestamp, "2026-04-10T14:25:07.000Z");
    assert.deepEqual(turn.importProvenance, {
      sourceLabel: "chatgpt",
      sourceId: "cg-abc-123",
      sourceTimestamp: "2026-04-10T14:25:07.000Z",
      importedFromPath: "/tmp/chatgpt-export.json",
      importedAt: "2026-05-20T00:00:00.000Z",
      metadata: { conversationId: "conv-1", tags: ["saved"] },
    });
  });
});

describe("runImporter — slice 1 integration", () => {
  it("dry-run with 3 memories produces a plan and never calls writeTo", async () => {
    const memories = makeMemories(3);
    const adapter = makeFakeAdapter(memories);
    const { target, received } = makeMockTarget();
    // Spy on writeTo explicitly.
    let writeToCalls = 0;
    const wrapped: ImporterAdapter<ImportedMemory[]> = {
      ...adapter,
      async writeTo(t, batch, opts) {
        writeToCalls += 1;
        return adapter.writeTo(t, batch, opts);
      },
    };

    const progress: string[] = [];
    const result = await runImporter(wrapped, memories, target, {
      dryRun: true,
      onProgress: (p) => progress.push(`${p.phase}:${p.processed}/${p.total}`),
    });

    assert.equal(writeToCalls, 0);
    assert.equal(received.length, 0);
    assert.equal(result.dryRun, true);
    assert.equal(result.memoriesPlanned, 3);
    assert.equal(result.memoriesWritten, 0);
    assert.equal(result.batchesProcessed, 0);
    assert.equal(result.adapter, "fake");
    assert.equal(result.sourceLabel, "fake");
    // Progress should have visited parse → transform → dry-run phases.
    assert.ok(
      progress.some((p) => p.startsWith("parse:")),
      `expected parse phase in ${progress.join(", ")}`,
    );
    assert.ok(progress.some((p) => p.startsWith("dry-run:3/3")));
  });

  it("non-dry-run calls orchestrator.ingestBulkImportBatch with all memories", async () => {
    const memories = makeMemories(3, "chatgpt");
    const adapter = makeFakeAdapter(memories);
    const { target, received } = makeMockTarget();

    const result = await runImporter(adapter, memories, target, {
      batchSize: 2,
    });

    assert.equal(result.dryRun, false);
    assert.equal(result.memoriesPlanned, 3);
    assert.equal(result.memoriesWritten, 3);
    // 3 memories, batch size 2 → 2 batches.
    assert.equal(result.batchesProcessed, 2);
    assert.equal(received.length, 2);
    assert.equal(received[0].length, 2);
    assert.equal(received[1].length, 1);
    // Provenance: every turn carries the sourceLabel as participantName.
    for (const batch of received) {
      for (const turn of batch) {
        assert.equal(turn.role, "user");
        assert.equal(turn.participantName, "chatgpt");
        assert.equal(turn.importProvenance?.importedFromPath, "/tmp/fake-export.json");
        assert.equal(turn.importProvenance?.sourceLabel, "chatgpt");
      }
    }
  });

  it("stamps importedAt on memories that do not already set it", async () => {
    const memories = makeMemories(2);
    let seenMemories: ImportedMemory[] = [];
    const adapter: ImporterAdapter<ImportedMemory[]> = {
      ...makeFakeAdapter(memories),
      async writeTo(target, batch) {
        seenMemories = seenMemories.concat(batch);
        return defaultWriteMemoriesToOrchestrator(target, batch);
      },
    };
    const { target } = makeMockTarget();

    const result = await runImporter(adapter, memories, target);
    assert.equal(result.memoriesWritten, 2);
    for (const m of seenMemories) {
      assert.ok(
        typeof m.importedAt === "string" && m.importedAt.length > 0,
        "each memory must carry importedAt",
      );
    }
  });

  it("rejects an invalid batchSize before parsing", async () => {
    const adapter = makeFakeAdapter([]);
    const { target } = makeMockTarget();
    await assert.rejects(
      () => runImporter(adapter, [], target, { batchSize: 0 }),
      /batchSize/,
    );
  });

  it("rejects an invalid rateLimit before parsing", async () => {
    const adapter = makeFakeAdapter([]);
    const { target } = makeMockTarget();
    await assert.rejects(
      () => runImporter(adapter, [], target, { rateLimit: 0 }),
      /rateLimit/,
    );
  });

  it("throws a clear error if transform returns a non-array", async () => {
    const { target } = makeMockTarget();
    const adapter: ImporterAdapter<unknown> = {
      name: "bad",
      sourceLabel: "bad",
      parse: (input) => input,
      // @ts-expect-error — intentional bad return for runtime guard test.
      transform: () => "not-an-array",
      async writeTo(t, batch) {
        return defaultWriteMemoriesToOrchestrator(t, batch);
      },
    };
    await assert.rejects(
      () => runImporter(adapter, {}, target),
      /non-array/,
    );
  });

  it("rejects malformed transformed memories before writeTo is called", async () => {
    const { target, received } = makeMockTarget();
    let writeToCalls = 0;
    const adapter: ImporterAdapter<unknown> = {
      name: "bad-memory",
      sourceLabel: "chatgpt",
      parse: (input) => input,
      transform: () => [
        {
          content: "",
          sourceLabel: "chatgpt",
          sourceTimestamp: "not-a-date",
        } as ImportedMemory,
      ],
      async writeTo(t, batch) {
        writeToCalls += 1;
        return defaultWriteMemoriesToOrchestrator(t, batch);
      },
    };

    await assert.rejects(
      () => runImporter(adapter, {}, target),
      /Importer 'bad-memory' produced invalid memory at index 0: .*content.*timestamp/s,
    );
    assert.equal(writeToCalls, 0);
    assert.equal(received.length, 0);
  });

  it("default writer rejects invalid imported memories before ingesting turns", async () => {
    const { target, received } = makeMockTarget();

    await assert.rejects(
      () =>
        defaultWriteMemoriesToOrchestrator(target, [
          {
            content: "valid content",
            sourceLabel: "",
            importedAt: "not-a-date",
          },
        ]),
      /defaultWriteMemoriesToOrchestrator.*sourceLabel.*timestamp/s,
    );
    assert.equal(received.length, 0);
  });

  it("fills in a missing sourceLabel from the adapter default", async () => {
    const memories: ImportedMemory[] = [
      // sourceLabel deliberately empty — runImporter should fall back.
      { content: "x", sourceLabel: "" },
    ];
    const adapter = makeFakeAdapter(memories);
    let seen: ImportedMemory[] = [];
    const wrapped: ImporterAdapter<ImportedMemory[]> = {
      ...adapter,
      async writeTo(target, batch) {
        seen = seen.concat(batch);
        return defaultWriteMemoriesToOrchestrator(target, batch);
      },
    };
    const { target } = makeMockTarget();
    await runImporter(wrapped, memories, target);
    assert.equal(seen[0].sourceLabel, "fake");
  });
});
