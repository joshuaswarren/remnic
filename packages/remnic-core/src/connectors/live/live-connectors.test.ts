import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONNECTOR_ID_PATTERN,
  createGitHubConnector,
  createGmailConnector,
  createGoogleDriveConnector,
  createNotionConnector,
  type ConnectorConfig,
  type ConnectorCursor,
  type ConnectorDocument,
  type ConnectorSyncStatus,
  type LiveConnector,
  LiveConnectorRegistry,
  LiveConnectorRegistryError,
  persistableConnectorConfig,
  redactConnectorConfigSecrets,
  type SyncIncrementalArgs,
  type SyncIncrementalResult,
  isValidConnectorId,
  listConnectorStates,
  readConnectorState,
  withConnectorStateLock,
  writeConnectorState,
} from "./index.js";
import {
  persistableConnectorConfig as persistableConnectorConfigFromRoot,
  redactConnectorConfigSecrets as redactConnectorConfigSecretsFromRoot,
} from "../../index.js";
import {
  _connectorStatePathForTest,
  _refreshConnectorLockForTest,
  _releaseConnectorLockForTest,
  _tryAcquireConnectorLockForTest,
  _unlinkStaleConnectorLockForTest,
  _withConnectorStateLockForTest,
} from "./state-store.js";

/**
 * Mock `LiveConnector`. Exists primarily as a compile-time assertion that
 * the published interface is satisfiable from outside the framework module
 * — if a future change drops a method or tightens a signature, this stops
 * compiling.
 */
class MockConnector implements LiveConnector {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  syncCalls = 0;

  constructor(id: string, displayName = `Mock ${id}`) {
    this.id = id;
    this.displayName = displayName;
  }

  validateConfig(raw: unknown): ConnectorConfig {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("config must be an object");
    }
    return raw as ConnectorConfig;
  }

  async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
    this.syncCalls++;
    const newDocs: ConnectorDocument[] = [
      {
        id: `${this.id}-doc-1`,
        title: "Synthetic doc",
        content: "synthetic body",
        source: {
          connector: this.id,
          externalId: `${this.id}-ext-1`,
          fetchedAt: new Date().toISOString(),
        },
      },
    ];
    const nextCursor: ConnectorCursor = {
      kind: "counter",
      value: String((args.cursor?.value ? Number(args.cursor.value) : 0) + 1),
      updatedAt: new Date().toISOString(),
    };
    return { newDocs, nextCursor };
  }
}

function makeMemoryDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-live-connectors-test-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  return dir;
}

// ───────────────────────────────────────────────────────────────────────────
// Connector id validation
// ───────────────────────────────────────────────────────────────────────────

test("isValidConnectorId accepts well-formed ids", () => {
  for (const id of ["a", "abc", "drive", "g-mail", "github-issues", "0", "abc123-xyz"]) {
    assert.equal(isValidConnectorId(id), true, `expected ${id} to be valid`);
  }
});

test("isValidConnectorId rejects malformed ids", () => {
  for (const id of [
    "",
    "Drive", // uppercase
    "-leading-dash", // must start with alphanumeric
    "trailing-dash-",
    "white space",
    "slash/y",
    "a".repeat(65), // > 64
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isValidConnectorId(id as unknown), false, `expected ${String(id)} to be invalid`);
  }
});

test("CONNECTOR_ID_PATTERN matches isValidConnectorId", () => {
  assert.ok(CONNECTOR_ID_PATTERN.test("drive"));
  assert.ok(!CONNECTOR_ID_PATTERN.test("Drive"));
});

test("redactConnectorConfigSecrets removes nested secret-shaped keys", () => {
  assert.deepEqual(
    redactConnectorConfigSecrets({
      endpoint: "https://example.invalid",
      authorization: "Bearer synthetic-token",
      authHeader: "Basic synthetic-credentials",
      authorName: "kept",
      nested: {
        accessToken: "synthetic-token",
        cookieHeader: "sid=synthetic-session",
        publicLabel: "kept",
      },
      list: [
        { clientSecret: "synthetic-secret", sessionCookie: "synthetic-cookie", label: "kept" },
      ],
    }),
    {
      endpoint: "https://example.invalid",
      authorName: "kept",
      nested: {
        publicLabel: "kept",
      },
      list: [{ label: "kept" }],
    }
  );
});

