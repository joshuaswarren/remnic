import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  runLiveConnectorsOnce,
  type LiveConnectorDefinition,
} from "../packages/remnic-core/src/live-connectors-runner.js";
import {
  readConnectorState,
  withConnectorStateLock,
  writeConnectorState,
  type ConnectorConfig,
  type ConnectorCursor,
  type ConnectorDocument,
  type LiveConnector,
} from "../packages/remnic-core/src/connectors/live/index.js";
import type { LiveConnectorsConfig } from "../packages/remnic-core/src/types.js";

function defaultConnectorsConfig(): LiveConnectorsConfig {
  return {
    googleDrive: {
      enabled: false,
      clientId: "",
      clientSecret: "",
      refreshToken: "",
      pollIntervalMs: 300_000,
      folderIds: [],
    },
    notion: {
      enabled: false,
      token: "",
      databaseIds: [],
      pollIntervalMs: 300_000,
    },
    gmail: {
      enabled: false,
      clientId: "",
      clientSecret: "",
      refreshToken: "",
      userId: "me",
      query: "in:inbox",
      pollIntervalMs: 300_000,
    },
    github: {
      enabled: false,
      token: "",
      userLogin: "",
      repos: [],
      pollIntervalMs: 300_000,
      includeDiscussions: false,
    },
  };
}

async function withMemoryDir<T>(fn: (memoryDir: string) => Promise<T>): Promise<T> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-live-runner-"));
  try {
    return await fn(memoryDir);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

function makeCursor(value: string, updatedAt = "2026-04-28T00:00:00.000Z"): ConnectorCursor {
  return { kind: "test", value, updatedAt };
}

function makeDoc(id: string): ConnectorDocument {
  return {
    id,
    title: `Doc ${id}`,
    content: `Synthetic connector content for ${id}.`,
    source: {
      connector: "test-connector",
      externalId: id,
      fetchedAt: "2026-04-28T00:00:00.000Z",
    },
  };
}

function makeDefinition(
  overrides: Partial<LiveConnectorDefinition> & {
    docs?: ConnectorDocument[];
    nextCursor?: ConnectorCursor;
    seenCursors?: Array<ConnectorCursor | null>;
  } = {},
): LiveConnectorDefinition {
  const docs = overrides.docs ?? [makeDoc("one"), makeDoc("two")];
  const nextCursor = overrides.nextCursor ?? makeCursor("next");
  const seenCursors = overrides.seenCursors;
  const connector: LiveConnector = {
    id: "test-connector",
    displayName: "Test Connector",
    validateConfig: (raw: unknown) => raw as ConnectorConfig,
    syncIncremental: async ({ cursor }) => {
      seenCursors?.push(cursor);
      return { newDocs: docs, nextCursor };
    },
  };

  return {
    id: "test-connector",
    displayName: "Test Connector",
    enabled: true,
    pollIntervalMs: 60_000,
    rawConfig: { ok: true },
    validateConfig: (raw: unknown) => raw as ConnectorConfig,
    createConnector: () => connector,
    ...overrides,
  };
}

test("runLiveConnectorsOnce skips disabled definitions without assigning a due timestamp", async () => {
  await withMemoryDir(async (memoryDir) => {
    const ingested: ConnectorDocument[][] = [];
    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      ingestDocuments: async (docs) => {
        ingested.push(docs);
      },
      now: new Date("2026-04-28T12:00:00.000Z"),
      definitions: [makeDefinition({ enabled: false })],
    });

    assert.equal(summary.ranCount, 0);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.results[0].skippedReason, "disabled");
    assert.equal(summary.results[0].nextDueAt, null);
    assert.deepEqual(ingested, []);
    assert.equal(await readConnectorState(memoryDir, "test-connector"), null);
  });
});

test("runLiveConnectorsOnce does not read state for disabled connectors", async () => {
  await withMemoryDir(async (memoryDir) => {
    const stateDir = path.join(memoryDir, "state", "connectors");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "test-connector.json"), "{not-json", "utf-8");

    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      ingestDocuments: async () => {
        throw new Error("disabled connector should not ingest");
      },
      now: new Date("2026-04-28T12:00:00.000Z"),
      definitions: [makeDefinition({ enabled: false })],
    });

    assert.equal(summary.ranCount, 0);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.results[0].skippedReason, "disabled");
  });
});

