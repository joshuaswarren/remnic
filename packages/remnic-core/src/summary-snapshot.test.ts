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
import { encodeStoragePathSegment } from "./storage-paths.js";
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

test("saveSummary encodes traversal-looking session keys before writing markdown", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-markdown-traversal-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "../escape";
  const dateStr = "2026-03-26";
  const summary = {
    hour: `${dateStr}T08:00:00.000Z`,
    sessionKey,
    bullets: ["safe markdown bullet"],
    turnCount: 1,
    generatedAt: "2026-03-26T08:15:00.000Z",
  };

  await summarizer.saveSummary(summary);

  const encodedPath = path.join(
    memoryDir,
    "summaries",
    "hourly",
    encodeStoragePathSegment(sessionKey, "session"),
    `${dateStr}.md`,
  );
  const unsafePath = path.join(memoryDir, "summaries", "escape", `${dateStr}.md`);

  const markdown = await readFile(encodedPath, "utf-8");
  assert.match(markdown, /safe markdown bullet/);
  await assert.rejects(readFile(unsafePath, "utf-8"), /ENOENT/);
});

test("saveSummary encodes slash-containing session keys before writing markdown", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-markdown-slash-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "thread/a";
  const dateStr = "2026-03-26";
  const summary = {
    hour: `${dateStr}T08:00:00.000Z`,
    sessionKey,
    bullets: ["slash markdown bullet"],
    turnCount: 1,
    generatedAt: "2026-03-26T08:15:00.000Z",
  };

  await summarizer.saveSummary(summary);

  const encodedPath = path.join(
    memoryDir,
    "summaries",
    "hourly",
    encodeStoragePathSegment(sessionKey, "session"),
    `${dateStr}.md`,
  );
  const legacyPath = path.join(
    memoryDir,
    "summaries",
    "hourly",
    "thread",
    "a",
    `${dateStr}.md`,
  );

  const markdown = await readFile(encodedPath, "utf-8");
  assert.match(markdown, /slash markdown bullet/);
  await assert.rejects(readFile(legacyPath, "utf-8"), /ENOENT/);
});

test("generateSummary falls back when local LLM returns schema-invalid bullets", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-local-schema-fallback-"),
  );
  const summarizer = new HourlySummarizer({
    ...makeConfig(memoryDir),
    localLlmEnabled: true,
    localLlmFallback: true,
  });
  await summarizer.initialize();

  (summarizer as any).localLlm.chatCompletion = async () => ({
    content: JSON.stringify({ bullets: [] }),
  });
  let fallbackCalls = 0;
  (summarizer as any).fallbackLlm.parseWithSchema = async () => {
    fallbackCalls += 1;
    return { bullets: ["gateway fallback bullet"] };
  };

  const summary = await summarizer.generateSummary(
    "session-local-invalid",
    new Date("2026-03-26T08:00:00.000Z"),
    [
      {
        role: "user",
        content: "Please summarize this work.",
        timestamp: "2026-03-26T08:00:00.000Z",
        sessionKey: "session-local-invalid",
        turnId: "turn-1",
      },
    ],
  );

  assert.deepEqual(summary?.bullets, ["gateway fallback bullet"]);
  assert.equal(fallbackCalls, 1);
});

test("saveSummary updates an early hour without dropping later sections", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-preserve-later-hours-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "session-preserve-later-hours";
  const dateStr = "2026-03-26";
  const summary = (hour: string, bullet: string) => ({
    hour: `${dateStr}T${hour}:00:00.000Z`,
    sessionKey,
    bullets: [bullet],
    turnCount: 1,
    generatedAt: "2026-03-26T08:15:00.000Z",
  });

  await summarizer.saveSummary(summary("08", "original first hour"));
  await summarizer.saveSummary(summary("09", "second hour"));
  await summarizer.saveSummary(summary("10", "third hour"));
  await summarizer.saveSummary(summary("08", "updated first hour"));

  const markdownPath = path.join(
    memoryDir,
    "summaries",
    "hourly",
    encodeStoragePathSegment(sessionKey, "session"),
    `${dateStr}.md`,
  );
  const markdown = await readFile(markdownPath, "utf-8");

  assert.match(markdown, /updated first hour/);
  assert.doesNotMatch(markdown, /original first hour/);
  assert.match(markdown, /second hour/);
  assert.match(markdown, /third hour/);
  assert.equal(markdown.indexOf("## 08:00") < markdown.indexOf("## 09:00"), true);
  assert.equal(markdown.indexOf("## 09:00") < markdown.indexOf("## 10:00"), true);
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

test("readRecent keeps a safe nested legacy markdown fallback", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-markdown-legacy-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "thread/a";
  const dateStr = "2026-03-24";
  const mdDir = path.join(memoryDir, "summaries", "hourly", "thread", "a");
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
      "- legacy slash markdown bullet",
      "  *(4 turns)*",
      "",
    ].join("\n"),
    "utf-8",
  );

  assert.equal(await readSummarySnapshot(memoryDir, sessionKey), null);

  const recent = await summarizer.readRecent(sessionKey, 9999);
  assert.deepEqual(
    recent.map((summary) => summary.bullets),
    [["legacy slash markdown bullet"]],
  );
  assert.deepEqual(
    (await readSummarySnapshot(memoryDir, sessionKey))?.map(
      (summary) => summary.bullets,
    ),
    [["legacy slash markdown bullet"]],
  );
});