test("persisted-config helpers are exported from the package root", () => {
  assert.equal(persistableConnectorConfigFromRoot, persistableConnectorConfig);
  assert.equal(redactConnectorConfigSecretsFromRoot, redactConnectorConfigSecrets);
});

test("built-in live connectors expose persistable config without credential material", () => {
  const cases: Array<{
    connector: LiveConnector;
    raw: ConnectorConfig;
    secretKeys: readonly string[];
    secretValues: readonly string[];
    expected: ConnectorConfig;
  }> = [
    {
      connector: createGitHubConnector(),
      raw: {
        token: "synthetic-github-token",
        userLogin: "octocat",
        repos: ["owner/repo"],
        pollIntervalMs: 300_000,
        includeDiscussions: true,
      },
      secretKeys: ["token"],
      secretValues: ["synthetic-github-token"],
      expected: {
        userLogin: "octocat",
        repos: ["owner/repo"],
        pollIntervalMs: 300_000,
        includeDiscussions: true,
      },
    },
    {
      connector: createGmailConnector(),
      raw: {
        clientId: "synthetic-gmail-client-id",
        clientSecret: "synthetic-gmail-client-secret",
        refreshToken: "synthetic-gmail-refresh-token",
        userId: "me",
        query: "in:inbox",
        pollIntervalMs: 300_000,
      },
      secretKeys: ["clientSecret", "refreshToken"],
      secretValues: ["synthetic-gmail-client-secret", "synthetic-gmail-refresh-token"],
      expected: {
        clientId: "synthetic-gmail-client-id",
        userId: "me",
        query: "in:inbox",
        pollIntervalMs: 300_000,
      },
    },
    {
      connector: createGoogleDriveConnector(),
      raw: {
        clientId: "synthetic-drive-client-id",
        clientSecret: "synthetic-drive-client-secret",
        refreshToken: "synthetic-drive-refresh-token",
        folderIds: ["folder_12345678"],
        pollIntervalMs: 300_000,
      },
      secretKeys: ["clientSecret", "refreshToken"],
      secretValues: ["synthetic-drive-client-secret", "synthetic-drive-refresh-token"],
      expected: {
        clientId: "synthetic-drive-client-id",
        folderIds: ["folder_12345678"],
        pollIntervalMs: 300_000,
      },
    },
    {
      connector: createNotionConnector(),
      raw: {
        token: "secret_synthetic-notion-token",
        databaseIds: ["0123456789abcdef0123456789abcdef"],
        pollIntervalMs: 300_000,
      },
      secretKeys: ["token"],
      secretValues: ["secret_synthetic-notion-token"],
      expected: {
        databaseIds: ["0123456789abcdef0123456789abcdef"],
        pollIntervalMs: 300_000,
      },
    },
  ];

  for (const testCase of cases) {
    const runtimeConfig = testCase.connector.validateConfig(testCase.raw);
    for (const key of testCase.secretKeys) {
      assert.ok(key in runtimeConfig, `${testCase.connector.id} runtime config should keep ${key}`);
    }

    const persisted = persistableConnectorConfig(testCase.connector, runtimeConfig);
    assert.deepEqual(persisted, testCase.expected);
    const persistedJson = JSON.stringify(persisted);
    for (const key of testCase.secretKeys) {
      assert.ok(!(key in persisted), `${testCase.connector.id} persisted config should omit ${key}`);
    }
    for (const value of testCase.secretValues) {
      assert.ok(
        !persistedJson.includes(value),
        `${testCase.connector.id} persisted config leaked ${value}`,
      );
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Registry
// ───────────────────────────────────────────────────────────────────────────

test("registry: register, get, list, unregister, size", () => {
  const reg = new LiveConnectorRegistry();
  assert.equal(reg.size(), 0);
  assert.equal(reg.list().length, 0);

  const a = new MockConnector("alpha");
  const b = new MockConnector("bravo");
  reg.register(a);
  reg.register(b);

  assert.equal(reg.size(), 2);
  assert.equal(reg.get("alpha"), a);
  assert.equal(reg.get("bravo"), b);
  assert.equal(reg.get("missing"), undefined);

  // list() is sorted by id for stable enumeration
  const ids = reg.list().map((c) => c.id);
  assert.deepEqual(ids, ["alpha", "bravo"]);

  assert.equal(reg.unregister("alpha"), true);
  assert.equal(reg.unregister("alpha"), false); // already gone
  assert.equal(reg.size(), 1);
  assert.equal(reg.get("alpha"), undefined);
});

test("registry: rejects duplicate ids", () => {
  const reg = new LiveConnectorRegistry();
  reg.register(new MockConnector("dup"));
  assert.throws(() => reg.register(new MockConnector("dup")), LiveConnectorRegistryError);
});

test("registry: rejects invalid ids", () => {
  const reg = new LiveConnectorRegistry();
  assert.throws(() => reg.register(new MockConnector("Bad-Caps")), LiveConnectorRegistryError);
  assert.throws(() => reg.register(new MockConnector("-leading-dash")), LiveConnectorRegistryError);
  assert.throws(() => reg.register(new MockConnector("a".repeat(65))), LiveConnectorRegistryError);
});

test("registry: rejects connectors missing required fields", () => {
  const reg = new LiveConnectorRegistry();
  // Cast through unknown to bypass TypeScript and exercise the runtime guard.
  assert.throws(
    () =>
      reg.register({
        id: "bad",
        displayName: "",
        validateConfig: () => ({}),
        syncIncremental: async () => ({
          newDocs: [],
          nextCursor: { kind: "x", value: "0", updatedAt: new Date().toISOString() },
        }),
      } as unknown as LiveConnector),
    LiveConnectorRegistryError
  );

  assert.throws(
    () =>
      reg.register({
        id: "bad2",
        displayName: "ok",
        validateConfig: () => ({}),
        // missing syncIncremental
      } as unknown as LiveConnector),
    LiveConnectorRegistryError
  );

  assert.throws(() => reg.register(null as unknown as LiveConnector), LiveConnectorRegistryError);
});

// ───────────────────────────────────────────────────────────────────────────
// State store: round-trip
// ───────────────────────────────────────────────────────────────────────────

test("state store: write/read round-trip", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const cursor: ConnectorCursor = {
    kind: "pageToken",
    value: "abc123",
    updatedAt: new Date().toISOString(),
  };
  const written = await writeConnectorState(memoryDir, "drive", {
    id: "drive",
    cursor,
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: "success",
    totalDocsImported: 17,
  });
  assert.equal(written.id, "drive");
  assert.equal(written.lastSyncStatus, "success");
  assert.equal(written.totalDocsImported, 17);
  assert.ok(written.updatedAt, "updatedAt should be stamped");

  const read = await readConnectorState(memoryDir, "drive");
  assert.ok(read);
  assert.equal(read!.id, "drive");
  assert.deepEqual(read!.cursor, cursor);
  assert.equal(read!.totalDocsImported, 17);
  assert.equal(read!.lastSyncStatus, "success");
});

test("state store: ENOENT returns null", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const result = await readConnectorState(memoryDir, "nonexistent");
  assert.equal(result, null);
});

test("state store: file is valid JSON on disk", async (t) => {
  const memoryDir = makeMemoryDir(t);
  await writeConnectorState(memoryDir, "notion", {
    id: "notion",
    cursor: null,
    lastSyncAt: null,
    lastSyncStatus: "never",
    totalDocsImported: 0,
  });
  const filePath = _connectorStatePathForTest(memoryDir, "notion");
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.id, "notion");
  assert.equal(parsed.cursor, null);
  assert.equal(parsed.lastSyncStatus, "never");
});

test("state store: lives at <memoryDir>/state/connectors/<id>.json", async (t) => {
  const memoryDir = makeMemoryDir(t);
  await writeConnectorState(memoryDir, "github", {
    id: "github",
    cursor: null,
    lastSyncAt: null,
    lastSyncStatus: "never",
    totalDocsImported: 0,
  });
  const expected = path.join(memoryDir, "state", "connectors", "github.json");
  assert.ok(fs.existsSync(expected), `expected state file at ${expected}`);
});

test("state store: listConnectorStates enumerates and is sorted", async (t) => {
  const memoryDir = makeMemoryDir(t);
  await writeConnectorState(memoryDir, "zeta", {
    id: "zeta",
    cursor: null,
    lastSyncAt: null,
    lastSyncStatus: "never",
    totalDocsImported: 0,
  });
  await writeConnectorState(memoryDir, "alpha", {
    id: "alpha",
    cursor: null,
    lastSyncAt: null,
    lastSyncStatus: "never",
    totalDocsImported: 0,
  });
  await writeConnectorState(memoryDir, "mike", {
    id: "mike",
    cursor: null,
    lastSyncAt: null,
    lastSyncStatus: "never",
    totalDocsImported: 0,
  });

  const states = await listConnectorStates(memoryDir);
  assert.deepEqual(
    states.map((s) => s.id),
    ["alpha", "mike", "zeta"]
  );
});

test("state store: listConnectorStates returns [] for missing dir", async (t) => {
  const memoryDir = makeMemoryDir(t);
  // Don't write anything — directory doesn't exist yet.
  const states = await listConnectorStates(memoryDir);
  assert.deepEqual(states, []);
});

test("state store: listConnectorStates skips non-matching files", async (t) => {
  const memoryDir = makeMemoryDir(t);
  await writeConnectorState(memoryDir, "real", {
    id: "real",
    cursor: null,
    lastSyncAt: null,
    lastSyncStatus: "never",
    totalDocsImported: 0,
  });
  // Drop in stray files that should be ignored.
  const dir = path.join(memoryDir, "state", "connectors");
  fs.writeFileSync(path.join(dir, "real.json~"), "backup");
  fs.writeFileSync(path.join(dir, ".swp"), "swap");
  fs.writeFileSync(path.join(dir, "Bad-Caps.json"), '{"id":"Bad-Caps"}');
  fs.writeFileSync(path.join(dir, "corrupt.json"), "{ not valid");

  const states = await listConnectorStates(memoryDir);
  assert.deepEqual(
    states.map((s) => s.id),
    ["real"]
  );
});

// ───────────────────────────────────────────────────────────────────────────
// State store: cursor monotonicity / overwrite / atomic write
// ───────────────────────────────────────────────────────────────────────────

test("state store: writing twice with same id overwrites", async (t) => {
  const memoryDir = makeMemoryDir(t);
  await writeConnectorState(memoryDir, "drive", {
    id: "drive",
    cursor: { kind: "pageToken", value: "old", updatedAt: new Date().toISOString() },
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: "success",
    totalDocsImported: 1,
  });
  await writeConnectorState(memoryDir, "drive", {
    id: "drive",
    cursor: { kind: "pageToken", value: "new", updatedAt: new Date().toISOString() },
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: "success",
    totalDocsImported: 5,
  });
  const read = await readConnectorState(memoryDir, "drive");
  assert.equal(read!.cursor!.value, "new");
  assert.equal(read!.totalDocsImported, 5);
});

test("state store: previous good state is preserved when a new write fails", async (t) => {
  const memoryDir = makeMemoryDir(t);
  // First, persist a known-good state.
  await writeConnectorState(memoryDir, "drive", {
    id: "drive",
    cursor: { kind: "pageToken", value: "good", updatedAt: new Date().toISOString() },
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: "success",
    totalDocsImported: 3,
  });
  const goodPath = _connectorStatePathForTest(memoryDir, "drive");
  const goodBody = fs.readFileSync(goodPath, "utf-8");
  assert.match(goodBody, /"value": "good"/);

  // Now attempt a write with mismatched id — should reject before touching disk.
  await assert.rejects(
    writeConnectorState(memoryDir, "drive", {
      // id does not match argument
      id: "other",
      cursor: null,
      lastSyncAt: null,
      lastSyncStatus: "never",
      totalDocsImported: 0,
    }),
    /does not match/
  );

  // The good file must still be readable and unchanged.
  assert.equal(fs.readFileSync(goodPath, "utf-8"), goodBody);
  const read = await readConnectorState(memoryDir, "drive");
  assert.equal(read!.cursor!.value, "good");
  assert.equal(read!.totalDocsImported, 3);
});

test("state store: rejects invalid id at boundary", async (t) => {
  const memoryDir = makeMemoryDir(t);
  await assert.rejects(() => readConnectorState(memoryDir, "Bad-Caps"), /invalid connector id/);
  await assert.rejects(
    () =>
      writeConnectorState(memoryDir, "../escape" as string, {
        id: "../escape",
        cursor: null,
        lastSyncAt: null,
        lastSyncStatus: "never",
        totalDocsImported: 0,
      }),
    /invalid connector id/
  );
});

test("state store: rejects invalid lastSyncStatus at boundary (PR #724 review)", async (t) => {
  // P1 review: writeConnectorState must validate lastSyncStatus before
  // writing — otherwise readConnectorState's shape check rejects the file
  // and bricks the cursor until manual repair.
  const memoryDir = makeMemoryDir(t);
  await assert.rejects(
    () =>
      writeConnectorState(memoryDir, "drive", {
        id: "drive",
        cursor: null,
        lastSyncAt: null,
        // Bypass TypeScript to exercise the runtime guard the way an
        // untyped JS caller would.
        lastSyncStatus: "BOGUS" as unknown as ConnectorSyncStatus,
        totalDocsImported: 0,
      } as unknown as Parameters<typeof writeConnectorState>[2]),
    /lastSyncStatus must be one of/
  );
  // And the file must NOT have been written.
  const after = await readConnectorState(memoryDir, "drive");
  assert.equal(after, null);
});

test("state store: rejects malformed cursor at boundary (PR #724 review)", async (t) => {
  const memoryDir = makeMemoryDir(t);
  await assert.rejects(
    () =>
      writeConnectorState(memoryDir, "drive", {
        id: "drive",
        // Missing `value` and `updatedAt`.
        cursor: { kind: "pageToken" } as unknown as ConnectorCursor,
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: "success",
        totalDocsImported: 0,
      }),
    /cursor must have string/
  );
});

test("state store: listConnectorStates skips corrupt files but rethrows EACCES (PR #724 review)", async (t) => {
  // P2 review: only ConnectorStateCorruptionError should be swallowed.
  // Genuine I/O failures must propagate so the scheduler / CLI sees them.
  const memoryDir = makeMemoryDir(t);
  // Write one good file.
  await writeConnectorState(memoryDir, "good", {
    id: "good",
    cursor: null,
    lastSyncAt: null,
    lastSyncStatus: "never",
    totalDocsImported: 0,
  });
  // Drop a corrupt file.
  const dir = path.join(memoryDir, "state", "connectors");
  fs.writeFileSync(path.join(dir, "corrupt.json"), "{ not valid json");
  // Listing succeeds, returning only the good record.
  const states = await listConnectorStates(memoryDir);
  assert.deepEqual(
    states.map((s) => s.id),
    ["good"]
  );

  // Now make one of the files unreadable (EACCES). On platforms that respect
  // chmod for the current user (POSIX, when not running as root), this
  // produces EACCES which must propagate. Skip the assertion when running as
  // root or on Windows where chmod 0 is a no-op.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (process.platform !== "win32" && !isRoot) {
    const goodPath = path.join(dir, "good.json");
    fs.chmodSync(goodPath, 0o000);
    t.after(() => {
      try {
        fs.chmodSync(goodPath, 0o600);
      } catch {
        // ignore
      }
    });
    await assert.rejects(
      () => listConnectorStates(memoryDir),
      (err: NodeJS.ErrnoException) => err.code === "EACCES" || err.code === "EPERM"
    );
  }
});

