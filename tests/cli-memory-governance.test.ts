import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import {
  resolveMemoryDirForNamespace,
  runMemoryGovernanceCliCommand,
  runMemoryGovernanceReportCliCommand,
  runMemoryGovernanceRestoreCliCommand,
  runMemoryReviewDispositionCliCommand,
} from "../src/cli.ts";
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

function memoryDoc(
  id: string,
  content: string,
  options: {
    created?: string;
    updated?: string;
  } = {},
): string {
  return [
    "---",
    `id: ${id}`,
    "category: fact",
    `created: ${options.created ?? "2026-03-01T00:00:00.000Z"}`,
    `updated: ${options.updated ?? options.created ?? "2026-03-01T00:00:00.000Z"}`,
    "source: test",
    "confidence: 0.2",
    "confidenceTier: speculative",
    "verificationState: disputed",
    "lifecycleState: candidate",
    "tags: [\"governance\"]",
    "---",
    "",
    content,
    "",
  ].join("\n");
}

test("governance CLI helpers round-trip apply/report/restore artifacts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-memory-governance-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-1.md",
      memoryDoc("fact-1", "A disputed speculative memory."),
    );

    const applyResult = await runMemoryGovernanceCliCommand({
      memoryDir,
      mode: "apply",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    assert.equal(applyResult.appliedActions.length > 0, true);

    const report = await runMemoryGovernanceReportCliCommand({
      memoryDir,
      runId: applyResult.runId,
    });
    assert.equal(report.summary.runId, applyResult.runId);
    assert.equal(report.summary.traceId, applyResult.traceId);
    assert.equal(report.reviewQueue.length > 0, true);
    assert.equal(report.manifest.traceId, applyResult.traceId);
    assert.equal(report.metrics.reviewReasons.disputed_memory >= 1, true);

    const restored = await runMemoryGovernanceRestoreCliCommand({
      memoryDir,
      runId: applyResult.runId,
      now: new Date("2026-03-09T12:30:00.000Z"),
    });
    assert.equal(restored.restoredActions > 0, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("governance CLI forwards bounded scan options to the governance run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-memory-governance-bounded-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-02-20/fact-old.md",
      memoryDoc("fact-old", "Old memory outside the bounded governance window.", {
        created: "2026-02-20T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-09/fact-new-a.md",
      memoryDoc("fact-new-a", "Recent duplicate memory for CLI bounded governance.", {
        created: "2026-03-09T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-new-b.md",
      memoryDoc("fact-new-b", "Recent duplicate memory for CLI bounded governance.", {
        created: "2026-03-10T00:00:00.000Z",
      }),
    );
    await setTimestamp(memoryDir, "facts/2026-02-20/fact-old.md", "2026-02-20T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-09/fact-new-a.md", "2026-03-09T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-10/fact-new-b.md", "2026-03-10T00:00:00.000Z");

    const result = await runMemoryGovernanceCliCommand({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-10T12:00:00.000Z"),
      recentDays: 2,
      maxMemories: 2,
      batchSize: 1,
    });

    const summary = JSON.parse(await readFile(result.summaryPath, "utf-8")) as { scannedMemories: number };
    assert.equal(summary.scannedMemories, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("governance CLI clamps recentDays to a minimum of one day", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-memory-governance-clamp-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-old.md",
      memoryDoc("fact-old", "Old memory outside the minimum recent window.", {
        created: "2026-03-08T00:00:00.000Z",
        updated: "2026-03-08T00:00:00.000Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-10/fact-new.md",
      memoryDoc("fact-new", "Recent memory inside the minimum recent window.", {
        created: "2026-03-10T00:00:00.000Z",
        updated: "2026-03-10T00:00:00.000Z",
      }),
    );
    await setTimestamp(memoryDir, "facts/2026-03-08/fact-old.md", "2026-03-08T00:00:00.000Z");
    await setTimestamp(memoryDir, "facts/2026-03-10/fact-new.md", "2026-03-10T00:00:00.000Z");

    const result = await runMemoryGovernanceCliCommand({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-10T12:00:00.000Z"),
      recentDays: 0,
      batchSize: 1,
    });

    const summary = JSON.parse(await readFile(result.summaryPath, "utf-8")) as { scannedMemories: number };
    assert.equal(summary.scannedMemories, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("review disposition helper sets rejected status for operator action", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-review-disposition-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-1.md",
      [
        "---",
        "id: fact-1",
        "category: fact",
        "created: 2026-03-01T00:00:00.000Z",
        "updated: 2026-03-01T00:00:00.000Z",
        "source: test",
        "confidence: 0.9",
        "confidenceTier: explicit",
        "tags: [\"review\"]",
        "---",
        "",
        "Operator disposition target.",
        "",
      ].join("\n"),
    );

    const result = await runMemoryReviewDispositionCliCommand({
      memoryDir,
      memoryId: "fact-1",
      status: "rejected",
      reasonCode: "operator_review",
      now: new Date("2026-03-09T13:00:00.000Z"),
    });
    assert.equal(result.status, "rejected");

    const memory = await new StorageManager(memoryDir).getMemoryById("fact-1");
    assert.equal(memory?.frontmatter.status, "rejected");
    const events = await new StorageManager(memoryDir).readMemoryLifecycleEvents();
    const event = events.find((entry) => entry.memoryId === "fact-1" && entry.eventType === "rejected");
    assert.ok(event);
    assert.equal(event.actor, "cli.review-disposition");
    assert.equal(event.reasonCode, "operator_review");
    assert.equal(event.ruleVersion, "memory-governance.v1");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("resolveMemoryDirForNamespace rejects unsupported namespace overrides when namespaces are disabled", async () => {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: false,
      defaultNamespace: "global",
    },
  } as any;

  await assert.rejects(
    () => resolveMemoryDirForNamespace(orchestrator, "team-alpha", { rejectUnsupportedOverride: true }),
    /namespaces are disabled; cannot target namespace: team-alpha/,
  );

  assert.equal(
    await resolveMemoryDirForNamespace(orchestrator, "global", { rejectUnsupportedOverride: true }),
    "/tmp/engram",
  );
});

test("resolveMemoryDirForNamespace rejects traversal namespace segments", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-namespace-"));
  const orchestrator = {
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
    },
  } as any;

  try {
    for (const namespace of ["../team", "../../outside", "team/../other", ".", "..", "/tmp/outside", "team\\other"]) {
      await assert.rejects(
        () => resolveMemoryDirForNamespace(orchestrator, namespace),
        /invalid namespace/,
      );
    }

    assert.equal(
      await resolveMemoryDirForNamespace(orchestrator, "team-alpha"),
      path.join(memoryDir, "namespaces", "team-alpha"),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