test("runLiveConnectorsOnce reports state-read failures per connector", async () => {
  await withMemoryDir(async (memoryDir) => {
    const stateDir = path.join(memoryDir, "state", "connectors");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "test-connector.json"), "{not-json", "utf-8");

    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      ingestDocuments: async () => {},
      now: new Date("2026-04-28T12:00:00.000Z"),
      definitions: [
        makeDefinition(),
        makeDefinition({
          id: "second-connector",
          displayName: "Second Connector",
          docs: [makeDoc("second")],
        }),
      ],
    });

    assert.equal(summary.ranCount, 1);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.results[0].skippedReason, "state_read_error");
    assert.match(summary.results[0].error ?? "", /not valid JSON/);
    assert.equal(summary.results[1].id, "second-connector");
    assert.equal(summary.results[1].ran, true);
  });
});

test("runLiveConnectorsOnce skips enabled connectors that are not due", async () => {
  await withMemoryDir(async (memoryDir) => {
    await writeConnectorState(memoryDir, "test-connector", {
      id: "test-connector",
      cursor: makeCursor("prior"),
      lastSyncAt: "2026-04-28T11:59:30.000Z",
      lastSyncStatus: "success",
      totalDocsImported: 7,
    });

    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      ingestDocuments: async () => {
        throw new Error("not due connector should not ingest");
      },
      now: new Date("2026-04-28T12:00:00.000Z"),
      definitions: [makeDefinition({ pollIntervalMs: 60_000 })],
    });

    assert.equal(summary.ranCount, 0);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.results[0].skippedReason, "not_due");
    assert.equal(summary.results[0].nextDueAt, "2026-04-28T12:00:30.000Z");
  });
});

test("runLiveConnectorsOnce polls due connectors, ingests docs, and advances state", async () => {
  await withMemoryDir(async (memoryDir) => {
    const ingested: ConnectorDocument[][] = [];
    const seenCursors: Array<ConnectorCursor | null> = [];
    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      ingestDocuments: async (docs) => {
        ingested.push(docs);
      },
      now: new Date("2026-04-28T12:00:00.000Z"),
      definitions: [
        makeDefinition({
          seenCursors,
          nextCursor: makeCursor("after-sync"),
        }),
      ],
    });

    assert.equal(summary.ranCount, 1);
    assert.equal(summary.skippedCount, 0);
    assert.equal(summary.errorCount, 0);
    assert.equal(summary.totalDocsImported, 2);
    assert.equal(summary.results[0].ran, true);
    assert.equal(summary.results[0].nextDueAt, "2026-04-28T12:01:00.000Z");
    assert.deepEqual(seenCursors, [null]);
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].length, 2);

    const state = await readConnectorState(memoryDir, "test-connector");
    assert.equal(state?.cursor?.value, "after-sync");
    assert.equal(state?.lastSyncAt, "2026-04-28T12:00:00.000Z");
    assert.equal(state?.lastSyncStatus, "success");
    assert.equal(state?.totalDocsImported, 2);
  });
});

test("runLiveConnectorsOnce reports prior timing when cursor state write fails", async () => {
  await withMemoryDir(async (memoryDir) => {
    await writeConnectorState(memoryDir, "test-connector", {
      id: "test-connector",
      cursor: makeCursor("prior"),
      lastSyncAt: "2026-04-28T11:58:00.000Z",
      lastSyncStatus: "success",
      totalDocsImported: 7,
    });

    const stateDir = path.join(memoryDir, "state", "connectors");
    await chmod(stateDir, 0o500);
    try {
      const summary = await runLiveConnectorsOnce({
        memoryDir,
        connectors: defaultConnectorsConfig(),
        force: true,
        ingestDocuments: async () => {},
        now: new Date("2026-04-28T12:00:00.000Z"),
        definitions: [
          makeDefinition({
            docs: [makeDoc("after-failed-write")],
            nextCursor: makeCursor("after-sync"),
            pollIntervalMs: 60_000,
          }),
        ],
      });

      assert.equal(summary.ranCount, 1);
      assert.equal(summary.errorCount, 1);
      assert.equal(summary.results[0].ran, true);
      assert.match(summary.results[0].stateWriteError ?? "", /EACCES|EPERM/);
      assert.equal(summary.results[0].lastSyncAt, "2026-04-28T11:58:00.000Z");
      assert.equal(summary.results[0].nextDueAt, "2026-04-28T11:59:00.000Z");
    } finally {
      await chmod(stateDir, 0o700);
    }

    const state = await readConnectorState(memoryDir, "test-connector");
    assert.equal(state?.cursor?.value, "prior");
    assert.equal(state?.lastSyncAt, "2026-04-28T11:58:00.000Z");
  });
});