test("state store: rejects negative totalDocsImported", async (t) => {
  const memoryDir = makeMemoryDir(t);
  await assert.rejects(
    () =>
      writeConnectorState(memoryDir, "drive", {
        id: "drive",
        cursor: null,
        lastSyncAt: null,
        lastSyncStatus: "never",
        totalDocsImported: -1,
      }),
    /non-negative integer/
  );
});

test("state store: rejects fractional totalDocsImported (PR #724 review)", async (t) => {
  // P2 review: cumulative doc count must be an integer; fractional values
  // would propagate through later increments and corrupt metrics.
  const memoryDir = makeMemoryDir(t);
  await assert.rejects(
    () =>
      writeConnectorState(memoryDir, "drive", {
        id: "drive",
        cursor: null,
        lastSyncAt: null,
        lastSyncStatus: "never",
        totalDocsImported: 3.7,
      }),
    /non-negative integer/
  );
  // And the read-shape check must reject a hand-crafted file with a float.
  const dir = path.join(memoryDir, "state", "connectors");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "drive.json"),
    JSON.stringify({
      id: "drive",
      cursor: null,
      lastSyncAt: null,
      lastSyncStatus: "never",
      totalDocsImported: 3.7,
      updatedAt: new Date().toISOString(),
    })
  );
  await assert.rejects(() => readConnectorState(memoryDir, "drive"), /does not match ConnectorState shape/);
});

