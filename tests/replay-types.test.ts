import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReplayNormalizerRegistry,
  runReplay,
  runReplayWithNormalizer,
} from "../src/replay/runner.ts";
import type { ReplayNormalizer } from "../src/replay/types.ts";
import { parseIsoTimestamp, validateReplayTurn } from "../src/replay/types.ts";

test("validateReplayTurn accepts canonical replay turns", () => {
  const issues = validateReplayTurn({
    source: "openclaw",
    sessionKey: "agent:generalist:main",
    role: "user",
    content: "hello",
    timestamp: "2026-02-25T00:00:00.000Z",
  });
  assert.equal(issues.length, 0);
});

test("validateReplayTurn rejects malformed replay turns", () => {
  const issues = validateReplayTurn({
    source: "openclaw" as any,
    sessionKey: "",
    role: "system" as any,
    content: "",
    timestamp: "not-a-date",
  });
  assert.equal(issues.length >= 3, true);
});

test("validateReplayTurn rejects unknown replay source values", () => {
  const issues = validateReplayTurn({
    source: "other" as any,
    sessionKey: "agent:generalist:main",
    role: "user",
    content: "hello",
    timestamp: "2026-02-25T00:00:00.000Z",
  });
  assert.equal(issues.some((issue) => issue.code === "turn.source.invalid"), true);
});

test("parseIsoTimestamp returns epoch for valid timestamps", () => {
  const epoch = parseIsoTimestamp("2026-02-25T00:00:00.000Z");
  assert.equal(typeof epoch, "number");
});

test("parseIsoTimestamp rejects non-canonical timestamp formats", () => {
  assert.equal(parseIsoTimestamp("02/25/2026 10:00"), null);
  assert.equal(parseIsoTimestamp("2026-02-25T10:00:00"), null);
  assert.equal(parseIsoTimestamp("2026-02-25"), null);
  assert.equal(parseIsoTimestamp("2026-02-30T00:00:00Z"), null);
});

test("runReplayWithNormalizer applies validation, range, offset, max and dry-run", async () => {
  const normalizer: ReplayNormalizer = {
    source: "openclaw",
    parse: async () => ({
      warnings: [{ code: "raw.warning", message: "source warning" }],
      turns: [
        {
          source: "openclaw",
          sessionKey: "agent:generalist:main",
          role: "assistant",
          content: "late",
          timestamp: "2026-02-25T12:00:00.000Z",
        },
        {
          source: "openclaw",
          sessionKey: "agent:generalist:main",
          role: "invalid",
          content: "bad",
          timestamp: "2026-02-25T11:00:00.000Z",
        } as any,
        {
          source: "openclaw",
          sessionKey: "agent:generalist:main",
          role: "user",
          content: "middle",
          timestamp: "2026-02-25T10:00:00.000Z",
        },
        {
          source: "openclaw",
          sessionKey: "agent:generalist:main",
          role: "assistant",
          content: "early",
          timestamp: "2026-02-25T09:00:00.000Z",
        },
      ],
    }),
  };

  let onTurnCalls = 0;
  const summary = await runReplayWithNormalizer(
    normalizer,
    {},
    {
      onTurn: async () => {
        onTurnCalls += 1;
      },
    },
    {
      dryRun: true,
      from: "2026-02-25T09:30:00.000Z",
      to: "2026-02-25T12:00:00.001Z",
      startOffset: 1,
      maxTurns: 1,
      batchSize: 2,
    },
  );

  assert.equal(onTurnCalls, 0);
  assert.equal(summary.parsedTurns, 4);
  assert.equal(summary.invalidTurns, 1);
  assert.equal(summary.filteredByDate, 1);
  assert.equal(summary.skippedByOffset, 1);
  assert.equal(summary.processedTurns, 1);
  assert.equal(summary.batchCount, 1);
  assert.equal(summary.firstTimestamp, "2026-02-25T12:00:00.000Z");
  assert.equal(summary.nextOffset, 2);
  assert.equal(summary.warnings.length >= 2, true);
});

test("runReplayWithNormalizer uses inclusive from and exclusive to date boundaries", async () => {
  const normalizer: ReplayNormalizer = {
    source: "openclaw",
    parse: async () => ({
      warnings: [],
      turns: [
        {
          source: "openclaw",
          sessionKey: "agent:generalist:main",
          role: "user",
          content: "start",
          timestamp: "2024-01-01T00:00:00.000Z",
        },
        {
          source: "openclaw",
          sessionKey: "agent:generalist:main",
          role: "assistant",
          content: "end-boundary",
          timestamp: "2024-01-01T01:00:00.000Z",
        },
        {
          source: "openclaw",
          sessionKey: "agent:generalist:main",
          role: "user",
          content: "next-window-end",
          timestamp: "2024-01-01T02:00:00.000Z",
        },
      ],
    }),
  };

  const firstWindowTurns: string[] = [];
  const firstWindow = await runReplayWithNormalizer(
    normalizer,
    {},
    {
      onTurn: (turn) => {
        firstWindowTurns.push(turn.content);
      },
    },
    {
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-01-01T01:00:00.000Z",
    },
  );
  assert.deepEqual(firstWindowTurns, ["start"]);
  assert.equal(firstWindow.filteredByDate, 2);

  const adjacentWindowTurns: string[] = [];
  const adjacentWindow = await runReplayWithNormalizer(
    normalizer,
    {},
    {
      onTurn: (turn) => {
        adjacentWindowTurns.push(turn.content);
      },
    },
    {
      from: "2024-01-01T01:00:00.000Z",
      to: "2024-01-01T02:00:00.000Z",
    },
  );
  assert.deepEqual(adjacentWindowTurns, ["end-boundary"]);
  assert.equal(adjacentWindow.filteredByDate, 2);
});