test("runLiveConnectorsOnce reports prior timing when error state write fails", async () => {
  await withMemoryDir(async (memoryDir) => {
    await writeConnectorState(memoryDir, "test-connector", {
      id: "test-connector",
      cursor: makeCursor("prior"),
      lastSyncAt: "2026-04-28T11:58:00.000Z",
      lastSyncStatus: "success",
      totalDocsImported: 7,
    });

    const stateDir = path.join(memoryDir, "state", "connectors");
    await chmod(stateDir, 0o500);
    try {
      const summary = await runLiveConnectorsOnce({
        memoryDir,
        connectors: defaultConnectorsConfig(),
        force: true,
        ingestDocuments: async () => {
          throw new Error("memory layer unavailable");
        },
        now: new Date("2026-04-28T12:00:00.000Z"),
        definitions: [
          makeDefinition({
            docs: [makeDoc("after-failed-ingest")],
            pollIntervalMs: 60_000,
          }),
        ],
      });

      assert.equal(summary.ranCount, 1);
      assert.equal(summary.errorCount, 1);
      assert.equal(summary.results[0].ran, true);
      assert.match(summary.results[0].error ?? "", /memory layer unavailable/);
      assert.match(summary.results[0].stateWriteError ?? "", /EACCES|EPERM/);
      assert.equal(summary.results[0].lastSyncAt, "2026-04-28T11:58:00.000Z");
      assert.equal(summary.results[0].nextDueAt, "2026-04-28T11:59:00.000Z");
    } finally {
      await chmod(stateDir, 0o700);
    }

    const state = await readConnectorState(memoryDir, "test-connector");
    assert.equal(state?.cursor?.value, "prior");
    assert.equal(state?.lastSyncAt, "2026-04-28T11:58:00.000Z");
  });
});

test("runLiveConnectorsOnce force bypasses the not-due gate", async () => {
  await withMemoryDir(async (memoryDir) => {
    await writeConnectorState(memoryDir, "test-connector", {
      id: "test-connector",
      cursor: makeCursor("prior"),
      lastSyncAt: "2026-04-28T11:59:30.000Z",
      lastSyncStatus: "success",
      totalDocsImported: 7,
    });

    const seenCursors: Array<ConnectorCursor | null> = [];
    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      force: true,
      ingestDocuments: async () => {},
      now: new Date("2026-04-28T12:00:00.000Z"),
      definitions: [
        makeDefinition({
          seenCursors,
          docs: [],
          nextCursor: makeCursor("forced"),
        }),
      ],
    });

    assert.equal(summary.force, true);
    assert.equal(summary.ranCount, 1);
    assert.equal(summary.skippedCount, 0);
    assert.equal(seenCursors[0]?.value, "prior");

    const state = await readConnectorState(memoryDir, "test-connector");
    assert.equal(state?.cursor?.value, "forced");
    assert.equal(state?.totalDocsImported, 7);
  });
});

