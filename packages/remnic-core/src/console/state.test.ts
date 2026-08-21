import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  gatherConsoleState,
  type ConsoleStateOrchestratorLike,
} from "./state.js";

function makeOrchestrator(
  overrides: Partial<ConsoleStateOrchestratorLike> = {},
): ConsoleStateOrchestratorLike {
  return {
    config: { memoryDir: "/nonexistent" },
    buffer: { getTurns: () => [] },
    qmd: {
      isAvailable: () => false,
      isDaemonMode: () => false,
      debugStatus: () => "stub",
    },
    ...overrides,
  };
}

test("gatherConsoleState returns a JSON-serializable snapshot", async () => {
  const snapshot = await gatherConsoleState(
    makeOrchestrator({
      buffer: {
        getTurns: () => [
          { content: "hello" },
          { content: "world" },
        ],
      },
    }),
  );

  // capturedAt is ISO-8601
  assert.match(snapshot.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // Must round-trip cleanly through JSON
  const json = JSON.stringify(snapshot);
  const parsed = JSON.parse(json);
  assert.equal(typeof parsed, "object");
  assert.equal(parsed.bufferState.turnsCount, 2);
  assert.equal(parsed.bufferState.byteCount, "hello".length + "world".length);
  assert.deepEqual(parsed.errors, []);
  assert.equal(typeof parsed.daemon.uptimeMs, "number");
  assert.equal(typeof parsed.daemon.version, "string");
  assert.equal(parsed.qmdProbe.available, false);
});

test("one subsystem failure does not crash gatherConsoleState", async () => {
  const snapshot = await gatherConsoleState(
    makeOrchestrator({
      buffer: {
        getTurns: () => {
          throw new Error("buffer exploded");
        },
      },
    }),
  );

  // Buffer section is empty + an entry in errors
  assert.equal(snapshot.bufferState.turnsCount, 0);
  assert.equal(snapshot.bufferState.byteCount, 0);
  assert.ok(
    snapshot.errors.some((e) => e.includes("bufferState") && e.includes("buffer exploded")),
    `expected bufferState error, got ${JSON.stringify(snapshot.errors)}`,
  );

  // Other sections still populated
  assert.equal(snapshot.qmdProbe.debug, "stub");
});

test("qmd probe failure is captured without crashing", async () => {
  const snapshot = await gatherConsoleState(
    makeOrchestrator({
      qmd: {
        isAvailable: () => {
          throw new Error("qmd boom");
        },
      },
    }),
  );
  assert.equal(snapshot.qmdProbe.available, false);
  assert.ok(snapshot.errors.some((e) => e.includes("qmdProbe")));
});

test("missing optional accessors fall back to placeholders", async () => {
  const snapshot = await gatherConsoleState({
    config: { memoryDir: "/nonexistent" },
  });
  assert.equal(snapshot.extractionQueue.depth, 0);
  assert.deepEqual(snapshot.extractionQueue.recentVerdicts, []);
  assert.deepEqual(snapshot.dedupRecent, []);
  assert.equal(snapshot.bufferState.turnsCount, 0);
  // No errors — these are graceful empty fallbacks, not failures.
  assert.deepEqual(snapshot.errors, []);
});

test("optional accessors populate extractionQueue and dedupRecent", async () => {
  const snapshot = await gatherConsoleState(
    makeOrchestrator({
      getConsoleExtractionQueueDepth: () => 3,
      getConsoleExtractionRecentVerdicts: () => [
        { ts: "2026-04-25T00:00:00Z", kind: "accept", reason: "ok" },
        { ts: "2026-04-25T00:01:00Z", kind: "reject" },
      ],
      getConsoleDedupRecentDecisions: () => [
        { ts: "2026-04-25T00:02:00Z", decision: "duplicate", similarity: 0.97 },
      ],
    }),
  );
  assert.equal(snapshot.extractionQueue.depth, 3);
  assert.equal(snapshot.extractionQueue.recentVerdicts.length, 2);
  assert.equal(snapshot.extractionQueue.recentVerdicts[0].reason, "ok");
  assert.equal(snapshot.dedupRecent.length, 1);
  assert.equal(snapshot.dedupRecent[0].similarity, 0.97);
});

test("maintenance ledger tail reads the most recent N rows", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "remnic-console-state-"));
  try {
    const ledgerDir = path.join(baseDir, "state", "observation-ledger");
    mkdirSync(ledgerDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(
        JSON.stringify({
          ts: `2026-04-25T00:${String(i).padStart(2, "0")}:00Z`,
          category: "EXTRACTION_JUDGE_VERDICT",
          verdictKind: i % 2 === 0 ? "accept" : "reject",
          reason: `event-${i}`,
        }),
      );
    }
    // Add a malformed row to confirm the parser tolerates it.
    lines.push("not-json");
    writeFileSync(
      path.join(ledgerDir, "rebuilt-observations.jsonl"),
      lines.join("\n") + "\n",
    );

    const snapshot = await gatherConsoleState({
      config: { memoryDir: baseDir },
    });
    // Capped at 50; oldest-first within the tail window.
    assert.equal(snapshot.maintenanceLedgerTail.length, 50);
    assert.ok(
      snapshot.maintenanceLedgerTail[0].ts <
        snapshot.maintenanceLedgerTail[49].ts,
      "tail should be ordered oldest-first",
    );
    assert.deepEqual(snapshot.errors, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("missing ledger file is not an error", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "remnic-console-state-"));
  try {
    const snapshot = await gatherConsoleState({
      config: { memoryDir: baseDir },
    });
    assert.deepEqual(snapshot.maintenanceLedgerTail, []);
    assert.deepEqual(snapshot.errors, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("maintenance ledger merges judge-verdicts + rebuilt-observations and picks globally most-recent rows", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "console-state-merge-"));
  try {
    const ledgerDir = path.join(baseDir, "state", "observation-ledger");
    mkdirSync(ledgerDir, { recursive: true });
    // Verdicts file: ts-ordered append log with two events.
    writeFileSync(
      path.join(ledgerDir, "extraction-judge-verdicts.jsonl"),
      [
        JSON.stringify({ ts: "2026-04-25T10:00:00Z", verdictKind: "accept" }),
        JSON.stringify({ ts: "2026-04-25T11:00:00Z", verdictKind: "reject" }),
      ].join("\n") + "\n",
    );
    // Rebuilt-observations file: sorted by sessionKey/hour, NOT
    // recency. Includes a row from a lexicographically-late session
    // that's actually the OLDEST event, and a row from a
    // lexicographically-early session that's the MOST-RECENT.
    writeFileSync(
      path.join(ledgerDir, "rebuilt-observations.jsonl"),
      [
        JSON.stringify({
          sessionKey: "aardvark",
          hour: "2026-04-25T12:00:00Z",
          turnCount: 5,
          rebuiltAt: "2026-04-25T12:30:00Z",
        }),
        JSON.stringify({
          sessionKey: "zebra",
          hour: "2026-04-25T08:00:00Z",
          turnCount: 3,
          rebuiltAt: "2026-04-25T08:30:00Z",
        }),
      ].join("\n") + "\n",
    );
    const snapshot = await gatherConsoleState(
      makeOrchestrator({ config: { memoryDir: baseDir } }),
    );
    // Most-recent ts is the aardvark row at hour=2026-04-25T12:00:00Z.
    // The byte-tail-only approach would have picked the zebra row
    // because it sits last in the file. Streaming top-N visits every
    // row and keeps the truly-most-recent.
    const tail = snapshot.maintenanceLedgerTail;
    assert.ok(tail.length >= 3);
    const last = tail[tail.length - 1];
    assert.equal(last.ts, "2026-04-25T12:00:00Z");
    assert.deepEqual(snapshot.errors, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