test("runReplayWithNormalizer processes in batches and calls handlers", async () => {
  const normalizer: ReplayNormalizer = {
    source: "claude",
    parse: () => ({
      warnings: [],
      turns: [
        {
          source: "claude",
          sessionKey: "agent:generalist:main",
          role: "user",
          content: "1",
          timestamp: "2026-02-25T09:00:00.000Z",
        },
        {
          source: "claude",
          sessionKey: "agent:generalist:main",
          role: "assistant",
          content: "2",
          timestamp: "2026-02-25T09:01:00.000Z",
        },
        {
          source: "claude",
          sessionKey: "agent:generalist:main",
          role: "user",
          content: "3",
          timestamp: "2026-02-25T09:02:00.000Z",
        },
      ],
    }),
  };

  const batches: number[] = [];
  let turns = 0;
  const summary = await runReplayWithNormalizer(
    normalizer,
    {},
    {
      onBatch: async (batch) => {
        batches.push(batch.length);
      },
      onTurn: async () => {
        turns += 1;
      },
    },
    { batchSize: 2 },
  );

  assert.deepEqual(batches, [2, 1]);
  assert.equal(turns, 3);
  assert.equal(summary.batchCount, 2);
  assert.equal(summary.processedTurns, 3);
});

test("runReplayWithNormalizer rejects parse results without turns arrays", async () => {
  const badNormalizer: ReplayNormalizer = {
    source: "openclaw",
    parse: () => ({ warnings: [] } as any),
  };

  await assert.rejects(
    async () => runReplayWithNormalizer(badNormalizer, {}, {}, {}),
    /turns must be an array/,
  );
});

test("runReplayWithNormalizer rejects non-object parse results", async () => {
  const badNormalizer: ReplayNormalizer = {
    source: "openclaw",
    parse: () => null as any,
  };

  await assert.rejects(
    async () => runReplayWithNormalizer(badNormalizer, {}, {}, {}),
    /invalid parse result object/,
  );
});

test("runReplayWithNormalizer rejects non-array warning payloads", async () => {
  const badNormalizer: ReplayNormalizer = {
    source: "openclaw",
    parse: () =>
      ({
        warnings: "oops",
        turns: [],
      }) as any,
  };

  await assert.rejects(
    async () => runReplayWithNormalizer(badNormalizer, {}, {}, {}),
    /warnings must be an array/,
  );
});

test("runReplayWithNormalizer rejects turns emitted for a different source", async () => {
  const normalizer: ReplayNormalizer = {
    source: "openclaw",
    parse: () => ({
      warnings: [],
      turns: [
        {
          source: "claude",
          sessionKey: "agent:generalist:main",
          role: "user",
          content: "wrong source",
          timestamp: "2026-02-25T00:00:00.000Z",
        },
      ],
    }),
  };

  const summary = await runReplayWithNormalizer(normalizer, {}, {}, {});
  assert.equal(summary.invalidTurns, 1);
  assert.equal(summary.processedTurns, 0);
  assert.equal(summary.warnings.some((warning) => warning.code === "turn.source.mismatch"), true);
});

test("buildReplayNormalizerRegistry rejects duplicates and runReplay resolves normalizers", async () => {
  const openclaw: ReplayNormalizer = {
    source: "openclaw",
    parse: () => ({
      warnings: [],
      turns: [
        {
          source: "openclaw",
          sessionKey: "agent:generalist:main",
          role: "user",
          content: "ok",
          timestamp: "2026-02-25T00:00:00.000Z",
        },
      ],
    }),
  };
  const claude: ReplayNormalizer = {
    source: "claude",
    parse: () => ({ warnings: [], turns: [] }),
  };
  const registry = buildReplayNormalizerRegistry([openclaw, claude]);
  const summary = await runReplay("openclaw", {}, registry, {}, {});
  assert.equal(summary.processedTurns, 1);

  assert.throws(
    () => buildReplayNormalizerRegistry([openclaw, { ...openclaw }]),
    /duplicate replay normalizer/,
  );

  assert.throws(
    () => buildReplayNormalizerRegistry([{ parse: () => ({ warnings: [], turns: [] }) } as any]),
    /source is required/,
  );
});
