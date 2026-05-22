import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  getWorkProductLedgerStatus,
  recordWorkProductLedgerEntry,
  resolveWorkProductLedgerDir,
  searchWorkProductLedgerEntries,
  validateWorkProductLedgerEntry,
} from "../src/work-product-ledger.js";
import {
  registerCli,
  runWorkProductRecordCliCommand,
  runWorkProductRecallSearchCliCommand,
  runWorkProductStatusCliCommand,
} from "../src/cli.js";

test("work-product ledger path resolves under memoryDir by default", () => {
  assert.equal(
    resolveWorkProductLedgerDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "work-product-ledger"),
  );
});

test("validateWorkProductLedgerEntry accepts the normalized contract", () => {
  const entry = validateWorkProductLedgerEntry({
    schemaVersion: 1,
    entryId: "wp-readme-refresh",
    recordedAt: "2026-03-07T23:20:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    kind: "artifact",
    action: "created",
    scope: "README.md",
    summary: "Created a refreshed README usage example for verified rules.",
    artifactPath: "README.md",
    objectiveStateSnapshotRefs: ["snap-readme-refresh"],
    entityRefs: ["repo:openclaw-engram"],
    tags: ["docs", "creation-memory"],
    metadata: { actor: "engram" },
  });

  assert.equal(entry.entryId, "wp-readme-refresh");
  assert.equal(entry.kind, "artifact");
  assert.deepEqual(entry.tags, ["docs", "creation-memory"]);
});

test("recordWorkProductLedgerEntry persists entries into dated storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-record-"));
  const filePath = await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-1",
      recordedAt: "2026-03-07T23:21:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "file",
      action: "updated",
      scope: "docs/config-reference.md",
      summary: "Updated config docs for creation-memory rollout.",
      artifactPath: "docs/config-reference.md",
      tags: ["docs"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "work-product-ledger", "entries", "2026-03-07", "wp-1.json"),
  );
});

test("recordWorkProductLedgerEntry rejects duplicate ids without overwriting the original entry", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-duplicate-"));
  const filePath = await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-duplicate",
      recordedAt: "2026-03-07T23:21:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "file",
      action: "updated",
      scope: "docs/config-reference.md",
      summary: "Original work-product entry.",
    },
  });

  await assert.rejects(
    () =>
      recordWorkProductLedgerEntry({
        memoryDir,
        entry: {
          schemaVersion: 1,
          entryId: "wp-duplicate",
          recordedAt: "2026-03-07T23:21:30.000Z",
          sessionKey: "agent:main",
          source: "cli",
          kind: "file",
          action: "deleted",
          scope: "docs/config-reference.md",
          summary: "Replacement work-product entry.",
        },
      }),
    /EEXIST|exists/i,
  );

  const stored = JSON.parse(await readFile(filePath, "utf8")) as { summary: string };
  assert.equal(stored.summary, "Original work-product entry.");
});

test("work-product ledger status reports valid and invalid entries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-status-"));
  await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-2",
      recordedAt: "2026-03-07T23:22:00.000Z",
      sessionKey: "agent:main",
      source: "tool_result",
      kind: "record",
      action: "created",
      scope: "salesforce:inventory:record-42",
      summary: "Created an inventory reconciliation record.",
      entityRefs: ["record:42"],
      tags: ["inventory"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "work-product-ledger",
    "entries",
    "2026-03-07",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, entryId: "" }, null, 2), "utf8");

  const status = await getWorkProductLedgerStatus({
    memoryDir,
    enabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.entries.total, 2);
  assert.equal(status.entries.valid, 1);
  assert.equal(status.entries.invalid, 1);
  assert.equal(status.entries.byKind.record, 1);
  assert.equal(status.latestEntry?.entryId, "wp-2");
  assert.match(status.invalidEntries[0]?.path ?? "", /invalid\.json$/);
});