test("state store: refuses symlinked state file (PR #724 review)", async (t) => {
  // P1 review: a symlink at <memoryDir>/state/connectors/<id>.json must be
  // refused, not silently followed. Otherwise readConnectorState consumes
  // arbitrary outside JSON and writeConnectorState overwrites an arbitrary
  // outside file.
  if (process.platform === "win32") return; // symlink semantics differ on Windows
  const memoryDir = makeMemoryDir(t);
  // Set up a parallel target file outside the memory root.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-live-outside-"));
  t.after(() => {
    try {
      fs.rmSync(outside, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  const outsideFile = path.join(outside, "evil.json");
  fs.writeFileSync(
    outsideFile,
    JSON.stringify({
      id: "drive",
      cursor: null,
      lastSyncAt: null,
      lastSyncStatus: "never",
      totalDocsImported: 999,
      updatedAt: new Date().toISOString(),
    })
  );
  // Plant the symlink where the connector state would live.
  const dir = path.join(memoryDir, "state", "connectors");
  fs.mkdirSync(dir, { recursive: true });
  const linkPath = path.join(dir, "drive.json");
  fs.symlinkSync(outsideFile, linkPath);

  await assert.rejects(() => readConnectorState(memoryDir, "drive"), /symlink/);
  await assert.rejects(
    () =>
      writeConnectorState(memoryDir, "drive", {
        id: "drive",
        cursor: null,
        lastSyncAt: null,
        lastSyncStatus: "never",
        totalDocsImported: 0,
      }),
    /symlink/
  );
});

test("state store: refuses symlinked state directory (PR #724 review)", async (t) => {
  if (process.platform === "win32") return;
  const memoryDir = makeMemoryDir(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-live-outside-dir-"));
  t.after(() => {
    try {
      fs.rmSync(outside, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  // Plant a symlink at <memoryDir>/state/connectors -> outside dir.
  fs.mkdirSync(path.join(memoryDir, "state"), { recursive: true });
  fs.symlinkSync(outside, path.join(memoryDir, "state", "connectors"));

  await assert.rejects(() => listConnectorStates(memoryDir), /symlink/);
  await assert.rejects(() => readConnectorState(memoryDir, "drive"), /symlink/);
});

test("state store: truncates oversized lastSyncError", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const huge = "x".repeat(5000);
  const written = await writeConnectorState(memoryDir, "drive", {
    id: "drive",
    cursor: null,
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: "error",
    lastSyncError: huge,
    totalDocsImported: 0,
  });
  assert.ok(written.lastSyncError);
  assert.ok(written.lastSyncError!.length <= 1024);
});

test("state store: serializes connector state locks for one connector", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withConnectorStateLock(memoryDir, "drive", async () => {
    events.push("first:start");
    await firstCanFinish;
    events.push("first:end");
    return "first";
  });

  await waitForTest(() => events.includes("first:start"));

  const second = withConnectorStateLock(memoryDir, "drive", async () => {
    events.push("second:start");
    return "second";
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();

  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  assert.equal(fs.existsSync(path.join(memoryDir, "state", "connector-locks", "drive.lock")), false);
});

test("state store: treats already-removed stale locks as benign", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const lockDir = path.join(memoryDir, "state", "connector-locks");
  const lockPath = path.join(lockDir, "drive.lock");
  fs.mkdirSync(lockDir, { recursive: true });

  await _unlinkStaleConnectorLockForTest(lockPath);
});

test("state store: does not evict a freshly refreshed lock held by a live process", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const lockDir = path.join(memoryDir, "state", "connector-locks");
  const lockPath = path.join(lockDir, "drive.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const freshDate = new Date();
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      pid: process.pid,
      token: "live-lock",
      createdAt: freshDate.toISOString(),
      refreshedAt: freshDate.toISOString(),
    })}\n`
  );
  fs.utimesSync(lockPath, freshDate, freshDate);

  assert.equal(await _tryAcquireConnectorLockForTest(memoryDir, "drive"), null);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "live-lock");
});

test("state store: evicts an unrefreshed stale lock even when the pid is live", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const lockDir = path.join(memoryDir, "state", "connector-locks");
  const lockPath = path.join(lockDir, "drive.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const staleDate = new Date(Date.now() - 11 * 60 * 1000);
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      pid: process.pid,
      token: "reused-pid-lock",
      createdAt: staleDate.toISOString(),
      refreshedAt: staleDate.toISOString(),
    })}\n`
  );
  fs.utimesSync(lockPath, staleDate, staleDate);

  assert.equal(await _tryAcquireConnectorLockForTest(memoryDir, "drive"), null);
  assert.equal(fs.existsSync(lockPath), false);
});

test("state store: stale cleanup does not race another reclaim holder", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const lockDir = path.join(memoryDir, "state", "connector-locks");
  const lockPath = path.join(lockDir, "drive.lock");
  const reclaimPath = `${lockPath}.reclaim`;
  fs.mkdirSync(lockDir, { recursive: true });
  const staleDate = new Date(Date.now() - 11 * 60 * 1000);
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      pid: process.pid,
      token: "stale-lock",
      createdAt: staleDate.toISOString(),
      refreshedAt: staleDate.toISOString(),
    })}\n`
  );
  fs.utimesSync(lockPath, staleDate, staleDate);
  fs.writeFileSync(reclaimPath, "other-reclaimer");

  await _unlinkStaleConnectorLockForTest(lockPath);

  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "stale-lock");
});

test("state store: stale cleanup preserves a lock refreshed by its owner", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const lockDir = path.join(memoryDir, "state", "connector-locks");
  const lockPath = path.join(lockDir, "drive.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const staleDate = new Date(Date.now() - 11 * 60 * 1000);
  const lease = { path: lockPath, token: "owner-lock" };
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      pid: process.pid,
      token: lease.token,
      createdAt: staleDate.toISOString(),
      refreshedAt: staleDate.toISOString(),
    })}\n`
  );
  fs.utimesSync(lockPath, staleDate, staleDate);

  assert.equal(await _refreshConnectorLockForTest(lease), true);
  await _unlinkStaleConnectorLockForTest(lockPath);

  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, lease.token);
});

