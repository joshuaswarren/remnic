import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { RULE_VERSION, runMemoryGovernance, restoreMemoryGovernanceRun } from "../src/maintenance/memory-governance.ts";
import { StorageManager } from "../src/storage.ts";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

async function setTimestamp(baseDir: string, relPath: string, isoTimestamp: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  const when = new Date(isoTimestamp);
  await utimes(full, when, when);
}

function memoryDoc(options: {
  id: string;
  content: string;
  category?: string;
  created?: string;
  updated?: string;
  source?: string;
  confidence?: number;
  confidenceTier?: string;
  status?: string;
  lifecycleState?: string;
  verificationState?: string;
  accessCount?: number;
  lastAccessed?: string;
  tags?: string[];
}): string {
  return [
    "---",
    `id: ${options.id}`,
    `category: ${options.category ?? "fact"}`,
    `created: ${options.created ?? "2026-03-01T00:00:00.000Z"}`,
    `updated: ${options.updated ?? options.created ?? "2026-03-01T00:00:00.000Z"}`,
    `source: ${options.source ?? "test"}`,
    `confidence: ${options.confidence ?? 0.8}`,
    `confidenceTier: ${options.confidenceTier ?? "implied"}`,
    `tags: [${(options.tags ?? ["governance"]).map((tag) => `"${tag}"`).join(", ")}]`,
    ...(options.status ? [`status: ${options.status}`] : []),
    ...(options.lifecycleState ? [`lifecycleState: ${options.lifecycleState}`] : []),
    ...(options.verificationState ? [`verificationState: ${options.verificationState}`] : []),
    ...(options.accessCount !== undefined ? [`accessCount: ${options.accessCount}`] : []),
    ...(options.lastAccessed ? [`lastAccessed: ${options.lastAccessed}`] : []),
    "---",
    "",
    options.content,
    "",
  ].join("\n");
}

test("operations docs publish the current governance rule version", async () => {
  const operations = await readFile(new URL("../docs/operations.md", import.meta.url), "utf-8");

  assert.match(operations, new RegExp(`rule set is versioned as \`${RULE_VERSION}\``));
});

