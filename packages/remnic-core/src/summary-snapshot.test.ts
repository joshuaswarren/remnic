import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { HourlySummarizer } from "./summarizer.js";
import {
  readSummarySnapshot,
  upsertSummarySnapshot,
  summarySnapshotPath,
  writeSummarySnapshot,
} from "./summary-snapshot.js";
import type { PluginConfig } from "./types.js";

function makeConfig(memoryDir: string): PluginConfig {
  return {
    memoryDir,
    localLlmEnabled: false,
    localLlmFallback: true,
    localLlmUrl: "http://localhost:1234/v1",
    localLlmModel: "local-model",
  } as PluginConfig;
}

function utcDateString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("summary snapshot helpers round-trip summaries in descending hour order", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-snapshot-"),
  );
  const sessionKey = "session-snapshot";
  const summaries = [
    {
      hour: "2026-03-26T08:00:00.000Z",
      sessionKey,
      bullets: ["older bullet"],
      turnCount: 3,
      generatedAt: "2026-03-26T08:15:00.000Z",
    },
    {
      hour: "2026-03-26T14:00:00.000Z",
      sessionKey,
      bullets: ["newer bullet"],
      turnCount: 4,
      generatedAt: "2026-03-26T14:15:00.000Z",
    },
  ];

  await writeSummarySnapshot(memoryDir, sessionKey, summaries);

  assert.equal(
    summarySnapshotPath(memoryDir, sessionKey),
    path.join(memoryDir, "state", "summaries", `${sessionKey}.json`),
  );

  const loaded = await readSummarySnapshot(memoryDir, sessionKey);
  assert.deepEqual(loaded, [summaries[1], summaries[0]]);
});

test("summary snapshot paths encode traversal-looking session keys", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-snapshot-traversal-"),
  );
  const sessionKey = "../meta";
  const summary = {
    hour: "2026-03-26T08:00:00.000Z",
    sessionKey,
    bullets: ["safe bullet"],
    turnCount: 1,
    generatedAt: "2026-03-26T08:15:00.000Z",
  };

  await writeSummarySnapshot(memoryDir, sessionKey, [summary]);

  const snapshotRoot = path.join(memoryDir, "state", "summaries");
  const snapshotPath = summarySnapshotPath(memoryDir, sessionKey);
  assert.equal(path.dirname(snapshotPath), snapshotRoot);
  assert.match(path.basename(snapshotPath), /^%2E%2E%2Fmeta\.json$/);
  await assert.rejects(
    readFile(path.join(memoryDir, "state", "meta.json"), "utf-8"),
    /ENOENT/,
  );
  assert.deepEqual(await readSummarySnapshot(memoryDir, sessionKey), [summary]);
});

test("summary snapshot helpers round-trip slash-containing session keys", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-snapshot-slash-"),
  );
  const sessionKey = "thread/a";
  const summary = {
    hour: "2026-03-26T08:00:00.000Z",
    sessionKey,
    bullets: ["slash bullet"],
    turnCount: 1,
    generatedAt: "2026-03-26T08:15:00.000Z",
  };

  await upsertSummarySnapshot(memoryDir, summary);

  const snapshotRoot = path.join(memoryDir, "state", "summaries");
  const snapshotPath = summarySnapshotPath(memoryDir, sessionKey);
  assert.equal(path.dirname(snapshotPath), snapshotRoot);
  assert.match(path.basename(snapshotPath), /^thread%2Fa\.json$/);
  assert.deepEqual(await readSummarySnapshot(memoryDir, sessionKey), [summary]);
});