test("state store: release only removes the matching connector lock token", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const lease = await _tryAcquireConnectorLockForTest(memoryDir, "drive");
  assert.ok(lease);
  const replacement = {
    pid: process.pid,
    token: "replacement-lock",
    createdAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lease.path, `${JSON.stringify(replacement)}\n`);

  await _releaseConnectorLockForTest(lease);

  assert.equal(JSON.parse(fs.readFileSync(lease.path, "utf8")).token, "replacement-lock");
});

test("state store: aborts scoped work when heartbeat loses the connector lock", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const lockPath = path.join(memoryDir, "state", "connector-locks", "drive.lock");
  let scopedSignal: AbortSignal | undefined;
  let scopedWorkSettled = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const lockedWork = _withConnectorStateLockForTest(
    memoryDir,
    "drive",
    async (abortSignal) => {
      scopedSignal = abortSignal;
      resolveStarted();
      await new Promise<never>((_resolve, reject) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              scopedWorkSettled = true;
              reject(abortSignal.reason);
            }, 20);
          },
          { once: true },
        );
      });
    },
    { heartbeatMs: 5, unrefHeartbeat: false },
  );

  await started;
  await waitForTest(() => fs.existsSync(lockPath));
  const replacement = {
    pid: process.pid,
    token: "replacement-lock",
    createdAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);

  await assert.rejects(lockedWork, /lost connector "drive" state lock/);
  assert.equal(scopedWorkSettled, true);
  assert.equal(scopedSignal?.aborted, true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "replacement-lock");
});