test("shadow governance run writes review artifacts without mutating memory files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-shadow-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc({
        id: "fact-duplicate-a",
        content: "The deployment checklist requires smoke tests before cutover.",
        created: "2026-03-01T00:00:00.000Z",
        updated: "2026-03-01T00:00:00.000Z",
        confidence: 0.95,
        confidenceTier: "explicit",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc({
        id: "fact-duplicate-b",
        content: "The deployment checklist requires smoke tests before cutover.",
        created: "2026-03-02T00:00:00.000Z",
        updated: "2026-03-02T00:00:00.000Z",
        confidence: 0.55,
        confidenceTier: "inferred",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-03/fact-disputed.md",
      memoryDoc({
        id: "fact-disputed",
        content: "This disputed memory should be quarantined for review.",
        created: "2026-03-03T00:00:00.000Z",
        updated: "2026-03-03T00:00:00.000Z",
        verificationState: "disputed",
        lifecycleState: "candidate",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-04/fact-speculative.md",
      memoryDoc({
        id: "fact-speculative",
        content: "This speculative memory is low confidence and should enter review.",
        created: "2026-03-04T00:00:00.000Z",
        updated: "2026-03-04T00:00:00.000Z",
        confidence: 0.2,
        confidenceTier: "speculative",
        lifecycleState: "candidate",
        verificationState: "unverified",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2025-01-01/fact-stale.md",
      memoryDoc({
        id: "fact-stale",
        content: "This stale memory should be proposed for archival.",
        created: "2025-01-01T00:00:00.000Z",
        updated: "2025-01-01T00:00:00.000Z",
        confidence: 0.7,
        confidenceTier: "implied",
        lifecycleState: "stale",
        verificationState: "system_inferred",
        accessCount: 0,
        lastAccessed: "2025-01-01T00:00:00.000Z",
      }),
    );

    const result = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    assert.equal(result.mode, "shadow");
    assert.equal(result.appliedActions.length, 0);
    assert.equal(result.reviewQueue.length >= 4, true);
    assert.equal(result.reviewQueue.some((entry) => entry.reasonCode === "exact_duplicate"), true);
    assert.equal(result.reviewQueue.some((entry) => entry.reasonCode === "disputed_memory"), true);
    assert.equal(result.reviewQueue.some((entry) => entry.reasonCode === "speculative_low_confidence"), true);
    assert.equal(result.reviewQueue.some((entry) => entry.reasonCode === "archive_candidate"), true);
    assert.match(result.traceId, /^gov-/);
    await stat(result.summaryPath);
    await stat(result.reviewQueuePath);
    await stat(result.qualityScorePath);
    await stat(result.transitionReportPath);
    await stat(result.reportPath);
    await stat(result.keptMemoriesPath);
    await stat(result.appliedActionsPath);
    await stat(result.metricsPath);
    await stat(result.manifestPath);

    const report = await readFile(result.reportPath, "utf-8");
    assert.match(report, /Trace ID:/);
    const keptMemories = JSON.parse(await readFile(result.keptMemoriesPath, "utf-8")) as string[];
    assert.deepEqual(keptMemories, ["fact-duplicate-a"]);
    const manifest = JSON.parse(
      await readFile(result.manifestPath, "utf-8"),
    ) as { traceId: string; artifacts: Record<string, string> };
    assert.equal(manifest.traceId, result.traceId);
    assert.equal(manifest.artifacts.metrics, result.metricsPath);
    assert.equal(manifest.artifacts.qualityScore, result.qualityScorePath);
    assert.equal(manifest.artifacts.transitionReport, result.transitionReportPath);
    const metrics = JSON.parse(await readFile(result.metricsPath, "utf-8")) as {
      proposedStatuses: Record<string, number>;
      qualityScore: { score: number };
    };
    assert.equal(metrics.proposedStatuses.archived, 1);
    assert.equal(metrics.qualityScore.score < 100, true);

    const duplicate = await new StorageManager(memoryDir).getMemoryById("fact-duplicate-b");
    assert.equal(duplicate?.frontmatter.status ?? "active", "active");
    await assert.rejects(() => stat(path.join(memoryDir, "archive", "2026-03-09", "fact-stale.md")));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("apply governance run writes restore metadata and restore reverts archive/quarantine/review changes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-apply-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc({
        id: "fact-duplicate-a",
        content: "The deployment checklist requires smoke tests before cutover.",
        created: "2026-03-01T00:00:00.000Z",
        updated: "2026-03-01T00:00:00.000Z",
        confidence: 0.95,
        confidenceTier: "explicit",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc({
        id: "fact-duplicate-b",
        content: "The deployment checklist requires smoke tests before cutover.",
        created: "2026-03-02T00:00:00.000Z",
        updated: "2026-03-02T00:00:00.000Z",
        confidence: 0.55,
        confidenceTier: "inferred",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-03/fact-disputed.md",
      memoryDoc({
        id: "fact-disputed",
        content: "This disputed memory should be quarantined for review.",
        created: "2026-03-03T00:00:00.000Z",
        updated: "2026-03-03T00:00:00.000Z",
        verificationState: "disputed",
        lifecycleState: "candidate",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-04/fact-speculative.md",
      memoryDoc({
        id: "fact-speculative",
        content: "This speculative memory is low confidence and should enter review.",
        created: "2026-03-04T00:00:00.000Z",
        updated: "2026-03-04T00:00:00.000Z",
        confidence: 0.2,
        confidenceTier: "speculative",
        lifecycleState: "candidate",
        verificationState: "unverified",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2025-01-01/fact-stale.md",
      memoryDoc({
        id: "fact-stale",
        content: "This stale memory should be proposed for archival.",
        created: "2025-01-01T00:00:00.000Z",
        updated: "2025-01-01T00:00:00.000Z",
        confidence: 0.7,
        confidenceTier: "implied",
        lifecycleState: "stale",
        verificationState: "system_inferred",
        accessCount: 0,
        lastAccessed: "2025-01-01T00:00:00.000Z",
      }),
    );

    const applyResult = await runMemoryGovernance({
      memoryDir,
      mode: "apply",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    assert.equal(applyResult.mode, "apply");
    assert.equal(applyResult.appliedActions.some((action) => action.action === "archive"), true);
    assert.equal(applyResult.appliedActions.some((action) => action.action === "set_status"), true);
    assert.ok(applyResult.restorePath);
    await stat(applyResult.restorePath);
    await stat(applyResult.metricsPath);

    const storage = new StorageManager(memoryDir);
    const duplicate = await storage.getMemoryById("fact-duplicate-b");
    const disputed = await storage.getMemoryById("fact-disputed");
    const speculative = await storage.getMemoryById("fact-speculative");
    assert.equal(duplicate?.frontmatter.status, "pending_review");
    assert.equal(disputed?.frontmatter.status, "quarantined");
    assert.equal(speculative?.frontmatter.status, "pending_review");
    const archivedPath = path.join(memoryDir, "archive", "2026-03-09", "fact-stale.md");
    await stat(archivedPath);
    const archivedRaw = await readFile(archivedPath, "utf-8");
    assert.match(archivedRaw, /archivedAt: 2026-03-09T12:00:00.000Z/);

    const restored = await restoreMemoryGovernanceRun({
      memoryDir,
      runId: applyResult.runId,
      now: new Date("2026-03-09T12:30:00.000Z"),
    });

    assert.equal(restored.restoredActions >= 4, true);

    const restoredStorage = new StorageManager(memoryDir);
    const restoredDuplicate = await restoredStorage.getMemoryById("fact-duplicate-b");
    const restoredDisputed = await restoredStorage.getMemoryById("fact-disputed");
    const restoredSpeculative = await restoredStorage.getMemoryById("fact-speculative");
    const restoredStale = await restoredStorage.getMemoryById("fact-stale");
    assert.equal(restoredDuplicate?.frontmatter.status ?? "active", "active");
    assert.equal(restoredDisputed?.frontmatter.status ?? "active", "active");
    assert.equal(restoredSpeculative?.frontmatter.status ?? "active", "active");
    assert.ok(restoredStale);
    await assert.rejects(() => stat(path.join(memoryDir, "archive", "2026-03-09", "fact-stale.md")));

    const restoreRaw = JSON.parse(await readFile(applyResult.restorePath as string, "utf-8")) as { runId: string };
    assert.equal(restoreRaw.runId, applyResult.runId);
    const lifecycleEvents = await restoredStorage.readMemoryLifecycleEvents();
    const governanceEvent = lifecycleEvents.find((event) =>
      event.actor === "memory-governance.apply" && event.reasonCode === "exact_duplicate"
    );
    assert.ok(governanceEvent);
    assert.equal(governanceEvent.ruleVersion, "memory-governance.v2");
    assert.equal(governanceEvent.correlationId, applyResult.traceId);
    assert.deepEqual(governanceEvent.relatedMemoryIds, ["fact-duplicate-a"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("restore refuses to overwrite post-run edits", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-restore-conflict-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-1.md",
      memoryDoc({
        id: "fact-1",
        content: "This disputed memory should be quarantined for review.",
        verificationState: "disputed",
        lifecycleState: "candidate",
      }),
    );

    const applyResult = await runMemoryGovernance({
      memoryDir,
      mode: "apply",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    const updatedPath = path.join(memoryDir, "facts/2026-03-01/fact-1.md");
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-1.md",
      memoryDoc({
        id: "fact-1",
        content: "Operator edited this after the governance run.",
        status: "quarantined",
        verificationState: "disputed",
        lifecycleState: "candidate",
        updated: "2026-03-09T13:00:00.000Z",
      }),
    );

    await assert.rejects(
      () => restoreMemoryGovernanceRun({ memoryDir, runId: applyResult.runId }),
      /restore conflict/,
    );

    const currentRaw = await readFile(updatedPath, "utf-8");
    assert.match(currentRaw, /Operator edited this after the governance run/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("governance lifecycle metadata matches the selected review reason", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-reason-match-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-a.md",
      memoryDoc({
        id: "fact-a",
        content: "Canonical duplicate body.",
        confidence: 0.95,
        confidenceTier: "explicit",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-b.md",
      memoryDoc({
        id: "fact-b",
        content: "Canonical duplicate body.",
        confidence: 0.2,
        confidenceTier: "speculative",
        verificationState: "disputed",
        lifecycleState: "candidate",
      }),
    );

    await runMemoryGovernance({
      memoryDir,
      mode: "apply",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    const events = await new StorageManager(memoryDir).readMemoryLifecycleEvents();
    const disputedEvent = events.find((event) =>
      event.memoryId === "fact-b" && event.reasonCode === "disputed_memory"
    );
    assert.ok(disputedEvent);
    assert.deepEqual(disputedEvent.relatedMemoryIds, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("disputed stale memories stay quarantined instead of being archived", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-priority-"));
  try {
    await writeText(
      memoryDir,
      "facts/2025-01-01/fact-1.md",
      memoryDoc({
        id: "fact-1",
        content: "This stale disputed memory should still go to review.",
        updated: "2025-01-01T00:00:00.000Z",
        verificationState: "disputed",
        lifecycleState: "stale",
      }),
    );

    const result = await runMemoryGovernance({
      memoryDir,
      mode: "apply",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    assert.equal(result.appliedActions.some((action) => action.action === "archive"), false);
    const memory = await new StorageManager(memoryDir).getMemoryById("fact-1");
    assert.equal(memory?.frontmatter.status, "quarantined");
    await assert.rejects(() => stat(path.join(memoryDir, "archive", "2026-03-09", "fact-1.md")));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("governance surfaces semantic duplicates, queued explicit captures, malformed imports, and quality artifacts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-extended-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-semantic-a.md",
      memoryDoc({
        id: "fact-semantic-a",
        content: "The release checklist requires smoke tests before every production cutover, deploy, and handoff.",
        confidence: 0.95,
        confidenceTier: "explicit",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-semantic-b.md",
      memoryDoc({
        id: "fact-semantic-b",
        content: "The release checklist requires smoke tests before every production deploy and cutover handoff.",
        confidence: 0.55,
        confidenceTier: "inferred",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-03/fact-explicit-queued.md",
      memoryDoc({
        id: "fact-explicit-queued",
        content: "Explicit capture queued for review.\n\nReason: content failed memory sanitization\n\nSubmitted content:\nOperator should verify this suggestion.",
        source: "explicit-review",
        status: "pending_review",
        confidence: 0.2,
        confidenceTier: "speculative",
        tags: ["explicit-capture", "queued-review", "operator-review"],
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-03/fact-malformed.md",
      "---\nid: fact-malformed\ncategory: fact\ncreated: not-a-date\n",
    );

    const storage = new StorageManager(memoryDir);
    await storage.appendMemoryLifecycleEvents([
      {
        eventId: "mle-explicit-queued",
        memoryId: "fact-explicit-queued",
        eventType: "explicit_capture_queued",
        timestamp: "2026-03-03T00:00:00.000Z",
        actor: "tool.suggestion_submit",
        reasonCode: "policy queued for operator review",
        ruleVersion: "explicit-capture.v1",
      },
    ]);

    const result = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    assert.equal(result.reviewQueue.some((entry) => entry.reasonCode === "semantic_duplicate_candidate"), true);
    assert.equal(result.reviewQueue.some((entry) => entry.reasonCode === "explicit_capture_review"), true);
    assert.equal(result.reviewQueue.some((entry) => entry.reasonCode === "malformed_import"), true);
    const summary = JSON.parse(await readFile(result.summaryPath, "utf-8")) as { proposedActionCount: number };
    assert.equal(summary.proposedActionCount, 1);

    const keptMemoryIds = JSON.parse(await readFile(result.keptMemoriesPath, "utf-8")) as string[];
    assert.equal(keptMemoryIds.includes("fact-explicit-queued"), true);

    const qualityScore = JSON.parse(await readFile(result.qualityScorePath, "utf-8")) as {
      score: number;
      deductions: Array<{ reasonCode: string }>;
    };
    assert.equal(qualityScore.score < 100, true);
    assert.equal(qualityScore.deductions.some((entry) => entry.reasonCode === "malformed_import"), true);

    const transitionReport = JSON.parse(await readFile(result.transitionReportPath, "utf-8")) as {
      proposed: Record<string, Array<{ memoryId: string }>>;
    };
    assert.equal(
      transitionReport.proposed.pending_review?.some((action) => action.memoryId === "fact-semantic-b"),
      true,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("governance supports bounded recent scans without loading the full corpus into the run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-bounded-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-02-20/fact-old.md",
      memoryDoc({
        id: "fact-old",
        content: "Older memory outside the recent governance window.",
        created: "2026-02-20T00:00:00.000Z",
        updated: "2026-02-20T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-09/fact-recent-a.md",
      memoryDoc({
        id: "fact-recent-a",
        content: "Recent duplicate memory for bounded governance coverage.",
        created: "2026-03-09T00:00:00.000Z",
        updated: "2026-03-09T00:00:00.000Z",
        confidence: 0.95,
        confidenceTier: "explicit",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-recent-b.md",
      memoryDoc({
        id: "fact-recent-b",
        content: "Recent duplicate memory for bounded governance coverage.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
        confidence: 0.4,
        confidenceTier: "implied",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-11/fact-malformed.md",
      "not-frontmatter\n",
    );
    await writeText(
      memoryDir,
      "facts/2026-01-15/fact-malformed-stale.md",
      "not-frontmatter\n",
    );
    await setTimestamp(memoryDir, "facts/2026-02-20/fact-old.md", "2026-02-20T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-09/fact-recent-a.md", "2026-03-09T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-10/fact-recent-b.md", "2026-03-10T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-11/fact-malformed.md", "2026-03-10T12:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-01-15/fact-malformed-stale.md", "2026-01-15T00:00:00.000Z");

    const result = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-10T12:00:00.000Z"),
      recentDays: 2,
      maxMemories: 2,
      batchSize: 1,
    });

    const summary = JSON.parse(await readFile(result.summaryPath, "utf-8")) as {
      scannedMemories: number;
    };
    assert.equal(summary.scannedMemories, 2);
    assert.equal(result.reviewQueue.some((entry) => entry.reasonCode === "exact_duplicate"), true);
    assert.equal(result.reviewQueue.some((entry) => entry.reasonCode === "malformed_import"), true);
    assert.equal(result.reviewQueue.some((entry) => entry.memoryId === "fact-old"), false);
    assert.equal(
      result.reviewQueue.some((entry) => entry.path.endsWith("fact-malformed-stale.md")),
      false,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow includes recently updated memories from older folders", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-02-20/fact-old.md",
      memoryDoc({
        id: "fact-old",
        content: "Older memory that was updated recently.",
        created: "2026-02-20T00:00:00.000Z",
        updated: "2026-03-10T09:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-09/fact-stale.md",
      memoryDoc({
        id: "fact-stale",
        content: "Memory outside the recent update window.",
        created: "2026-03-09T00:00:00.000Z",
        updated: "2026-03-01T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-recent-b.md",
      memoryDoc({
        id: "fact-recent-b",
        content: "Recent memory B.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await setTimestamp(memoryDir, "facts/2026-02-20/fact-old.md", "2026-02-20T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-09/fact-stale.md", "2026-03-01T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-10/fact-recent-b.md", "2026-03-10T00:00:00.000Z");

    const storage = new StorageManager(memoryDir);
    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      batchSize: 1,
    });

    assert.deepEqual(
      window.memories.map((memory) => memory.frontmatter.id).sort(),
      ["fact-old", "fact-recent-b"],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow skips stale corrections during recent-only scans", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-corrections-"));
  try {
    await writeText(
      memoryDir,
      "corrections/correction-stale.md",
      memoryDoc({
        id: "correction-stale",
        category: "correction",
        content: "Older correction outside the recent update window.",
        created: "2026-03-01T00:00:00.000Z",
        updated: "2026-03-01T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-recent.md",
      memoryDoc({
        id: "fact-recent",
        content: "Recent memory.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await setTimestamp(memoryDir, "corrections/correction-stale.md", "2026-03-01T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-10/fact-recent.md", "2026-03-10T00:00:00.000Z");

    const storage = new StorageManager(memoryDir) as StorageManager & {
      readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
    };
    const originalReadParsed = storage.readParsedMemoriesFromPaths.bind(storage);
    const parsedBatches: string[][] = [];
    storage.readParsedMemoriesFromPaths = async (filePaths, batchSize) => {
      parsedBatches.push([...filePaths]);
      return originalReadParsed(filePaths, batchSize);
    };

    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      batchSize: 1,
    });

    assert.equal(
      parsedBatches.some((batch) => batch.some((filePath) => filePath.endsWith("correction-stale.md"))),
      false,
    );
    assert.deepEqual(window.memories.map((memory) => memory.frontmatter.id), ["fact-recent"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow falls back to file mtime for undated legacy memories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-undated-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-02-20/fact-undated.md",
      [
        "---",
        'id: "fact-undated"',
        'category: "fact"',
        'source: "legacy"',
        "---",
        "",
        "Legacy undated memory.",
      ].join("\n"),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-recent.md",
      memoryDoc({
        id: "fact-recent",
        content: "Recent memory.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await setTimestamp(memoryDir, "facts/2026-02-20/fact-undated.md", "2026-02-20T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-10/fact-recent.md", "2026-03-10T00:00:00.000Z");

    const storage = new StorageManager(memoryDir) as StorageManager & {
      readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
    };
    const originalReadParsed = storage.readParsedMemoriesFromPaths.bind(storage);
    const parsedBatches: string[][] = [];
    storage.readParsedMemoriesFromPaths = async (filePaths, batchSize) => {
      parsedBatches.push([...filePaths]);
      return originalReadParsed(filePaths, batchSize);
    };

    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      batchSize: 1,
    });

    assert.equal(
      parsedBatches.some((batch) => batch.some((filePath) => filePath.endsWith("fact-undated.md"))),
      false,
    );
    assert.deepEqual(window.memories.map((memory) => memory.frontmatter.id), ["fact-recent"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow limits parsed candidates to the remaining maxMemories budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-max-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-a.md",
      memoryDoc({
        id: "fact-a",
        content: "Recent memory A.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-b.md",
      memoryDoc({
        id: "fact-b",
        content: "Recent memory B.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-c.md",
      memoryDoc({
        id: "fact-c",
        content: "Recent memory C.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );

    const storage = new StorageManager(memoryDir) as StorageManager & {
      readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
    };
    const originalReadParsed = storage.readParsedMemoriesFromPaths.bind(storage);
    const parsedBatches: string[][] = [];
    storage.readParsedMemoriesFromPaths = async (filePaths, batchSize) => {
      parsedBatches.push([...filePaths]);
      return originalReadParsed(filePaths, batchSize);
    };

    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      maxMemories: 1,
      batchSize: 3,
    });

    assert.deepEqual(window.memories.map((memory) => memory.frontmatter.id), ["fact-c"]);
    assert.deepEqual(parsedBatches, [[path.join(memoryDir, "facts/2026-03-10/fact-c.md")]]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow gives corrections a bounded slot before consuming the full facts budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-fair-window-"));
  try {
    await writeText(
      memoryDir,
      "corrections/correction-recent.md",
      memoryDoc({
        id: "correction-recent",
        category: "correction",
        content: "Recent correction memory.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-a.md",
      memoryDoc({
        id: "fact-a",
        content: "Recent fact A.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-b.md",
      memoryDoc({
        id: "fact-b",
        content: "Recent fact B.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );

    const storage = new StorageManager(memoryDir) as StorageManager & {
      readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
    };
    const originalReadParsed = storage.readParsedMemoriesFromPaths.bind(storage);
    const parsedBatches: string[][] = [];
    storage.readParsedMemoriesFromPaths = async (filePaths, batchSize) => {
      parsedBatches.push([...filePaths]);
      return originalReadParsed(filePaths, batchSize);
    };

    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      maxMemories: 2,
      batchSize: 3,
    });

    assert.deepEqual(window.memories.map((memory) => memory.frontmatter.id), ["correction-recent", "fact-b"]);
    assert.deepEqual(parsedBatches, [
      [path.join(memoryDir, "corrections/correction-recent.md")],
      [path.join(memoryDir, "facts/2026-03-10/fact-b.md")],
    ]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow counts malformed candidates against the maxMemories window budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-malformed-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-c.md",
      "not valid frontmatter\n",
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-b.md",
      memoryDoc({
        id: "fact-b",
        content: "Recent fact B.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-a.md",
      memoryDoc({
        id: "fact-a",
        content: "Recent fact A.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );

    const storage = new StorageManager(memoryDir) as StorageManager & {
      readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
    };
    const originalReadParsed = storage.readParsedMemoriesFromPaths.bind(storage);
    const parsedBatches: string[][] = [];
    storage.readParsedMemoriesFromPaths = async (filePaths, batchSize) => {
      parsedBatches.push([...filePaths]);
      return originalReadParsed(filePaths, batchSize);
    };

    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      maxMemories: 2,
      batchSize: 1,
    });

    assert.deepEqual(window.filePaths, [
      path.join(memoryDir, "facts/2026-03-10/fact-c.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-b.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-a.md"),
    ]);
    assert.deepEqual(window.memories.map((memory) => memory.frontmatter.id), ["fact-b", "fact-a"]);
    assert.deepEqual(parsedBatches, [
      [path.join(memoryDir, "facts/2026-03-10/fact-c.md")],
      [path.join(memoryDir, "facts/2026-03-10/fact-b.md")],
      [path.join(memoryDir, "facts/2026-03-10/fact-a.md")],
    ]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow caps malformed-heavy scans inside a large batch", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-batch-budget-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-c.md",
      "not valid frontmatter\n",
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-b.md",
      memoryDoc({
        id: "fact-b",
        content: "Recent fact B.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-a.md",
      memoryDoc({
        id: "fact-a",
        content: "Recent fact A.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );

    const storage = new StorageManager(memoryDir) as StorageManager & {
      readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
    };
    const originalReadParsed = storage.readParsedMemoriesFromPaths.bind(storage);
    const parsedBatches: string[][] = [];
    storage.readParsedMemoriesFromPaths = async (filePaths, batchSize) => {
      parsedBatches.push([...filePaths]);
      return originalReadParsed(filePaths, batchSize);
    };

    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      maxMemories: 2,
      batchSize: 3,
    });

    assert.deepEqual(window.memories.map((memory) => memory.frontmatter.id), ["fact-b", "fact-a"]);
    assert.deepEqual(window.filePaths, [
      path.join(memoryDir, "facts/2026-03-10/fact-c.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-b.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-a.md"),
    ]);
    assert.deepEqual(parsedBatches, [
      [path.join(memoryDir, "facts/2026-03-10/fact-c.md")],
      [path.join(memoryDir, "facts/2026-03-10/fact-b.md")],
      [path.join(memoryDir, "facts/2026-03-10/fact-a.md")],
    ]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow bounds malformed-heavy batches to a finite inspection budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-malformed-cap-"));
  try {
    for (const name of ["fact-e", "fact-d", "fact-c", "fact-b", "fact-a"]) {
      await writeText(
        memoryDir,
        `facts/2026-03-10/${name}.md`,
        "not valid frontmatter\n",
      );
    }

    const storage = new StorageManager(memoryDir) as StorageManager & {
      readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
    };
    const originalReadParsed = storage.readParsedMemoriesFromPaths.bind(storage);
    const parsedBatches: string[][] = [];
    storage.readParsedMemoriesFromPaths = async (filePaths, batchSize) => {
      parsedBatches.push([...filePaths]);
      return originalReadParsed(filePaths, batchSize);
    };

    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      maxMemories: 2,
      batchSize: 5,
    });

    assert.deepEqual(window.memories, []);
    assert.deepEqual(window.filePaths, [
      path.join(memoryDir, "facts/2026-03-10/fact-e.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-d.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-c.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-b.md"),
    ]);
    assert.deepEqual(parsedBatches, [
      [path.join(memoryDir, "facts/2026-03-10/fact-e.md")],
      [path.join(memoryDir, "facts/2026-03-10/fact-d.md")],
      [path.join(memoryDir, "facts/2026-03-10/fact-c.md")],
      [path.join(memoryDir, "facts/2026-03-10/fact-b.md")],
    ]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow keeps all inspected malformed paths in bounded mixed ordering", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-mixed-malformed-"));
  try {
    await writeText(
      memoryDir,
      "corrections/2026-03-10/correction-bad.md",
      "not valid frontmatter\n",
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-z-good-b.md",
      memoryDoc({
        id: "fact-good-b",
        content: "Recent fact B.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-y-bad.md",
      "not valid frontmatter\n",
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-x-good-a.md",
      memoryDoc({
        id: "fact-good-a",
        content: "Recent fact A.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );

    const storage = new StorageManager(memoryDir);
    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      maxMemories: 2,
      batchSize: 4,
    });

    assert.deepEqual(window.memories.map((memory) => memory.frontmatter.id), ["fact-good-b", "fact-good-a"]);
    assert.deepEqual(window.filePaths, [
      path.join(memoryDir, "corrections/2026-03-10/correction-bad.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-z-good-b.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-y-bad.md"),
      path.join(memoryDir, "facts/2026-03-10/fact-x-good-a.md"),
    ]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow uses a small parallel window when the bounded budget is large", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-parallel-window-"));
  try {
    for (const name of ["fact-e", "fact-d", "fact-c", "fact-b", "fact-a"]) {
      await writeText(
        memoryDir,
        `facts/2026-03-10/${name}.md`,
        memoryDoc({
          id: name,
          content: `Recent memory ${name}.`,
          created: "2026-03-10T00:00:00.000Z",
          updated: "2026-03-10T00:00:00.000Z",
        }),
      );
    }

    const storage = new StorageManager(memoryDir) as StorageManager & {
      readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
    };
    const originalReadParsed = storage.readParsedMemoriesFromPaths.bind(storage);
    const parsedBatches: string[][] = [];
    storage.readParsedMemoriesFromPaths = async (filePaths, batchSize) => {
      parsedBatches.push([...filePaths]);
      return originalReadParsed(filePaths, batchSize);
    };

    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      maxMemories: 5,
      batchSize: 5,
    });

    assert.deepEqual(window.memories.map((memory) => memory.frontmatter.id), [
      "fact-e",
      "fact-d",
      "fact-c",
      "fact-b",
      "fact-a",
    ]);
    assert.deepEqual(parsedBatches, [
      [
        path.join(memoryDir, "facts/2026-03-10/fact-e.md"),
        path.join(memoryDir, "facts/2026-03-10/fact-d.md"),
        path.join(memoryDir, "facts/2026-03-10/fact-c.md"),
        path.join(memoryDir, "facts/2026-03-10/fact-b.md"),
      ],
      [path.join(memoryDir, "facts/2026-03-10/fact-a.md")],
    ]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoriesWindow trusts the pre-filtered recent window for invalid legacy timestamps", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-invalid-date-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-invalid-date.md",
      [
        "---",
        "id: fact-invalid-date",
        "category: fact",
        "source: legacy",
        "updated: not-a-date",
        "---",
        "",
        "Legacy memory with invalid updated timestamp.",
      ].join("\n"),
    );
    await setTimestamp(memoryDir, "facts/2026-03-10/fact-invalid-date.md", "2026-03-10T09:00:00.000Z");

    const storage = new StorageManager(memoryDir);
    const window = await storage.readMemoriesWindow({
      updatedAfter: new Date("2026-03-08T12:00:00.000Z"),
      maxMemories: 1,
      batchSize: 1,
    });

    assert.deepEqual(window.memories.map((memory) => memory.frontmatter.id), ["fact-invalid-date"]);
    assert.deepEqual(window.filePaths, [path.join(memoryDir, "facts/2026-03-10/fact-invalid-date.md")]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runMemoryGovernance uses bounded scan ordering for batchSize-only requests", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-batchsize-only-"));
  const originalReadAllMemories = StorageManager.prototype.readAllMemories;
  const originalReadMemoriesWindow = StorageManager.prototype.readMemoriesWindow;
  let readAllMemoriesCalls = 0;
  let readMemoriesWindowCalls = 0;
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-a.md",
      memoryDoc({
        id: "fact-a",
        content: "Batch-size only governance baseline.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );

    StorageManager.prototype.readAllMemories = async function readAllMemoriesSpy() {
      readAllMemoriesCalls += 1;
      return originalReadAllMemories.call(this);
    };
    StorageManager.prototype.readMemoriesWindow = async function readMemoriesWindowSpy(options) {
      readMemoriesWindowCalls += 1;
      return originalReadMemoriesWindow.call(this, options);
    };

    await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-10T12:00:00.000Z"),
      batchSize: 1,
    });

    assert.equal(readAllMemoriesCalls, 0);
    assert.equal(readMemoriesWindowCalls > 0, true);
  } finally {
    StorageManager.prototype.readAllMemories = originalReadAllMemories;
    StorageManager.prototype.readMemoriesWindow = originalReadMemoriesWindow;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("bounded governance apply reuses scanned memories without getMemoryById lookups", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-apply-window-"));
  const originalGetMemoryById = StorageManager.prototype.getMemoryById;
  let getMemoryByIdCalls = 0;
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-1.md",
      memoryDoc({
        id: "fact-1",
        content: "A disputed speculative memory for bounded apply coverage.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
        confidence: 0.2,
        confidenceTier: "speculative",
        verificationState: "disputed",
      }),
    );
    await setTimestamp(memoryDir, "facts/2026-03-10/fact-1.md", "2026-03-10T00:00:00.000Z");

    StorageManager.prototype.getMemoryById = async function getMemoryByIdSpy() {
      getMemoryByIdCalls += 1;
      throw new Error("bounded governance apply should not call getMemoryById");
    };

    const result = await runMemoryGovernance({
      memoryDir,
      mode: "apply",
      now: new Date("2026-03-10T12:00:00.000Z"),
      recentDays: 2,
      maxMemories: 10,
      batchSize: 1,
    });

    assert.equal(result.appliedActions.length > 0, true);
    assert.equal(getMemoryByIdCalls, 0);
  } finally {
    StorageManager.prototype.getMemoryById = originalGetMemoryById;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("bounded governance apply reloads the latest on-disk memory before mutating", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-apply-refresh-"));
  const originalReadMemoryByPath = StorageManager.prototype.readMemoryByPath;
  let refreshed = false;
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-1.md",
      memoryDoc({
        id: "fact-1",
        content: "Original memory content.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
        confidence: 0.2,
        confidenceTier: "speculative",
        verificationState: "disputed",
      }),
    );

    StorageManager.prototype.readMemoryByPath = async function readMemoryByPathRefresh(filePath: string) {
      if (!refreshed && filePath.endsWith("fact-1.md")) {
        refreshed = true;
        await writeText(
          memoryDir,
          "facts/2026-03-10/fact-1.md",
          memoryDoc({
            id: "fact-1",
            content: "Fresh on-disk memory content.",
            created: "2026-03-10T00:00:00.000Z",
            updated: "2026-03-10T06:00:00.000Z",
            confidence: 0.2,
            confidenceTier: "speculative",
            verificationState: "disputed",
          }),
        );
      }
      return originalReadMemoryByPath.call(this, filePath);
    };

    await runMemoryGovernance({
      memoryDir,
      mode: "apply",
      now: new Date("2026-03-10T12:00:00.000Z"),
      recentDays: 2,
      maxMemories: 10,
      batchSize: 1,
    });

    const refreshedMemory = await originalReadMemoryByPath.call(new StorageManager(memoryDir), path.join(
      memoryDir,
      "facts/2026-03-10/fact-1.md",
    ));
    assert.equal(refreshed, true);
    assert.equal(refreshedMemory?.content, "Fresh on-disk memory content.");
    assert.equal(refreshedMemory?.frontmatter.status, "quarantined");
  } finally {
    StorageManager.prototype.readMemoryByPath = originalReadMemoryByPath;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("governance apply marks restore entry applied before status mutation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-apply-premark-"));
  const originalWriteMemoryFrontmatter = StorageManager.prototype.writeMemoryFrontmatter;
  const now = new Date("2026-03-10T12:00:00.000Z");
  const runId = "gov-2026-03-10T12-00-00-000Z";
  let sawPremarkedRestore = false;
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-1.md",
      memoryDoc({
        id: "fact-1",
        content: "Disputed memory.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
        confidence: 0.2,
        confidenceTier: "speculative",
        verificationState: "disputed",
      }),
    );

    StorageManager.prototype.writeMemoryFrontmatter = async function writeMemoryFrontmatterWithRestoreCheck(...args) {
      const restorePath = path.join(memoryDir, "state", "memory-governance", "runs", runId, "restore.json");
      const restoreRaw = await readFile(restorePath, "utf-8");
      const restore = JSON.parse(restoreRaw) as { entries: Array<{ memoryId: string; applied: boolean }> };
      sawPremarkedRestore = restore.entries.some((entry) => entry.memoryId === "fact-1" && entry.applied === true);
      return originalWriteMemoryFrontmatter.apply(this, args);
    };

    await runMemoryGovernance({
      memoryDir,
      mode: "apply",
      now,
      recentDays: 2,
      maxMemories: 10,
      batchSize: 1,
    });

    assert.equal(sawPremarkedRestore, true);
  } finally {
    StorageManager.prototype.writeMemoryFrontmatter = originalWriteMemoryFrontmatter;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("bounded governance apply skips path reloads whose memory id changed", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-governance-apply-id-guard-"));
  const originalReadMemoryByPath = StorageManager.prototype.readMemoryByPath;
  let replaced = false;
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-1.md",
      memoryDoc({
        id: "fact-1",
        content: "Original disputed memory.",
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
        confidence: 0.2,
        confidenceTier: "speculative",
        verificationState: "disputed",
      }),
    );

    StorageManager.prototype.readMemoryByPath = async function readMemoryByPathWithReplacement(filePath: string) {
      if (!replaced && filePath.endsWith("fact-1.md")) {
        replaced = true;
        await writeText(
          memoryDir,
          "facts/2026-03-10/fact-1.md",
          memoryDoc({
            id: "fact-replacement",
            content: "Replacement memory at the same path.",
            created: "2026-03-10T01:00:00.000Z",
            updated: "2026-03-10T01:00:00.000Z",
            confidence: 0.95,
            confidenceTier: "high",
            verificationState: "verified",
            status: "active",
          }),
        );
      }
      return originalReadMemoryByPath.call(this, filePath);
    };

    const result = await runMemoryGovernance({
      memoryDir,
      mode: "apply",
      now: new Date("2026-03-10T12:00:00.000Z"),
      recentDays: 2,
      maxMemories: 10,
      batchSize: 1,
    });

    const replacementMemory = await originalReadMemoryByPath.call(new StorageManager(memoryDir), path.join(
      memoryDir,
      "facts/2026-03-10/fact-1.md",
    ));
    assert.equal(replaced, true);
    assert.equal(result.appliedActions.length, 0);
    assert.equal(replacementMemory?.frontmatter.id, "fact-replacement");
    assert.equal(replacementMemory?.frontmatter.status, "active");
  } finally {
    StorageManager.prototype.readMemoryByPath = originalReadMemoryByPath;
    await rm(memoryDir, { recursive: true, force: true });
  }
});