test("runLiveConnectorsOnce rechecks due state after waiting for connector lock", async () => {
  await withMemoryDir(async (memoryDir) => {
    await writeConnectorState(memoryDir, "test-connector", {
      id: "test-connector",
      cursor: makeCursor("prior"),
      lastSyncAt: "2026-04-28T11:58:00.000Z",
      lastSyncStatus: "success",
      totalDocsImported: 7,
    });

    let releaseLock!: () => void;
    const lockCanFinish = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockHolder = withConnectorStateLock(memoryDir, "test-connector", async () => {
      await lockCanFinish;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    const seenCursors: Array<ConnectorCursor | null> = [];
    const run = runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      ingestDocuments: async () => {
        throw new Error("locked not-due connector should not ingest");
      },
      now: new Date("2026-04-28T12:00:00.000Z"),
      definitions: [makeDefinition({ pollIntervalMs: 60_000, seenCursors })],
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await writeConnectorState(memoryDir, "test-connector", {
      id: "test-connector",
      cursor: makeCursor("advanced"),
      lastSyncAt: "2026-04-28T11:59:30.000Z",
      lastSyncStatus: "success",
      totalDocsImported: 9,
    });
    releaseLock();
    await lockHolder;

    const summary = await run;
    assert.equal(summary.ranCount, 0);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.results[0].skippedReason, "not_due");
    assert.deepEqual(seenCursors, []);
  });
});

test("runLiveConnectorsOnce evaluates due state with per-connector time", async () => {
  await withMemoryDir(async (memoryDir) => {
    await writeConnectorState(memoryDir, "second-connector", {
      id: "second-connector",
      cursor: makeCursor("prior"),
      lastSyncAt: "2026-04-28T12:00:00.000Z",
      lastSyncStatus: "success",
      totalDocsImported: 0,
    });

    const times = [
      "2026-04-28T12:00:00.000Z", // summary ranAt
      "2026-04-28T12:00:00.000Z", // first connector due check
      "2026-04-28T12:00:00.200Z", // first connector state write
      "2026-04-28T12:00:00.200Z", // second connector due check
      "2026-04-28T12:00:00.200Z", // second connector state write
    ].map((value) => new Date(value));
    const now = () => times.shift() ?? new Date("2026-04-28T12:00:00.200Z");

    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      ingestDocuments: async () => {},
      now,
      definitions: [
        makeDefinition({
          docs: [],
          pollIntervalMs: 60_000,
        }),
        makeDefinition({
          id: "second-connector",
          displayName: "Second Connector",
          docs: [],
          nextCursor: makeCursor("second-next"),
          pollIntervalMs: 100,
        }),
      ],
    });

    assert.equal(summary.ranCount, 2);
    assert.equal(summary.skippedCount, 0);
    assert.equal(summary.results[1].id, "second-connector");
    assert.equal(summary.results[1].ran, true);
  });
});

test("runLiveConnectorsOnce records invalid config without aborting the batch", async () => {
  await withMemoryDir(async (memoryDir) => {
    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      ingestDocuments: async () => {},
      now: new Date("2026-04-28T12:00:00.000Z"),
      definitions: [
        makeDefinition({
          validateConfig: () => {
            throw new Error("missing token");
          },
        }),
        makeDefinition({
          id: "second-connector",
          displayName: "Second Connector",
          docs: [makeDoc("second")],
        }),
      ],
    });

    assert.equal(summary.ranCount, 1);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.results[0].skippedReason, "invalid_config");
    assert.match(summary.results[0].error ?? "", /missing token/);
    assert.equal(summary.results[0].lastSyncAt, "2026-04-28T12:00:00.000Z");
    assert.equal(summary.results[0].nextDueAt, "2026-04-28T12:01:00.000Z");
    assert.equal(summary.results[1].id, "second-connector");
    assert.equal(summary.results[1].ran, true);

    const failedState = await readConnectorState(memoryDir, "test-connector");
    assert.equal(failedState?.lastSyncStatus, "error");
    assert.equal(failedState?.lastSyncAt, "2026-04-28T12:00:00.000Z");
    assert.match(failedState?.lastSyncError ?? "", /missing token/);
  });
});

test("runLiveConnectorsOnce reports connector factory failures per connector", async () => {
  await withMemoryDir(async (memoryDir) => {
    const summary = await runLiveConnectorsOnce({
      memoryDir,
      connectors: defaultConnectorsConfig(),
      ingestDocuments: async () => {},
      now: new Date("2026-04-28T12:00:00.000Z"),
      definitions: [
        makeDefinition({
          createConnector: () => {
            throw new Error("optional dependency missing");
          },
        }),
        makeDefinition({
          id: "second-connector",
          displayName: "Second Connector",
          docs: [makeDoc("second")],
        }),
      ],
    });

    assert.equal(summary.ranCount, 1);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.results[0].skippedReason, "connector_error");
    assert.match(summary.results[0].error ?? "", /optional dependency missing/);
    assert.equal(summary.results[0].lastSyncAt, "2026-04-28T12:00:00.000Z");
    assert.equal(summary.results[0].nextDueAt, "2026-04-28T12:01:00.000Z");
    assert.equal(summary.results[1].id, "second-connector");
    assert.equal(summary.results[1].ran, true);

    const failedState = await readConnectorState(memoryDir, "test-connector");
    assert.equal(failedState?.lastSyncStatus, "error");
    assert.match(failedState?.lastSyncError ?? "", /optional dependency missing/);
  });
});