test("state store: refreshing an unlinked stale lease reports a newer lock owner", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const lease = await _tryAcquireConnectorLockForTest(memoryDir, "drive");
  assert.ok(lease);
  const probeHandle = await fs.promises.open(lease.path, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
    readFile: (...args: unknown[]) => Promise<unknown>;
  };
  const originalReadFile = fileHandlePrototype.readFile;
  await probeHandle.close();
  const replacement = {
    pid: process.pid,
    token: "replacement-lock",
    createdAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
  };
  let replaced = false;

  fileHandlePrototype.readFile = async function readFileAndReplace(...args: unknown[]) {
    const result = await originalReadFile.apply(this, args);
    if (!replaced) {
      replaced = true;
      fs.unlinkSync(lease.path);
      fs.writeFileSync(lease.path, `${JSON.stringify(replacement)}\n`);
    }
    return result;
  };

  try {
    assert.equal(await _refreshConnectorLockForTest(lease), false);
  } finally {
    fileHandlePrototype.readFile = originalReadFile;
  }

  assert.equal(JSON.parse(fs.readFileSync(lease.path, "utf8")).token, "replacement-lock");
});

test("state store: release does not unlink a lock path replaced after ownership read", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const lease = await _tryAcquireConnectorLockForTest(memoryDir, "drive");
  assert.ok(lease);
  const probeHandle = await fs.promises.open(lease.path, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
    readFile: (...args: unknown[]) => Promise<unknown>;
  };
  const originalReadFile = fileHandlePrototype.readFile;
  await probeHandle.close();
  const replacement = {
    pid: process.pid,
    token: "replacement-lock",
    createdAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
  };
  let replaced = false;

  fileHandlePrototype.readFile = async function readFileAndReplace(...args: unknown[]) {
    const result = await originalReadFile.apply(this, args);
    if (!replaced) {
      replaced = true;
      fs.unlinkSync(lease.path);
      fs.writeFileSync(lease.path, `${JSON.stringify(replacement)}\n`);
    }
    return result;
  };

  try {
    await _releaseConnectorLockForTest(lease);
  } finally {
    fileHandlePrototype.readFile = originalReadFile;
  }

  assert.equal(JSON.parse(fs.readFileSync(lease.path, "utf8")).token, "replacement-lock");
});