test("readSummarySnapshot keeps a safe nested legacy raw-path fallback", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-snapshot-legacy-"),
  );
  const sessionKey = "thread/a.with.dots";
  const summary = {
    hour: "2026-03-26T08:00:00.000Z",
    sessionKey,
    bullets: ["legacy bullet"],
    turnCount: 1,
    generatedAt: "2026-03-26T08:15:00.000Z",
  };
  const snapshotRoot = path.join(memoryDir, "state", "summaries");
  const legacyPath = path.join(snapshotRoot, `${sessionKey}.json`);
  await mkdir(path.dirname(legacyPath), { recursive: true });
  await writeFile(
    legacyPath,
    JSON.stringify({
      schemaVersion: 1,
      sessionKey,
      generatedAt: "2026-03-26T08:20:00.000Z",
      summaries: [summary],
    }),
    "utf-8",
  );

  assert.notEqual(
    summarySnapshotPath(memoryDir, sessionKey),
    legacyPath,
  );
  assert.deepEqual(await readSummarySnapshot(memoryDir, sessionKey), [summary]);
});

test("readRecent prefers the materialized summary snapshot over markdown fallback", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-prefers-snapshot-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "session-prefers-snapshot";
  const now = new Date();
  const dateStr = utcDateString(now);
  const mdDir = path.join(memoryDir, "summaries", "hourly", sessionKey);
  await mkdir(mdDir, { recursive: true });

  await writeSummarySnapshot(memoryDir, sessionKey, [
    {
      hour: `${dateStr}T14:00:00.000Z`,
      sessionKey,
      bullets: ["snapshot bullet"],
      turnCount: 2,
      generatedAt: "2026-03-26T14:15:00.000Z",
    },
  ]);

  await writeFile(
    path.join(mdDir, `${dateStr}.md`),
    [
      `# Hourly Summaries — ${dateStr}`,
      "",
      `*Session: ${sessionKey}*`,
      "",
      "## 14:00",
      "",
      "- markdown bullet",
      "  *(2 turns)*",
      "",
    ].join("\n"),
    "utf-8",
  );

  const recent = await summarizer.readRecent(sessionKey, 48);
  assert.deepEqual(
    recent.map((summary) => summary.bullets),
    [["snapshot bullet"]],
  );
});

test("readRecent backfills a summary snapshot from the full parsed markdown history", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-backfill-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "session-backfill";
  const dateStr = "2026-03-24";
  const mdDir = path.join(memoryDir, "summaries", "hourly", sessionKey);
  await mkdir(mdDir, { recursive: true });

  await writeFile(
    path.join(mdDir, `${dateStr}.md`),
    [
      `# Hourly Summaries — ${dateStr}`,
      "",
      `*Session: ${sessionKey}*`,
      "",
      "## 09:00",
      "",
      "- older markdown bullet",
      "  *(2 turns)*",
      "",
      "## 14:00",
      "",
      "- newer markdown bullet",
      "  *(4 turns)*",
      "",
    ].join("\n"),
    "utf-8",
  );

  assert.equal(await readSummarySnapshot(memoryDir, sessionKey), null);

  const recent = await summarizer.readRecent(sessionKey, 0);
  assert.equal(recent.length, 0);

  const snapshot = await readSummarySnapshot(memoryDir, sessionKey);
  assert.deepEqual(
    snapshot?.map((summary) => summary.bullets),
    [["newer markdown bullet"], ["older markdown bullet"]],
  );

  const widerRecent = await summarizer.readRecent(sessionKey, 9999);
  assert.deepEqual(
    widerRecent.map((summary) => summary.bullets),
    [["newer markdown bullet"], ["older markdown bullet"]],
  );
});

test("readRecent returns parsed summaries even when snapshot materialization fails", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-fail-open-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "session-snapshot-write-failure";
  const dateStr = "2026-03-24";
  const mdDir = path.join(memoryDir, "summaries", "hourly", sessionKey);
  await mkdir(mdDir, { recursive: true });

  await writeFile(
    path.join(mdDir, `${dateStr}.md`),
    [
      `# Hourly Summaries — ${dateStr}`,
      "",
      `*Session: ${sessionKey}*`,
      "",
      "## 14:00",
      "",
      "- parsed markdown bullet",
      "  *(4 turns)*",
      "",
    ].join("\n"),
    "utf-8",
  );

  await mkdir(path.join(memoryDir, "state", "summaries", `${sessionKey}.json`), {
    recursive: true,
  });

  const recent = await summarizer.readRecent(sessionKey, 9999);
  assert.deepEqual(
    recent.map((summary) => summary.bullets),
    [["parsed markdown bullet"]],
  );
});

