import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import {
  appendDreamsLedgerEntry,
  readDreamsLedgerEntries,
  getDreamsStatus,
  dreamsLedgerPath,
  summarizeGovernanceResultForDreams,
  normalizeDreamsStatusWindowHours,
  recordDreamsPhaseRun,
  runDreamsPhase,
  type DreamsLedgerEntry,
} from "../packages/remnic-core/src/maintenance/dreams-ledger.js";

// ── helpers ───────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "engram-dreams-ledger-"));
}

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(baseDir, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

function makeEntry(overrides: Partial<DreamsLedgerEntry> = {}): DreamsLedgerEntry {
  return {
    schemaVersion: 1,
    startedAt: "2026-04-27T02:00:00.000Z",
    completedAt: "2026-04-27T02:00:05.123Z",
    durationMs: 5123,
    phase: "lightSleep",
    itemsProcessed: 42,
    dryRun: false,
    trigger: "scheduled",
    ...overrides,
  };
}

// ── dreamsLedgerPath ──────────────────────────────────────────────────────────

test("dreamsLedgerPath returns correct path", () => {
  assert.equal(
    dreamsLedgerPath("/tmp/mem"),
    path.join("/tmp/mem", "state", "dreams-ledger.jsonl"),
  );
});

// ── appendDreamsLedgerEntry ───────────────────────────────────────────────────

test("appendDreamsLedgerEntry creates the file and writes a valid JSONL entry", async () => {
  const memoryDir = await makeTmpDir();
  const entry = makeEntry();

  await appendDreamsLedgerEntry(memoryDir, entry);

  const raw = await readFile(dreamsLedgerPath(memoryDir), "utf-8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]) as DreamsLedgerEntry;
  assert.equal(parsed.phase, "lightSleep");
  assert.equal(parsed.itemsProcessed, 42);
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.trigger, "scheduled");
});

test("appendDreamsLedgerEntry appends without overwriting existing entries", async () => {
  const memoryDir = await makeTmpDir();

  await appendDreamsLedgerEntry(memoryDir, makeEntry({ phase: "lightSleep", itemsProcessed: 10 }));
  await appendDreamsLedgerEntry(memoryDir, makeEntry({ phase: "rem", itemsProcessed: 20 }));
  await appendDreamsLedgerEntry(memoryDir, makeEntry({ phase: "deepSleep", itemsProcessed: 30 }));

  const raw = await readFile(dreamsLedgerPath(memoryDir), "utf-8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 3);

  const phases = lines.map((l) => (JSON.parse(l) as DreamsLedgerEntry).phase);
  assert.deepEqual(phases, ["lightSleep", "rem", "deepSleep"]);
});

test("appendDreamsLedgerEntry creates parent directories if missing", async () => {
  const memoryDir = await makeTmpDir();
  // Note: state/ dir does NOT exist yet — must be created.
  const entry = makeEntry({ phase: "rem" });
  await appendDreamsLedgerEntry(memoryDir, entry);

  const entries = await readDreamsLedgerEntries(memoryDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].phase, "rem");
});

// ── readDreamsLedgerEntries ───────────────────────────────────────────────────

test("readDreamsLedgerEntries returns empty array when file does not exist", async () => {
  const memoryDir = await makeTmpDir();
  const entries = await readDreamsLedgerEntries(memoryDir);
  assert.deepEqual(entries, []);
});

test("readDreamsLedgerEntries skips malformed lines", async () => {
  const memoryDir = await makeTmpDir();

  await appendDreamsLedgerEntry(memoryDir, makeEntry({ phase: "lightSleep" }));

  // Inject a malformed line.
  const ledgerPath = dreamsLedgerPath(memoryDir);
  const existing = await readFile(ledgerPath, "utf-8");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(ledgerPath, existing + "not-valid-json\n", "utf-8");

  // Inject a line missing required fields.
  await writeFile(ledgerPath, await readFile(ledgerPath, "utf-8") + '{"phase":"rem"}\n', "utf-8");

  // Inject a valid JSON value that is not an object.
  await writeFile(ledgerPath, await readFile(ledgerPath, "utf-8") + "null\n", "utf-8");

  const entries = await readDreamsLedgerEntries(memoryDir);
  // Only the valid first line should come through.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].phase, "lightSleep");
});

test("readDreamsLedgerEntries normalises dryRun and trigger defaults", async () => {
  const memoryDir = await makeTmpDir();
  const ledgerPath = dreamsLedgerPath(memoryDir);
  const { mkdir: mkd, writeFile } = await import("node:fs/promises");
  await mkd(path.dirname(ledgerPath), { recursive: true });
  // Write a minimal valid line that omits dryRun and trigger.
  const minimal = {
    schemaVersion: 1,
    startedAt: "2026-04-27T00:00:00.000Z",
    completedAt: "2026-04-27T00:00:01.000Z",
    durationMs: 1000,
    phase: "deepSleep",
    itemsProcessed: 5,
  };
  await writeFile(ledgerPath, JSON.stringify(minimal) + "\n", "utf-8");

  const entries = await readDreamsLedgerEntries(memoryDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].dryRun, false);
  assert.equal(entries[0].trigger, "scheduled");
});