test("state store: removes connector lock when lock metadata write fails", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const probePath = path.join(memoryDir, "probe.lock");
  const probeHandle = await fs.promises.open(probePath, "w");
  const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
    writeFile: typeof probeHandle.writeFile;
  };
  const originalWriteFile = fileHandlePrototype.writeFile;
  await probeHandle.close();

  fileHandlePrototype.writeFile = async function writeFileFailure() {
    throw Object.assign(new Error("simulated lock write failure"), { code: "EIO" });
  };

  try {
    await assert.rejects(
      () => withConnectorStateLock(memoryDir, "drive", async () => "unreachable"),
      /simulated lock write failure/
    );
  } finally {
    fileHandlePrototype.writeFile = originalWriteFile;
  }

  assert.equal(fs.existsSync(path.join(memoryDir, "state", "connector-locks", "drive.lock")), false);
});

async function waitForTest(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for test condition");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test("state store: rejects corrupt JSON loudly via readConnectorState", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const dir = path.join(memoryDir, "state", "connectors");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "drive.json"), "{ not valid json");
  await assert.rejects(() => readConnectorState(memoryDir, "drive"), /not valid JSON/);
});

test("state store: rejects null parsed result", async (t) => {
  // CLAUDE.md gotcha #18 — JSON.parse('null') returns null.
  const memoryDir = makeMemoryDir(t);
  const dir = path.join(memoryDir, "state", "connectors");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "drive.json"), "null");
  await assert.rejects(() => readConnectorState(memoryDir, "drive"), /does not match ConnectorState shape/);
});