test("upsertSummarySnapshot waits for an inter-process lock before merging new summaries", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-lock-"),
  );
  const sessionKey = "session-lock";
  const existingSummary = {
    hour: "2026-03-26T08:00:00.000Z",
    sessionKey,
    bullets: ["existing bullet"],
    turnCount: 2,
    generatedAt: "2026-03-26T08:15:00.000Z",
  };
  const externalSummary = {
    hour: "2026-03-26T12:00:00.000Z",
    sessionKey,
    bullets: ["external bullet"],
    turnCount: 3,
    generatedAt: "2026-03-26T12:15:00.000Z",
  };
  const newSummary = {
    hour: "2026-03-26T16:00:00.000Z",
    sessionKey,
    bullets: ["new bullet"],
    turnCount: 4,
    generatedAt: "2026-03-26T16:15:00.000Z",
  };

  await writeSummarySnapshot(memoryDir, sessionKey, [existingSummary]);

  const lockPath = path.join(
    memoryDir,
    "state",
    "summaries",
    `${sessionKey}.lock`,
  );
  const lockHandle = await open(lockPath, "wx");

  const pendingUpsert = upsertSummarySnapshot(memoryDir, newSummary);
  await new Promise((resolve) => setTimeout(resolve, 50));

  await writeSummarySnapshot(memoryDir, sessionKey, [
    externalSummary,
    existingSummary,
  ]);
  await lockHandle.close();
  await unlink(lockPath);

  await pendingUpsert;

  const snapshot = await readSummarySnapshot(memoryDir, sessionKey);
  assert.deepEqual(
    snapshot?.map((summary) => summary.bullets),
    [["new bullet"], ["external bullet"], ["existing bullet"]],
  );
});

test("runHourly keeps processing later sessions when snapshot upsert fails after markdown save", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-run-hourly-fail-open-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const failingSession = "session-fail-open-a";
  const succeedingSession = "session-fail-open-b";
  const previousHour = new Date(Date.now() - 60 * 60 * 1000);
  previousHour.setMinutes(0, 0, 0);
  const dateStr = utcDateString(previousHour);

  await mkdir(summarySnapshotPath(memoryDir, failingSession), {
    recursive: true,
  });

  const fakeEntries = [
    {
      role: "user",
      content: "summarize this",
      timestamp: new Date().toISOString(),
      sessionKey: failingSession,
    },
  ] as any[];

  (summarizer as any).getActiveSessions = async () => [
    failingSession,
    succeedingSession,
  ];
  (summarizer as any).getTranscriptEntries = async () => fakeEntries;
  (summarizer as any).generateSummary = async (
    sessionKey: string,
    hourStart: Date,
  ) => ({
    hour: hourStart.toISOString(),
    sessionKey,
    bullets: [`summary for ${sessionKey}`],
    turnCount: 1,
    generatedAt: new Date().toISOString(),
  });

  await summarizer.runHourly();

  const failingSummaryPath = path.join(
    memoryDir,
    "summaries",
    "hourly",
    failingSession,
    `${dateStr}.md`,
  );
  const succeedingSummaryPath = path.join(
    memoryDir,
    "summaries",
    "hourly",
    succeedingSession,
    `${dateStr}.md`,
  );

  const failingMarkdown = await readFile(failingSummaryPath, "utf-8");
  const succeedingMarkdown = await readFile(succeedingSummaryPath, "utf-8");
  assert.match(failingMarkdown, new RegExp(`summary for ${failingSession}`));
  assert.match(succeedingMarkdown, new RegExp(`summary for ${succeedingSession}`));

  assert.deepEqual(
    (await readSummarySnapshot(memoryDir, succeedingSession))?.map(
      (summary) => summary.bullets,
    ),
    [[`summary for ${succeedingSession}`]],
  );
});