test("work-product-record CLI command writes entries only when creation-memory is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-cli-record-"));

  const skipped = await runWorkProductRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: false,
    entry: {
      schemaVersion: 1,
      entryId: "wp-skip",
      recordedAt: "2026-03-07T23:23:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "artifact",
      action: "created",
      scope: "README.md",
      summary: "Would have created a README artifact entry.",
    },
  });
  assert.equal(skipped, null);

  const filePath = await runWorkProductRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    entry: {
      schemaVersion: 1,
      entryId: "wp-3",
      recordedAt: "2026-03-07T23:24:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "artifact",
      action: "created",
      scope: "README.md",
      summary: "Created a README artifact entry.",
      artifactPath: "README.md",
      tags: ["docs"],
    },
  });

  assert.match(filePath ?? "", /wp-3\.json$/);

  const status = await runWorkProductStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
  });
  assert.equal(status.entries.total, 1);
  assert.equal(status.latestEntry?.entryId, "wp-3");
});

test("work-product-record CLI wiring uses entryAction instead of Commander's reserved action option", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-cli-wiring-"));

  class MockCommand {
    children = new Map<string, MockCommand>();
    actionHandler?: (...args: unknown[]) => Promise<void> | void;

    constructor(readonly name: string) {}

    command(name: string): MockCommand {
      const child = new MockCommand(name);
      this.children.set(name, child);
      return child;
    }

    description(): MockCommand {
      return this;
    }

    option(): MockCommand {
      return this;
    }

    requiredOption(): MockCommand {
      return this;
    }

    argument(): MockCommand {
      return this;
    }

    action(handler: (...args: unknown[]) => Promise<void> | void): MockCommand {
      this.actionHandler = handler;
      return this;
    }
  }

  const root = new MockCommand("root");
  registerCli(
    {
      registerCli(handler: (opts: { program: MockCommand }) => void): void {
        handler({ program: root });
      },
    },
    {
      config: {
        memoryDir,
        workProductLedgerDir: path.join(memoryDir, "state", "work-product-ledger"),
        creationMemoryEnabled: true,
      },
    } as never,
  );

  const action = root.children.get("engram")?.children.get("work-product-record")?.actionHandler;
  assert.equal(typeof action, "function");

  await action?.({
    entryId: "wp-4",
    recordedAt: "2026-03-07T23:25:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    kind: "artifact",
    entryAction: "created",
    scope: "README.md",
    summary: "Created a README artifact entry through CLI registration wiring.",
  });

  const status = await runWorkProductStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
  });
  assert.equal(status.entries.total, 1);
  assert.equal(status.latestEntry?.entryId, "wp-4");
  assert.equal(status.latestEntry?.action, "created");
});

test("searchWorkProductLedgerEntries returns artifact reuse candidates with lexical matches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-search-"));

  await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-readme-guide",
      recordedAt: "2026-03-07T23:26:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "artifact",
      action: "created",
      scope: "README.md",
      summary: "Created the public README contributor guide for open source reuse.",
      artifactPath: "README.md",
      tags: ["docs", "oss"],
    },
  });

  await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-internal-report",
      recordedAt: "2026-03-07T23:27:00.000Z",
      sessionKey: "agent:ops",
      source: "cli",
      kind: "report",
      action: "created",
      scope: "incident-report.md",
      summary: "Created the internal incident report for overnight ops.",
      artifactPath: "incident-report.md",
      tags: ["ops"],
    },
  });

  const results = await searchWorkProductLedgerEntries({
    memoryDir,
    query: "reuse the open source README guide",
    maxResults: 3,
    sessionKey: "agent:main",
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.entry.entryId, "wp-readme-guide");
  assert.match(results[0]?.matchedFields.join(",") ?? "", /summary|scope|artifactPath|tags/i);
  assert.ok((results[0]?.score ?? 0) > 0);
});

test("runWorkProductRecallSearchCliCommand is gated by creation and recall flags", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-recall-cli-"));

  await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-reuse-snippet",
      recordedAt: "2026-03-07T23:28:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "artifact",
      action: "created",
      scope: "docs/getting-started.md",
      summary: "Created a getting-started snippet for future reuse.",
      artifactPath: "docs/getting-started.md",
      tags: ["docs", "reuse"],
    },
  });

  const disabled = await runWorkProductRecallSearchCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    workProductRecallEnabled: false,
    query: "reuse getting-started snippet",
    maxResults: 2,
    sessionKey: "agent:main",
  });
  assert.deepEqual(disabled, []);

  const enabled = await runWorkProductRecallSearchCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    workProductRecallEnabled: true,
    query: "reuse getting-started snippet",
    maxResults: 2,
    sessionKey: "agent:main",
  });
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0]?.entry.entryId, "wp-reuse-snippet");
});