// ───────────────────────────────────────────────────────────────────────────
// End-to-end registry + state-store smoke test using MockConnector
// ───────────────────────────────────────────────────────────────────────────

test("end-to-end: registry + state store advance cursor across syncs", async (t) => {
  const memoryDir = makeMemoryDir(t);
  const reg = new LiveConnectorRegistry();
  const mock = new MockConnector("smoke");
  reg.register(mock);

  // First sync: no cursor yet.
  let prior = await readConnectorState(memoryDir, "smoke");
  assert.equal(prior, null);

  const r1 = await mock.syncIncremental({ cursor: null, config: {} });
  await writeConnectorState(memoryDir, "smoke", {
    id: "smoke",
    cursor: r1.nextCursor,
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: "success",
    totalDocsImported: r1.newDocs.length,
  });

  prior = await readConnectorState(memoryDir, "smoke");
  assert.equal(prior!.cursor!.value, "1");

  // Second sync: prior cursor passed in, advances.
  const r2 = await mock.syncIncremental({ cursor: prior!.cursor, config: {} });
  await writeConnectorState(memoryDir, "smoke", {
    id: "smoke",
    cursor: r2.nextCursor,
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: "success",
    totalDocsImported: prior!.totalDocsImported + r2.newDocs.length,
  });

  const final = await readConnectorState(memoryDir, "smoke");
  assert.equal(final!.cursor!.value, "2");
  assert.equal(final!.totalDocsImported, 2);
  assert.equal(mock.syncCalls, 2);
});