test("readRecent does not duplicate hours during encoded markdown migration", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-markdown-migration-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "thread/a";
  const dateStr = "2026-03-24";
  const encodedDir = path.join(
    memoryDir,
    "summaries",
    "hourly",
    encodeStoragePathSegment(sessionKey, "session"),
  );
  const legacyDir = path.join(memoryDir, "summaries", "hourly", "thread", "a");
  await mkdir(encodedDir, { recursive: true });
  await mkdir(legacyDir, { recursive: true });

  const markdown = (bullet: string) =>
    [
      `# Hourly Summaries — ${dateStr}`,
      "",
      `*Session: ${sessionKey}*`,
      "",
      "## 14:00",
      "",
      `- ${bullet}`,
      "  *(4 turns)*",
      "",
    ].join("\n");

  await writeFile(
    path.join(encodedDir, `${dateStr}.md`),
    markdown("encoded markdown bullet"),
    "utf-8",
  );
  await writeFile(
    path.join(legacyDir, `${dateStr}.md`),
    markdown("legacy markdown bullet"),
    "utf-8",
  );

  const recent = await summarizer.readRecent(sessionKey, 9999);
  assert.deepEqual(
    recent.map((summary) => summary.bullets),
    [["encoded markdown bullet"]],
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

test("hourly active session discovery reads every session key in a transcript file", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-active-sessions-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const transcriptDir = path.join(memoryDir, "transcripts", "other", "default");
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(
    path.join(transcriptDir, "2026-03-26.jsonl"),
    [
      JSON.stringify({
        role: "user",
        content: "first session",
        timestamp: "2026-03-26T08:15:00.000Z",
        sessionKey: "agent:first:main",
      }),
      JSON.stringify({
        role: "user",
        content: "second session",
        timestamp: "2026-03-26T08:16:00.000Z",
        sessionKey: "agent:second:main",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const sessions = await (summarizer as any).getActiveSessions();
  assert.deepEqual(
    [...sessions].sort(),
    ["agent:first:main", "agent:second:main"],
  );
});

test("hourly transcript lookup ignores traversal channel paths", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-transcript-traversal-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "agent:worker:..:escape";
  const timestamp = "2026-03-26T08:15:00.000Z";
  const escapedDir = path.join(memoryDir, "escape");
  await mkdir(escapedDir, { recursive: true });
  await writeFile(
    path.join(escapedDir, "2026-03-26.jsonl"),
    JSON.stringify({
      role: "user",
      content: "escaped transcript",
      timestamp,
      sessionKey,
    }) + "\n",
    "utf-8",
  );

  const entries = await (summarizer as any).getTranscriptEntries(
    sessionKey,
    new Date("2026-03-26T08:00:00.000Z"),
    new Date("2026-03-26T09:00:00.000Z"),
  );

  assert.deepEqual(entries, []);
});

test("hourly transcript lookup reads encoded transcript channel directories", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-transcript-encoded-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "agent:worker:discord:channel:a/b";
  const timestamp = "2026-03-26T08:15:00.000Z";
  const transcriptDir = path.join(
    memoryDir,
    "transcripts",
    encodeStoragePathSegment("discord"),
    encodeStoragePathSegment("a/b"),
  );
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(
    path.join(transcriptDir, "2026-03-26.jsonl"),
    JSON.stringify({
      role: "user",
      content: "encoded transcript",
      timestamp,
      sessionKey,
    }) + "\n",
    "utf-8",
  );

  const entries = await (summarizer as any).getTranscriptEntries(
    sessionKey,
    new Date("2026-03-26T08:00:00.000Z"),
    new Date("2026-03-26T09:00:00.000Z"),
  );

  assert.deepEqual(
    entries.map((entry: any) => entry.content),
    ["encoded transcript"],
  );
});