// ── getDreamsStatus ───────────────────────────────────────────────────────────

test("getDreamsStatus returns zero counts when ledger is empty", async () => {
  const memoryDir = await makeTmpDir();
  const now = new Date("2026-04-27T12:00:00.000Z");
  const result = await getDreamsStatus(memoryDir, 24, now);

  assert.equal(result.phases.lightSleep.runCount, 0);
  assert.equal(result.phases.rem.runCount, 0);
  assert.equal(result.phases.deepSleep.runCount, 0);
  assert.equal(result.phases.lightSleep.lastRunAt, null);
});

test("getDreamsStatus aggregates runs within the window", async () => {
  const memoryDir = await makeTmpDir();
  const now = new Date("2026-04-27T12:00:00.000Z");

  // Two light-sleep runs within the 24h window.
  await appendDreamsLedgerEntry(memoryDir, makeEntry({
    phase: "lightSleep",
    completedAt: "2026-04-27T06:00:00.000Z",
    durationMs: 1000,
    itemsProcessed: 10,
  }));
  await appendDreamsLedgerEntry(memoryDir, makeEntry({
    phase: "lightSleep",
    completedAt: "2026-04-27T09:00:00.000Z",
    durationMs: 2000,
    itemsProcessed: 20,
  }));

  // One REM run within the window.
  await appendDreamsLedgerEntry(memoryDir, makeEntry({
    phase: "rem",
    completedAt: "2026-04-27T03:00:00.000Z",
    durationMs: 5000,
    itemsProcessed: 100,
  }));

  // One deep-sleep run OUTSIDE the 24h window (should not appear).
  await appendDreamsLedgerEntry(memoryDir, makeEntry({
    phase: "deepSleep",
    completedAt: "2026-04-25T12:00:00.000Z",
    durationMs: 9000,
    itemsProcessed: 200,
  }));

  const result = await getDreamsStatus(memoryDir, 24, now);

  // light sleep: 2 runs
  assert.equal(result.phases.lightSleep.runCount, 2);
  assert.equal(result.phases.lightSleep.totalDurationMs, 3000);
  assert.equal(result.phases.lightSleep.totalItemsProcessed, 30);
  assert.equal(result.phases.lightSleep.lastRunAt, "2026-04-27T09:00:00.000Z");
  assert.equal(result.phases.lightSleep.lastDurationMs, 2000);

  // rem: 1 run
  assert.equal(result.phases.rem.runCount, 1);
  assert.equal(result.phases.rem.totalDurationMs, 5000);
  assert.equal(result.phases.rem.totalItemsProcessed, 100);

  // deep sleep: 0 (outside window)
  assert.equal(result.phases.deepSleep.runCount, 0);
  assert.equal(result.phases.deepSleep.lastRunAt, null);
});

test("getDreamsStatus windowStart/windowEnd match requested window", async () => {
  const memoryDir = await makeTmpDir();
  const now = new Date("2026-04-27T12:00:00.000Z");
  const result = await getDreamsStatus(memoryDir, 24, now);

  assert.equal(result.windowEnd, now.toISOString());
  assert.equal(result.windowStart, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
});

test("getDreamsStatus exclusive upper bound does not double-count boundary entry", async () => {
  const memoryDir = await makeTmpDir();
  const now = new Date("2026-04-27T12:00:00.000Z");

  // Entry with completedAt exactly equal to windowEnd should NOT be counted.
  await appendDreamsLedgerEntry(memoryDir, makeEntry({
    phase: "rem",
    completedAt: now.toISOString(),
    durationMs: 100,
    itemsProcessed: 1,
  }));

  const result = await getDreamsStatus(memoryDir, 24, now);
  assert.equal(result.phases.rem.runCount, 0);
});

test("getDreamsStatus honours custom windowHours", async () => {
  const memoryDir = await makeTmpDir();
  const now = new Date("2026-04-27T12:00:00.000Z");

  // Entry 2 hours ago — inside a 3h window but outside a 1h window.
  await appendDreamsLedgerEntry(memoryDir, makeEntry({
    phase: "lightSleep",
    completedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    durationMs: 100,
    itemsProcessed: 1,
  }));

  const threeHour = await getDreamsStatus(memoryDir, 3, now);
  assert.equal(threeHour.phases.lightSleep.runCount, 1);

  const oneHour = await getDreamsStatus(memoryDir, 1, now);
  assert.equal(oneHour.phases.lightSleep.runCount, 0);
});

test("getDreamsStatus rejects out-of-range windowHours before serializing dates", async () => {
  const memoryDir = await makeTmpDir();
  await assert.rejects(
    () => getDreamsStatus(memoryDir, Number.MAX_SAFE_INTEGER, new Date("2026-04-27T12:00:00.000Z")),
    /windowHours must be a positive integer/,
  );
  assert.throws(() => normalizeDreamsStatusWindowHours(1.5), /windowHours must be a positive integer/);
});

test("recordDreamsPhaseRun writes scheduled ledger entries", async () => {
  const memoryDir = await makeTmpDir();
  await recordDreamsPhaseRun({
    memoryDir,
    phase: "rem",
    trigger: "scheduled",
    itemsProcessed: 7,
    notes: "scheduled REM consolidation",
    startedAt: "2026-04-27T02:00:00.000Z",
    completedAt: "2026-04-27T02:00:03.000Z",
  });

  const entries = await readDreamsLedgerEntries(memoryDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.phase, "rem");
  assert.equal(entries[0]?.trigger, "scheduled");
  assert.equal(entries[0]?.itemsProcessed, 7);
  assert.equal(entries[0]?.durationMs, 3000);
});

test("runDreamsPhase lightSleep counts recent observation ledger timestamps", async () => {
  const memoryDir = await makeTmpDir();
  const ledgerPath = path.join(
    memoryDir,
    "state",
    "observation-ledger",
    "rebuilt-observations.jsonl",
  );
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const recentTs = new Date().toISOString();
  const recentHourDate = new Date(Date.now() - 60 * 60 * 1000);
  recentHourDate.setUTCMinutes(0, 0, 0);
  const recentHour = recentHourDate.toISOString();
  const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await writeFile(
    ledgerPath,
    [
      JSON.stringify({
        sessionKey: "s1",
        hour: recentHour,
        turnCount: 2,
        userTurns: 1,
        assistantTurns: 1,
        rebuiltAt: recentTs,
      }),
      JSON.stringify({ ts: recentTs, memoryId: "recent" }),
      JSON.stringify({ ts: oldTs, memoryId: "old" }),
      JSON.stringify({ timestamp: oldTs, memoryId: "legacy-old" }),
      JSON.stringify({ memoryId: "missing-ts" }),
    ].join("\n") + "\n",
    "utf-8",
  );

  const result = await runDreamsPhase({
    memoryDir,
    phase: "lightSleep",
    dryRun: true,
  });

  assert.equal(result.itemsProcessed, 2);
  assert.equal(result.durationMs, result.ledgerEntry?.durationMs);
});

test("runDreamsPhase deepSleep propagates governance failures without ledger entry", async () => {
  const memoryDir = await makeTmpDir();

  await assert.rejects(
    () => runDreamsPhase(
      { memoryDir, phase: "deepSleep", dryRun: false },
      async () => {
        throw new Error("backend unavailable");
      },
    ),
    /deep-sleep governance run failed: backend unavailable/,
  );

  assert.deepEqual(await readDreamsLedgerEntries(memoryDir), []);
});

test("runDreamsPhase rem skips namespace subtrees when scanning default root", async () => {
  const memoryDir = await makeTmpDir();
  await writeText(memoryDir, "facts/root.md", "# root memory\n");
  await writeText(memoryDir, "namespaces/team-a/facts/tenant.md", "# tenant memory\n");

  const result = await runDreamsPhase({
    memoryDir,
    phase: "rem",
    dryRun: true,
  });

  assert.equal(result.itemsProcessed, 1);
});

test("runDreamsPhase rem rejects symlinked memory roots", async () => {
  const targetDir = await makeTmpDir();
  const linkParent = await makeTmpDir();
  const linkedRoot = path.join(linkParent, "linked-root");
  await symlink(targetDir, linkedRoot);

  await assert.rejects(
    () => runDreamsPhase({
      memoryDir: linkedRoot,
      phase: "rem",
      dryRun: true,
    }),
    /memoryDir must not be a symlink/,
  );
});

test("runDreamsPhase live lightSleep requires a real phase runner", async () => {
  const memoryDir = await makeTmpDir();

  await assert.rejects(
    () => runDreamsPhase({ memoryDir, phase: "lightSleep", dryRun: false }),
    /light-sleep manual runs require a phase runner/,
  );
});

test("runDreamsPhase live rem records phase runner telemetry", async () => {
  const memoryDir = await makeTmpDir();
  const result = await runDreamsPhase(
    { memoryDir, phase: "rem", dryRun: false },
    undefined,
    async () => ({ itemsProcessed: 4, notes: "REM consolidation found 2 clusters" }),
  );

  assert.equal(result.itemsProcessed, 4);
  assert.equal(result.notes, "REM consolidation found 2 clusters");
  const entries = await readDreamsLedgerEntries(memoryDir);
  assert.equal(entries[0]?.itemsProcessed, 4);
});

test("runDreamsPhase returns success when manual ledger write fails after phase work", async () => {
  const memoryDir = await makeTmpDir();
  const blockedPath = path.join(memoryDir, "not-a-directory");
  await writeFile(blockedPath, "blocks state directory creation", "utf-8");

  const result = await runDreamsPhase(
    { memoryDir: blockedPath, phase: "rem", dryRun: false },
    undefined,
    async () => ({ itemsProcessed: 2, notes: "REM consolidation found 1 clusters" }),
  );

  assert.equal(result.itemsProcessed, 2);
  assert.equal(result.notes, "REM consolidation found 1 clusters");
  assert.equal(result.ledgerEntry, undefined);
  assert.ok(result.durationMs >= 0);
});

test("summarizeGovernanceResultForDreams does not double-count proposed actions", () => {
  const result = summarizeGovernanceResultForDreams(
    {
      summary: { scannedMemories: 5 },
      reviewQueue: [{ memoryId: "m1" }, { memoryId: "m2" }],
      proposedActions: [{ memoryId: "m1" }, { memoryId: "m2" }],
      appliedActions: [{ memoryId: "m1" }],
    },
    true,
  );

  assert.equal(result.scannedMemories, 5);
  assert.equal(result.appliedActionCount, 1);
  assert.match(result.notes ?? "", /2 actions proposed/);
});
