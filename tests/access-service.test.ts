import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { EngramAccessInputError, EngramAccessService } from "../src/access-service.js";
import { runMemoryGovernance } from "../src/maintenance/memory-governance.ts";
import { rebuildMemoryProjection } from "../src/maintenance/rebuild-memory-projection.ts";
import { getMemoryProjectionPath } from "../src/memory-projection-store.js";
import { getObjectiveStateStoreStatus } from "../src/objective-state.js";
import {
  keyring,
  runSecureStoreInit,
  runSecureStoreUnlock,
  type ScryptParams,
} from "../src/secure-store/index.js";
import { StorageManager } from "../src/storage.js";
import { recordTrustZoneRecord } from "../src/trust-zones.ts";
import { exportCapsule } from "../src/transfer/capsule-export.js";

const FAST_SCRYPT: ScryptParams = {
  N: 1 << 10,
  r: 1,
  p: 1,
  keyLength: 32,
  maxmem: 32 * 1024 * 1024,
};

const TEST_PASSPHRASE = "correct horse battery staple";

function staticPassphraseReader(...sequence: string[]) {
  let index = 0;
  return async () => sequence[index++] ?? sequence[sequence.length - 1] ?? TEST_PASSPHRASE;
}

function dreamsPhasesConfig(deepSleepEnabled = true, deepSleepEnabledExplicitlySet = false) {
  return {
    lightSleep: {
      enabled: true,
      cadenceMs: 0,
      promoteHeatThreshold: 0.55,
      staleDecayThreshold: 0.65,
      archiveDecayThreshold: 0.85,
      filterStaleEnabled: false,
    },
    rem: {
      enabled: false,
      cadenceMs: 168 * 3_600_000,
      similarityThreshold: 0.8,
      minClusterSize: 3,
      maxPerRun: 100,
      minIntervalMs: 10 * 60_000,
    },
    deepSleep: {
      enabled: deepSleepEnabled,
      enabledExplicitlySet: deepSleepEnabledExplicitlySet,
      cadenceMs: 24 * 3_600_000,
      versioningEnabled: false,
      versioningMaxPerPage: 50,
    },
  };
}

function createService(dreamsPhases = dreamsPhasesConfig()) {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x", "read-only"],
          writePrincipals: ["project-x"],
        },
        {
          name: "secret-team",
          readPrincipals: ["secret-team"],
          writePrincipals: ["secret-team"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      dir: "/tmp/engram",
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  return new EngramAccessService(orchestrator as any);
}

test("observe writes raw session keys to namespaced objective-state stores", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-observe-obj-ns-"));
  const namespace = "project-x";
  const namespaceDir = path.join(memoryDir, "namespaces", namespace);
  const objectiveStateStoreDir = path.join(memoryDir, "objective-state-override");
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: namespace,
          readPrincipals: [namespace],
          writePrincipals: [namespace],
        },
      ],
      defaultRecallNamespaces: ["self"],
      objectiveStateMemoryEnabled: true,
      objectiveStateSnapshotWritesEnabled: true,
      objectiveStateStoreDir,
    },
    getStorage: async (requestedNamespace: string) => {
      assert.equal(requestedNamespace, namespace);
      return { dir: namespaceDir };
    },
  } as any);

  try {
    await service.observe({
      sessionKey: "agent-session",
      namespace,
      authenticatedPrincipal: namespace,
      skipExtraction: true,
      messages: [
        {
          role: "assistant",
          content: "Ran verification.",
          parts: [
            {
              ordinal: 0,
              kind: "tool_call",
              toolName: "exec_command",
              payload: {
                id: "call-access-observe",
                name: "exec_command",
                arguments: { cmd: "npm test" },
              },
            },
            {
              ordinal: 1,
              kind: "tool_result",
              payload: {
                id: "call-access-observe",
                output: { exitCode: 0, stdout: "ok" },
              },
            },
          ],
        },
      ],
    });

    const status = await getObjectiveStateStoreStatus({
      memoryDir: namespaceDir,
      objectiveStateStoreDir: path.join(objectiveStateStoreDir, "namespaces", namespace),
      enabled: true,
      writesEnabled: true,
    });
    assert.equal(status.snapshots.total, 1);
    assert.equal(status.latestSnapshot?.sessionKey, "agent-session");
    assert.equal(status.latestSnapshot?.kind, "process");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

function createMemoryActionService(contextCompressionActionsEnabled: boolean) {
  const capturedEvents: any[] = [];
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: false,
      defaultNamespace: "global",
      contextCompressionActionsEnabled,
    },
    previewMemoryActionEvent: (event: any) => ({
      timestamp: "2026-04-30T00:00:00.000Z",
      namespace: event.namespace ?? "global",
      ...event,
    }),
    appendMemoryActionEvent: async (event: any) => {
      capturedEvents.push(event);
      return true;
    },
  } as any);
  return { service, capturedEvents };
}

test("conversationIndexUpdate rejects blank sessionKey instead of updating every session", async () => {
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      conversationIndexEnabled: true,
    },
    transcript: {
      listSessionKeys: async () => {
        throw new Error("all-session update should not run");
      },
    },
    updateConversationIndex: async () => {
      throw new Error("single-session update should not run");
    },
  } as any);

  await assert.rejects(
    () => service.conversationIndexUpdate({ sessionKey: "   " }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /sessionKey must be a non-empty string/.test(err.message),
  );
});

test("memoryActionApply is gated by context compression actions", async () => {
  const { service, capturedEvents } = createMemoryActionService(false);

  await assert.rejects(
    () => service.memoryActionApply({ action: "store_note", content: "Remember this." }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /contextCompressionActionsEnabled/.test(err.message),
  );
  assert.equal(capturedEvents.length, 0);
});

test("memoryActionApply defaults missing outcome to skipped and preserves action fields", async () => {
  const { service, capturedEvents } = createMemoryActionService(true);

  const result = await service.memoryActionApply({
    action: "store_note",
    content: "Remember this.",
    category: "fact",
    execute: true,
    sourcePrompt: "Please remember this fact.",
  }) as { recorded: boolean; event: { outcome: string; inputSummary?: string } };

  assert.equal(result.recorded, true);
  assert.equal(result.event.outcome, "skipped");
  assert.equal(capturedEvents[0]?.outcome, "skipped");
  assert.match(capturedEvents[0]?.inputSummary ?? "", /category=fact/);
  assert.match(capturedEvents[0]?.inputSummary ?? "", /execute=true/);
  assert.equal(typeof capturedEvents[0]?.promptHash, "string");
  assert.equal(capturedEvents[0]?.promptHash.length, 64);
});

test("dreamsRun rejects deepSleep when the phase is explicitly disabled", async () => {
  const service = createService(dreamsPhasesConfig(false, true));

  await assert.rejects(
    () => service.dreamsRun({ phase: "deepSleep", dryRun: true }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /dreams\.phases\.deepSleep\.enabled=false/.test(err.message),
  );
});

test("dreamsStatus enforces readable namespace before loading telemetry", async () => {
  const service = createService();

  await assert.rejects(
    () => service.dreamsStatus({ windowHours: 1, namespace: "project-x" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /authentication required/.test(err.message),
  );
});

test("dreamsRun enforces writable namespace before running phases", async () => {
  const service = createService();

  await assert.rejects(
    () => service.dreamsRun({
      phase: "lightSleep",
      dryRun: true,
      namespace: "project-x",
      authenticatedPrincipal: "secret-team",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /namespace is not writable: project-x/.test(err.message),
  );
});

test("dreamsRun records REM telemetry from consolidation clusters", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-rem-"));
  let readAllMemoriesCalls = 0;
  const storage = {
    dir: memoryDir,
    readAllMemories: async () => {
      readAllMemoriesCalls += 1;
      return [{}, {}, {}, {}, {}];
    },
  };
  let capturedStorage: unknown;
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases: dreamsPhasesConfig(),
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => storage,
    runSemanticConsolidationNow: async (options: { storage?: unknown }) => {
      capturedStorage = options.storage;
      return {
        clustersFound: 1,
        memoriesConsolidated: 1,
        memoriesArchived: 2,
        errors: 0,
        clusters: [
          { memories: [{}, {}, {}] },
        ],
      };
    },
  } as any);

  try {
    const result = await service.dreamsRun({
      phase: "rem",
      dryRun: false,
      namespace: "project-x",
      authenticatedPrincipal: "project-x",
    });

    assert.equal(capturedStorage, storage);
    assert.equal(readAllMemoriesCalls, 0);
    assert.equal(result.itemsProcessed, 3);
    assert.equal(result.notes, "REM consolidation found 1 clusters");
    const ledger = await readFile(path.join(memoryDir, "state", "dreams-ledger.jsonl"), "utf-8");
    assert.match(ledger, /"phase":"rem"/);
    assert.match(ledger, /"itemsProcessed":3/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("dreamsRun delegates deepSleep governance through the resolved namespace storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-deep-"));
  const namespaceDir = path.join(memoryDir, "namespaces", "project-x");
  const storage = {
    dir: namespaceDir,
  };
  let capturedOptions: { storage?: unknown; dryRun?: boolean } | null = null;
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases: dreamsPhasesConfig(),
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => storage,
    runDeepSleepGovernanceNow: async (options: { storage?: unknown; dryRun?: boolean }) => {
      capturedOptions = options;
      return {
        scannedMemories: 7,
        appliedActionCount: 2,
        notes: "governance scanned namespace storage",
      };
    },
  } as any);

  try {
    const result = await service.dreamsRun({
      phase: "deepSleep",
      dryRun: true,
      namespace: "project-x",
      authenticatedPrincipal: "project-x",
    });

    assert.equal(capturedOptions?.storage, storage);
    assert.equal(capturedOptions?.dryRun, true);
    assert.equal(result.itemsProcessed, 7);
    assert.equal(result.notes, "governance scanned namespace storage");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

function memoryDoc(id: string, content: string, extra: string[] = []): string {
  return [
    "---",
    `id: ${id}`,
    "category: fact",
    "created: 2026-03-01T00:00:00.000Z",
    "updated: 2026-03-08T00:00:00.000Z",
    "source: test",
    "confidence: 0.9",
    "confidenceTier: explicit",
    "tags: [\"ops\", \"admin\"]",
    ...extra,
    "---",
    "",
    content,
    "",
  ].join("\n");
}

test("capsuleList returns namespace-scoped capsule metadata with read ACLs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-capsule-list-ns-"));
  const namespaceDir = path.join(memoryDir, "namespaces", "project-x");
  const capsulesDir = path.join(namespaceDir, ".capsules");
  await mkdir(capsulesDir, { recursive: true });
  await writeFile(path.join(capsulesDir, "daily-ops.capsule.json.gz"), "archive", "utf8");
  await writeFile(
    path.join(capsulesDir, "daily-ops.manifest.json"),
    JSON.stringify({
      createdAt: "2026-04-28T00:00:00.000Z",
      pluginVersion: "9.3.243",
      files: [{ path: "facts/2026-04-28/fact-a.md" }],
      capsule: { description: "Daily ops capsule" },
    }),
    "utf8",
  );
  await writeFile(path.join(capsulesDir, "weekly-rollup.capsule.json.gz.enc"), "archive", "utf8");
  await writeFile(path.join(capsulesDir, "broken-sidecar.capsule.json.gz"), "archive", "utf8");
  await writeFile(path.join(capsulesDir, "broken-sidecar.manifest.json"), "{not-json", "utf8");
  await writeFile(path.join(capsulesDir, "linked-sidecar.capsule.json.gz"), "archive", "utf8");
  const foreignManifestPath = path.join(memoryDir, "foreign-manifest.json");
  await writeFile(
    foreignManifestPath,
    JSON.stringify({
      createdAt: "2026-04-27T00:00:00.000Z",
      pluginVersion: "0.0.1-foreign",
      files: [{ path: "facts/foreign.md" }],
      capsule: { description: "Foreign metadata must not leak" },
    }),
    "utf8",
  );
  await symlink(foreignManifestPath, path.join(capsulesDir, "linked-sidecar.manifest.json"));
  let resolvedNamespace: string | undefined;
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x", "read-only"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases: dreamsPhasesConfig(),
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async (namespace: string | undefined) => {
      resolvedNamespace = namespace;
      return { dir: namespaceDir };
    },
  } as any);

  try {
    await assert.rejects(
      () => service.capsuleList({ namespace: "project-x" }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /authentication required/.test(err.message),
    );

    const result = await service.capsuleList({
      namespace: "project-x",
      principal: "read-only",
    });

    assert.equal(resolvedNamespace, "project-x");
    assert.equal(result.namespace, "project-x");
    assert.equal(result.capsulesDir, capsulesDir);
    assert.deepEqual(result.capsules.map((entry) => entry.id), [
      "broken-sidecar",
      "daily-ops",
      "linked-sidecar",
      "weekly-rollup",
    ]);
    assert.equal(result.capsules[0]?.manifestPath, path.join(capsulesDir, "broken-sidecar.manifest.json"));
    assert.equal(result.capsules[0]?.createdAt, null);
    assert.equal(result.capsules[0]?.pluginVersion, null);
    assert.equal(result.capsules[0]?.fileCount, null);
    assert.equal(result.capsules[0]?.description, null);
    assert.equal(result.capsules[1]?.manifestPath, path.join(capsulesDir, "daily-ops.manifest.json"));
    assert.equal(result.capsules[1]?.createdAt, "2026-04-28T00:00:00.000Z");
    assert.equal(result.capsules[1]?.pluginVersion, "9.3.243");
    assert.equal(result.capsules[1]?.fileCount, 1);
    assert.equal(result.capsules[1]?.description, "Daily ops capsule");
    assert.equal(result.capsules[2]?.manifestPath, path.join(capsulesDir, "linked-sidecar.manifest.json"));
    assert.equal(result.capsules[2]?.createdAt, null);
    assert.equal(result.capsules[2]?.pluginVersion, null);
    assert.equal(result.capsules[2]?.fileCount, null);
    assert.equal(result.capsules[2]?.description, null);
    assert.equal(result.capsules[3]?.manifestPath, null);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("capsuleList rejects symlinked capsule store directories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-capsule-list-symlink-"));
  const namespaceDir = path.join(memoryDir, "namespaces", "project-x");
  const outsideCapsulesDir = path.join(memoryDir, "outside-capsules");
  await mkdir(namespaceDir, { recursive: true });
  await mkdir(outsideCapsulesDir, { recursive: true });
  await symlink(outsideCapsulesDir, path.join(namespaceDir, ".capsules"), "dir");

  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x", "read-only"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases: dreamsPhasesConfig(),
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({ dir: namespaceDir }),
  } as any);

  try {
    await assert.rejects(
      () => service.capsuleList({ namespace: "project-x", principal: "read-only" }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /capsule store directory must not be a symlink/.test(err.message),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("capsuleExport encrypts namespace exports with the root secure-store keyring", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-capsule-export-ns-"));
  const namespaceDir = path.join(memoryDir, "namespaces", "project-x");
  await writeText(
    namespaceDir,
    path.join("facts", "2026-04-28", "fact-a.md"),
    "---\nid: fact-a\ncategory: fact\n---\nNamespace capsule export uses the root secure-store key.\n",
  );
  let resolvedNamespace: string | undefined;
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases: dreamsPhasesConfig(),
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async (namespace: string | undefined) => {
      resolvedNamespace = namespace;
      return { dir: namespaceDir };
    },
  } as any);

  try {
    await assert.rejects(
      () => service.capsuleExport({
        name: "read-only-export",
        namespace: "project-x",
        principal: "read-only",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /namespace is not writable: project-x/.test(err.message),
    );

    await runSecureStoreInit({
      memoryDir,
      readPassphrase: staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE),
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const unlock = await runSecureStoreUnlock({
      memoryDir,
      readPassphrase: staticPassphraseReader(TEST_PASSPHRASE),
    });
    assert.equal(unlock.ok, true);

    const result = await service.capsuleExport({
      name: "project-x-export",
      namespace: "project-x",
      principal: "project-x",
      encrypt: true,
    });

    assert.equal(resolvedNamespace, "project-x");
    assert.equal(result.encryptedArchivePath, result.archivePath);
    assert.match(result.archivePath, /project-x-export\.capsule\.json\.gz\.enc$/);
    const encrypted = await readFile(result.archivePath);
    assert.equal(encrypted.subarray(0, 11).toString("ascii"), "REMNIC-ENC\0");
    assert.notEqual(result.manifest.pluginVersion, "0.0.0");
    assert.match(result.manifest.pluginVersion, /^\d+\.\d+\.\d+/);
  } finally {
    keyring.lockAll();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("capsuleImport decrypts namespace imports with the root secure-store keyring", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-capsule-import-ns-"));
  const sourceDir = path.join(memoryDir, "source");
  const namespaceDir = path.join(memoryDir, "namespaces", "project-x");
  await mkdir(namespaceDir, { recursive: true });
  await writeText(
    sourceDir,
    path.join("facts", "2026-04-28", "fact-a.md"),
    "---\nid: fact-a\ncategory: fact\n---\nEncrypted namespace imports use the root secure-store key.\n",
  );
  let resolvedNamespace: string | undefined;
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x", "read-only"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases: dreamsPhasesConfig(),
      versioningEnabled: false,
      versioningMaxPerPage: 50,
      versioningSidecarDir: undefined,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async (namespace: string | undefined) => {
      resolvedNamespace = namespace;
      return { dir: namespaceDir };
    },
  } as any);

  try {
    await runSecureStoreInit({
      memoryDir,
      readPassphrase: staticPassphraseReader(TEST_PASSPHRASE, TEST_PASSPHRASE),
      algorithm: "scrypt",
      params: FAST_SCRYPT,
    });
    const unlock = await runSecureStoreUnlock({
      memoryDir,
      readPassphrase: staticPassphraseReader(TEST_PASSPHRASE),
    });
    assert.equal(unlock.ok, true);

    const capsule = await exportCapsule({
      name: "project-x-import",
      root: sourceDir,
      outDir: path.join(memoryDir, "out"),
      encrypt: true,
      memoryDir,
    });

    await assert.rejects(
      () => service.capsuleImport({
        archivePath: capsule.archivePath,
        namespace: "project-x",
        principal: "read-only",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /namespace is not writable: project-x/.test(err.message),
    );

    const result = await service.capsuleImport({
      archivePath: capsule.archivePath,
      namespace: "project-x",
      principal: "project-x",
    });

    assert.equal(resolvedNamespace, "project-x");
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0]?.targetPath, "facts/2026-04-28/fact-a.md");
    const imported = await readFile(path.join(namespaceDir, "facts", "2026-04-28", "fact-a.md"), "utf-8");
    assert.match(imported, /Encrypted namespace imports use the root secure-store key/);
  } finally {
    keyring.lockAll();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("capsuleImport reports bad archive input as an access input error", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-capsule-import-bad-"));
  const namespaceDir = path.join(memoryDir, "namespaces", "project-x");
  await mkdir(namespaceDir, { recursive: true });
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases: dreamsPhasesConfig(),
      versioningEnabled: false,
      versioningMaxPerPage: 50,
      versioningSidecarDir: undefined,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({ dir: namespaceDir }),
  } as any);

  try {
    await assert.rejects(
      () => service.capsuleImport({
        archivePath: path.join(memoryDir, "missing.capsule.json.gz"),
        namespace: "project-x",
        principal: "project-x",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /capsule import failed:/.test(err.message),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("capsuleImport reports unreadable archive paths as access input errors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-capsule-import-unreadable-"));
  const namespaceDir = path.join(memoryDir, "namespaces", "project-x");
  await mkdir(namespaceDir, { recursive: true });
  const archivePath = path.join(memoryDir, "unreadable.capsule.json.gz");
  await writeFile(archivePath, "not gzip", "utf8");
  await chmod(archivePath, 0o000);
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases: dreamsPhasesConfig(),
      versioningEnabled: false,
      versioningMaxPerPage: 50,
      versioningSidecarDir: undefined,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({ dir: namespaceDir }),
  } as any);

  try {
    await assert.rejects(
      () => service.capsuleImport({
        archivePath,
        namespace: "project-x",
        principal: "project-x",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /archive is not readable/.test(err.message),
    );
  } finally {
    await chmod(archivePath, 0o600).catch(() => {});
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("capsuleImport reports malformed capsule bundles as access input errors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-capsule-import-malformed-"));
  const namespaceDir = path.join(memoryDir, "namespaces", "project-x");
  await mkdir(namespaceDir, { recursive: true });
  const archivePath = path.join(memoryDir, "bad.capsule.json.gz");
  const corruptGzipPath = path.join(memoryDir, "corrupt.capsule.json.gz");
  await writeFile(archivePath, gzipSync(Buffer.from(JSON.stringify({ format: "not-remnic-capsule" }), "utf8")));
  await writeFile(corruptGzipPath, "not gzip", "utf8");
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      dreamsPhases: dreamsPhasesConfig(),
      versioningEnabled: false,
      versioningMaxPerPage: 50,
      versioningSidecarDir: undefined,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({ dir: namespaceDir }),
  } as any);

  try {
    await assert.rejects(
      () => service.capsuleImport({
        archivePath,
        namespace: "project-x",
        principal: "project-x",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /capsule import failed:/.test(err.message),
    );
    await assert.rejects(
      () => service.capsuleImport({
        archivePath: corruptGzipPath,
        namespace: "project-x",
        principal: "project-x",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /capsule import failed:/.test(err.message),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service rejects empty recall queries as input errors", async () => {
  const service = createService();
  await assert.rejects(
    () => service.recall({ query: "   " }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "query is required",
  );
});

test("access service allows namespace-scoped recall when namespaces are enabled", async () => {
  const service = createService();
  const response = await service.recall({
    query: "hello",
    sessionKey: "agent:project-x:chat",
    namespace: "project-x",
  });
  assert.equal(response.namespace, "project-x");
});

test("access service allows readable namespace overrides outside default recall namespaces", async () => {
  let capturedOptions: unknown;
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
        {
          name: "project-y",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-y"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
    },
    recall: async (_query: string, _sessionKey?: string, options?: unknown) => {
      capturedOptions = options;
      return "ctx";
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  } as any);

  const response = await service.recall({
    query: "hello",
    sessionKey: "agent:project-x:chat",
    namespace: "project-y",
  });

  assert.equal(response.namespace, "project-y");
  assert.deepEqual(capturedOptions, {
    namespace: "project-y",
    topK: undefined,
    mode: undefined,
  });
});

test("access service recall uses authenticated principal for namespace authorization", async () => {
  let capturedOptions: unknown;
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-y",
          readPrincipals: ["chatgpt-user"],
          writePrincipals: ["project-y"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
    },
    recall: async (_query: string, _sessionKey?: string, options?: unknown) => {
      capturedOptions = options;
      return "ctx";
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  } as any);

  const response = await service.recall({
    query: "hello",
    namespace: "project-y",
    authenticatedPrincipal: "chatgpt-user",
    mode: "full",
  });

  assert.equal(response.namespace, "project-y");
  assert.deepEqual(capturedOptions, {
    namespace: "project-y",
    topK: undefined,
    mode: "full",
    principalOverride: "chatgpt-user",
  });
});

test("access service rejects unreadable namespace-scoped recall overrides", async () => {
  const service = createService();
  await assert.rejects(
    () => service.recall({
      query: "hello",
      sessionKey: "agent:project-x:chat",
      namespace: "secret-team",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace override is not readable: secret-team",
  );
});

test("access service allows readable explicit namespace overrides outside default recall routing", async () => {
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
        {
          name: "audit-log",
          readPrincipals: ["project-x"],
          writePrincipals: ["audit-bot"],
          includeInRecallByDefault: false,
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  } as any);

  const response = await service.recall({
    query: "hello",
    sessionKey: "agent:project-x:chat",
    namespace: "audit-log",
  });

  assert.equal(response.namespace, "audit-log");
});

test("access service recall forwards overrides and returns explainable metadata", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-08/fact-1.md");
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      memoryDoc("fact-1", "Operator-facing recall envelope coverage."),
    );
    const storage = new StorageManager(memoryDir);
    let capturedOptions: unknown;
    const snapshot = {
      sessionKey: "sess-1",
      recordedAt: "2026-03-08T00:00:00.000Z",
      queryHash: "hash",
      queryLen: 12,
      memoryIds: ["fact-1"],
      namespace: "global",
      traceId: "trace-1",
      plannerMode: "minimal",
      requestedMode: "minimal",
      fallbackUsed: true,
      sourcesUsed: ["cold_fallback", "memories"],
      budgetsApplied: {
        requestedTopK: 3,
        appliedTopK: 1,
        recallBudgetChars: 8000,
        maxMemoryTokens: 2000,
        qmdFetchLimit: 4,
        qmdHybridFetchLimit: 4,
      },
      latencyMs: 42,
      resultPaths: [memoryPath],
    };

    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: true,
        defaultNamespace: "global",
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [{
          name: "project-x",
          readPrincipals: ["*"],
          writePrincipals: ["*"],
        }],
        defaultRecallNamespaces: ["self"],
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async (_query: string, _sessionKey?: string, options?: unknown) => {
        capturedOptions = options;
        return "ctx";
      },
      lastRecall: { get: () => snapshot, getMostRecent: () => snapshot },
      getStorage: async () => storage,
      getLastIntentSnapshot: async () => ({
        recordedAt: "2026-03-08T00:00:00.000Z",
        promptHash: "prompt",
        promptLength: 5,
        retrievalQueryHash: "retrieval",
        retrievalQueryLength: 5,
        plannerEnabled: true,
        plannedMode: "minimal",
        effectiveMode: "minimal",
        recallResultLimit: 1,
        queryIntent: { tense: "present", goal: "recall", action: "recall", scope: "specific" },
        graphExpandedIntentDetected: false,
        graphDecision: {
          status: "not_requested",
          shadowMode: false,
          qmdAvailable: true,
          graphRecallEnabled: false,
          multiGraphMemoryEnabled: false,
        },
      }),
      getLastGraphRecallSnapshot: async () => null,
    } as any);

    const response = await service.recall({
      query: "hello",
      sessionKey: "sess-1",
      namespace: "global",
      topK: 3,
      mode: "minimal",
      includeDebug: true,
    });

    assert.deepEqual(capturedOptions, {
      namespace: "global",
      topK: 3,
      mode: "minimal",
    });
    assert.equal(response.namespace, "global");
    assert.equal(response.traceId, "trace-1");
    assert.equal(response.plannerMode, "minimal");
    assert.equal(response.fallbackUsed, true);
    assert.deepEqual(response.sourcesUsed, ["cold_fallback", "memories"]);
    assert.equal(response.results[0]?.id, "fact-1");
    assert.equal(response.budgetsApplied?.requestedTopK, 3);
    assert.equal(response.debug?.intent?.effectiveMode, "minimal");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service recall reports the effective snapshot namespace in response and debug lookups", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-effective-ns-"));
  try {
    const storage = new StorageManager(memoryDir);
    let intentNamespace = "";
    let graphNamespace = "";
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: true,
        defaultNamespace: "global",
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [{
          name: "project-x",
          readPrincipals: ["*"],
          writePrincipals: ["*"],
        }],
        defaultRecallNamespaces: ["self"],
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: {
        get: () => ({
          sessionKey: "user:alpha:job",
          namespace: "team-alpha",
          memoryIds: [],
          resultPaths: [],
          plannerMode: "minimal",
          fallbackUsed: false,
          sourcesUsed: ["memories"],
          recordedAt: "2026-03-10T00:00:00.000Z",
          traceId: "trace-effective-ns",
          budgetsApplied: undefined,
          latencyMs: 12,
        }),
        getMostRecent: () => null,
      },
      getStorage: async () => storage,
      getLastIntentSnapshot: async (namespace: string) => {
        intentNamespace = namespace;
        return null;
      },
      getLastGraphRecallSnapshot: async (namespace: string) => {
        graphNamespace = namespace;
        return null;
      },
    } as any);

    const response = await service.recall({
      query: "What is in my namespace?",
      sessionKey: "user:alpha:job",
      includeDebug: true,
    });

    assert.equal(response.namespace, "team-alpha");
    assert.equal(intentNamespace, "team-alpha");
    assert.equal(graphNamespace, "team-alpha");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service serializes result paths from the snapshot namespace", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-path-namespace-"));
  try {
    const globalStorage = new StorageManager(memoryDir);
    const namespaceStorage = new StorageManager(path.join(memoryDir, "namespaces", "project-x"));
    const namespacedPath = path.join(namespaceStorage.dir, "archive/2026-03-08/fact-project.md");
    await writeText(
      namespaceStorage.dir,
      "archive/2026-03-08/fact-project.md",
      memoryDoc(
        "fact-project",
        "Namespace-scoped path recall serialization.",
        ['archivedAt: 2026-03-08T01:00:00.000Z'],
      ),
    );
    const snapshot = {
      sessionKey: "sess-1",
      recordedAt: "2026-03-08T00:00:00.000Z",
      queryHash: "hash",
      queryLen: 12,
      memoryIds: [],
      namespace: "project-x",
      traceId: "trace-1",
      plannerMode: "full",
      requestedMode: "full",
      fallbackUsed: false,
      sourcesUsed: ["hot_qmd"],
      budgetsApplied: {
        appliedTopK: 1,
        recallBudgetChars: 8000,
        maxMemoryTokens: 2000,
      },
      latencyMs: 12,
      resultPaths: [namespacedPath],
    };

    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: true,
        defaultNamespace: "global",
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [{
          name: "project-x",
          readPrincipals: ["*"],
          writePrincipals: ["*"],
        }],
        defaultRecallNamespaces: ["self"],
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => snapshot, getMostRecent: () => snapshot },
      getStorage: async (namespace?: string) => (namespace === "project-x" ? namespaceStorage : globalStorage),
      getLastIntentSnapshot: async () => null,
      getLastGraphRecallSnapshot: async () => null,
    } as any);

    const response = await service.recall({
      query: "namespace path recall",
      sessionKey: "sess-1",
      namespace: "project-x",
    });

    assert.equal(response.namespace, "project-x");
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.id, "fact-project");
    assert.equal(response.results[0]?.status, "archived");
    assert.match(response.results[0]?.path ?? "", /archive\/2026-03-08\/fact-project\.md$/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service recall count stays aligned with snapshot memory ids when some memories cannot be serialized", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-count-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-08/fact-present.md");
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-present.md",
      memoryDoc("fact-present", "Only one memory is still readable."),
    );
    const storage = new StorageManager(memoryDir);
    const snapshot = {
      sessionKey: "sess-count",
      recordedAt: "2026-03-10T00:00:00.000Z",
      queryHash: "hash",
      queryLen: 8,
      memoryIds: ["fact-present", "fact-missing"],
      namespace: "global",
      traceId: "trace-count",
      plannerMode: "minimal",
      requestedMode: "minimal",
      fallbackUsed: false,
      sourcesUsed: ["memories"],
      budgetsApplied: undefined,
      latencyMs: 9,
      resultPaths: [memoryPath, path.join(memoryDir, "facts/2026-03-08/fact-missing.md")],
    };

    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => snapshot, getMostRecent: () => snapshot },
      getStorage: async () => storage,
      getLastIntentSnapshot: async () => null,
      getLastGraphRecallSnapshot: async () => null,
    } as any);

    const response = await service.recall({
      query: "missing?",
      sessionKey: "sess-count",
    });

    assert.equal(response.count, 2);
    assert.deepEqual(response.memoryIds, ["fact-present", "fact-missing"]);
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.id, "fact-present");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service recall without a session key does not reuse another session snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-no-session-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-08/fact-stale.md");
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-stale.md",
      memoryDoc("fact-stale", "This memory belongs to a different session."),
    );
    const storage = new StorageManager(memoryDir);
    let getMostRecentCalls = 0;
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx-without-session",
      lastRecall: {
        get: () => null,
        getMostRecent: () => {
          getMostRecentCalls += 1;
          return {
            sessionKey: "other-session",
            recordedAt: "2026-03-10T00:00:00.000Z",
            queryHash: "hash",
            queryLen: 8,
            memoryIds: ["fact-stale"],
            namespace: "other-namespace",
            traceId: "trace-stale",
            plannerMode: "minimal",
            requestedMode: "minimal",
            fallbackUsed: false,
            sourcesUsed: ["memories"],
            budgetsApplied: undefined,
            latencyMs: 4,
            resultPaths: [memoryPath],
          };
        },
      },
      getStorage: async () => storage,
      getLastIntentSnapshot: async () => ({
        recordedAt: "2026-03-10T00:00:00.000Z",
        promptHash: "prompt",
        promptLength: 12,
        retrievalQueryHash: "query",
        retrievalQueryLength: 12,
        plannerEnabled: true,
        plannedMode: "minimal",
        reasoning: "debug state from another session",
      }),
      getLastGraphRecallSnapshot: async () => ({
        recordedAt: "2026-03-10T00:00:00.000Z",
        queryHash: "graph",
        graphMode: "off",
        nodes: [],
        edges: [],
      }),
    } as any);

    const response = await service.recall({
      query: "fresh request",
      includeDebug: true,
    });

    assert.equal(getMostRecentCalls, 0);
    assert.equal(response.sessionKey, undefined);
    assert.equal(response.namespace, "global");
    assert.equal(response.context, "ctx-without-session");
    assert.equal(response.count, 0);
    assert.deepEqual(response.memoryIds, []);
    assert.deepEqual(response.results, []);
    assert.equal(response.recordedAt, undefined);
    assert.equal(response.traceId, undefined);
    assert.equal(response.debug, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service recallExplain omits mismatched most-recent snapshot when namespace is requested", async () => {
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => ({
        sessionKey: "other-session",
        namespace: "global",
        memoryIds: ["fact-1"],
        resultPaths: [],
      }),
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const response = await service.recallExplain({
    namespace: "shared",
  });

  assert.equal(response.snapshot, undefined);
  assert.equal(response.found, false);
});

test("access service recallExplain omits most-recent snapshots without a namespace when a namespace is requested", async () => {
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => ({
        sessionKey: "other-session",
        memoryIds: ["fact-1"],
        resultPaths: [],
      }),
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const response = await service.recallExplain({
    namespace: "project-x",
  });

  assert.equal(response.snapshot, undefined);
  assert.equal(response.found, false);
});

test("access service recallExplain without a namespace preserves the most recent non-default snapshot", async () => {
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => ({
        sessionKey: "other-session",
        namespace: "shared",
        memoryIds: ["fact-1"],
        resultPaths: [],
      }),
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const response = await service.recallExplain();

  assert.equal(response.found, true);
  assert.equal(response.snapshot?.namespace, "shared");
});

test("access service recallExplain filters session snapshots by the requested namespace", async () => {
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [
        {
          match: "project-x:",
          principal: "project-x",
        },
      ],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => ({
        sessionKey: "project-x:session",
        namespace: "global",
        memoryIds: ["fact-1"],
        resultPaths: [],
      }),
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const response = await service.recallExplain({
    sessionKey: "project-x:session",
    namespace: "project-x",
  });

  assert.equal(response.found, false);
  assert.equal(response.snapshot, undefined);
});

test("access service memoryStore persists and enforces idempotency conflicts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-store-"));
  try {
    const storage = new StorageManager(memoryDir);
    const originalWriteMemory = storage.writeMemory.bind(storage);
    let writeCalls = 0;
    storage.writeMemory = (async (...args: Parameters<typeof originalWriteMemory>) => {
      writeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalWriteMemory(...args);
    }) as typeof storage.writeMemory;
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [],
        defaultRecallNamespaces: ["self"],
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
      getLastIntentSnapshot: async () => null,
      getLastGraphRecallSnapshot: async () => null,
    } as any);

    const first = await service.memoryStore({
      schemaVersion: 1,
      idempotencyKey: "store-1",
      dryRun: false,
      content: "A durable explicit memory for access-layer coverage.",
      category: "fact",
      namespace: "global",
      sourceReason: "access regression coverage",
    });
    const second = await service.memoryStore({
      schemaVersion: 1,
      idempotencyKey: "store-1",
      dryRun: false,
      content: "A durable explicit memory for access-layer coverage.",
      category: "fact",
      namespace: "global",
      sourceReason: "access regression coverage",
    });

    assert.equal(first.status, "stored");
    assert.equal(first.idempotencyReplay, undefined);
    assert.equal(second.memoryId, first.memoryId);
    assert.equal(second.idempotencyReplay, true);
    assert.equal((await storage.readAllMemories()).length, 1);

    await assert.rejects(
      () => service.memoryStore({
        schemaVersion: 1,
        idempotencyKey: "store-1",
        dryRun: false,
        content: "A different explicit memory with the same idempotency key.",
        category: "fact",
        namespace: "global",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /idempotencyKey reuse conflict/.test(err.message),
    );

    const dryRun = await service.memoryStore({
      schemaVersion: 1,
      idempotencyKey: "store-dry-run",
      dryRun: true,
      content: "Validate this explicit capture before the real write happens.",
      category: "fact",
      namespace: "global",
    });
    const storedAfterDryRun = await service.memoryStore({
      schemaVersion: 1,
      idempotencyKey: "store-dry-run",
      dryRun: false,
      content: "Validate this explicit capture before the real write happens.",
      category: "fact",
      namespace: "global",
    });

    assert.equal(dryRun.status, "validated");
    assert.equal(storedAfterDryRun.status, "stored");

    const [concurrentA, concurrentB] = await Promise.all([
      service.memoryStore({
        schemaVersion: 1,
        idempotencyKey: "store-concurrent",
        dryRun: false,
        content: "A concurrent explicit memory that should only persist once.",
        category: "fact",
        namespace: "global",
      }),
      service.memoryStore({
        schemaVersion: 1,
        idempotencyKey: "store-concurrent",
        dryRun: false,
        content: "A concurrent explicit memory that should only persist once.",
        category: "fact",
        namespace: "global",
      }),
    ]);

    assert.equal(concurrentA.memoryId, concurrentB.memoryId);
    assert.equal(writeCalls, 3);
    assert.equal((await storage.readAllMemories()).length, 3);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service acquires a shared idempotency key lock before executing writes across service instances", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-shared-idempotency-"));
  try {
    const config = {
      memoryDir,
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
    };
    const orchestrator = {
      config,
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => ({
        getMemoryById: async () => null,
        getMemoryTimeline: async () => [],
      }),
      getLastIntentSnapshot: async () => null,
      getLastGraphRecallSnapshot: async () => null,
    };
    const serviceA = new EngramAccessService(orchestrator as any);
    const serviceB = new EngramAccessService(orchestrator as any);
    let releaseFirstExecute: (() => void) | null = null;
    const firstExecutePaused = new Promise<void>((resolve) => {
      releaseFirstExecute = resolve;
    });
    let firstExecuteEnteredResolve: (() => void) | null = null;
    const firstExecuteEntered = new Promise<void>((resolve) => {
      firstExecuteEnteredResolve = resolve;
    });
    let executeCalls = 0;

    const first = (serviceA as any).handleIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: "shared-write",
      requestFingerprint: { content: "same write" },
      execute: async () => {
        executeCalls += 1;
        firstExecuteEnteredResolve?.();
        await firstExecutePaused;
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "global",
          dryRun: false,
          accepted: true,
          queued: false,
          status: "stored",
          memoryId: "fact-shared",
          idempotencyKey: "shared-write",
        };
      },
    });
    await firstExecuteEntered;

    let secondExecuteStarted = false;
    const second = (serviceB as any).handleIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: "shared-write",
      requestFingerprint: { content: "same write" },
      execute: async () => {
        secondExecuteStarted = true;
        executeCalls += 1;
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "global",
          dryRun: false,
          accepted: true,
          queued: false,
          status: "stored",
          memoryId: "fact-shared",
          idempotencyKey: "shared-write",
        };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondExecuteStarted, false);

    releaseFirstExecute?.();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    assert.equal(executeCalls, 1);
    assert.deepEqual(firstResponse, {
      schemaVersion: 1,
      operation: "memory_store",
      namespace: "global",
      dryRun: false,
      accepted: true,
      queued: false,
      status: "stored",
      memoryId: "fact-shared",
      idempotencyKey: "shared-write",
    });
    assert.deepEqual(secondResponse, {
      ...firstResponse,
      idempotencyReplay: true,
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service write operations reject namespaces the caller cannot write", async () => {
  const service = createService();

  await assert.rejects(
    () => service.memoryStore({
      schemaVersion: 1,
      dryRun: false,
      sessionKey: "agent:project-x:chat",
      content: "Attempt to write into another team's namespace.",
      category: "fact",
      namespace: "secret-team",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace is not writable: secret-team",
  );

  await assert.rejects(
    () => service.suggestionSubmit({
      schemaVersion: 1,
      dryRun: false,
      sessionKey: "agent:project-x:chat",
      content: "Attempt to queue another team's namespace for review.",
      category: "fact",
      namespace: "secret-team",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace is not writable: secret-team",
  );
});

test("access service write authorization uses the trusted transport principal instead of client sessionKey", async () => {
  const service = createService();

  await assert.rejects(
    () => service.memoryStore({
      schemaVersion: 1,
      dryRun: true,
      sessionKey: "agent:secret-team:chat",
      authenticatedPrincipal: "project-x",
      content: "Spoofed sessionKey should not unlock another namespace.",
      category: "fact",
      namespace: "secret-team",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace is not writable: secret-team",
  );

  const validated = await service.suggestionSubmit({
    schemaVersion: 1,
    dryRun: true,
    sessionKey: "agent:project-x:chat",
    authenticatedPrincipal: "secret-team",
    content: "Trusted transport principal should authorize the namespace.",
    category: "fact",
    namespace: "secret-team",
  });

  assert.equal(validated.status, "validated");
  assert.equal(validated.namespace, "secret-team");
});

test("access service review dispositions reject namespaces outside the trusted transport principal", async () => {
  const service = createService();

  await assert.rejects(
    () => service.reviewDisposition({
      memoryId: "fact-1",
      status: "active",
      reasonCode: "operator_confirmed",
      namespace: "secret-team",
      authenticatedPrincipal: "project-x",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace is not writable: secret-team",
  );
});

test("access service suggestionSubmit queues pending review memories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-suggestion-"));
  try {
    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [],
        defaultRecallNamespaces: ["self"],
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
      getLastIntentSnapshot: async () => null,
      getLastGraphRecallSnapshot: async () => null,
    } as any);

    const response = await service.suggestionSubmit({
      schemaVersion: 1,
      dryRun: false,
      content: "Suggestion content that should be queued for operator review.",
      category: "fact",
      namespace: "global",
    });
    const queued = response.memoryId ? await storage.getMemoryById(response.memoryId) : null;

    assert.equal(response.queued, true);
    assert.equal(response.status, "queued_for_review");
    assert.equal(queued?.frontmatter.status, "pending_review");

    await assert.rejects(
      () => service.suggestionSubmit({
        schemaVersion: 1,
        dryRun: false,
        content: "Rejected because the confidence is invalid.",
        category: "fact",
        confidence: 2,
        namespace: "global",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        err.message === "confidence must be between 0 and 1",
    );

    const sanitized = await service.suggestionSubmit({
      schemaVersion: 1,
      dryRun: false,
      content: "  Suggestion content that should be normalized before review.  ",
      category: "fact",
      namespace: "global",
      tags: [" review ", "queue", "review"],
      sourceReason: "  submitted via suggestion submit  ",
    });
    const sanitizedQueued = sanitized.memoryId ? await storage.getMemoryById(sanitized.memoryId) : null;

    assert.equal(sanitizedQueued?.frontmatter.status, "pending_review");
    assert.match(sanitizedQueued?.content ?? "", /Submitted content:\nSuggestion content that should be normalized before review\./);
    assert.match(sanitizedQueued?.content ?? "", /Requested sourceReason: submitted via suggestion submit/);
    assert.match(sanitizedQueued?.content ?? "", /Requested tags: review, queue/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service browses memories, lists entities, and applies review dispositions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      memoryDoc("fact-1", "Admin console memory browser target.", ['entityRef: person-alex', 'status: pending_review']),
    );
    await writeText(
      memoryDir,
      "entities/person-alex.md",
      [
        "# Alex",
        "",
        "type: person",
        "updated: 2026-03-08T00:00:00.000Z",
        "",
        "## Summary",
        "",
        "Owns operations tooling.",
        "",
        "## Aliases",
        "",
        "- Alex Ops",
        "",
        "## Facts",
        "",
        "- Maintains Engram.",
        "",
        "## Beliefs",
        "",
        "- Small teams should own whole systems.",
        "",
      ].join("\n"),
    );

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({ query: "browser" });
    assert.equal(browse.total, 1);
    assert.equal(browse.memories[0]?.id, "fact-1");

    const entities = await service.entityList({ query: "alex" });
    assert.equal(entities.total, 1);
    assert.equal(entities.entities[0]?.name, "Alex");

    const structuredEntities = await service.entityList({ query: "whole systems" });
    assert.equal(structuredEntities.total, 1);
    assert.equal(structuredEntities.entities[0]?.name, "Alex");

    const entity = await service.entityGet("person-alex");
    assert.equal(entity.found, true);
    assert.equal(entity.entity?.aliases.includes("Alex Ops"), true);

    const disposition = await service.reviewDisposition({
      memoryId: "fact-1",
      status: "active",
      reasonCode: "operator_confirmed",
    });
    assert.equal(disposition.ok, true);
    assert.equal(disposition.previousStatus, "pending_review");

    const updated = await storage.getMemoryById("fact-1");
    assert.equal(updated?.frontmatter.status, "active");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service uses projection-backed browse filters, including archived memories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-projection-browse-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-active.md",
      memoryDoc("fact-active", "Active memory that should be filtered out.", ['entityRef: person-active']),
    );
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      memoryDoc(
        "fact-archived",
        "Retired browser coverage memory for the archived projection path.",
        ['entityRef: person-retired', 'archivedAt: 2026-03-08T02:00:00.000Z', 'tags: ["legacy", "browser"]'],
      ),
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({
      query: "retired",
      status: "archived",
      category: "fact",
    });
    assert.equal(browse.total, 1);
    assert.equal(browse.count, 1);
    assert.equal(browse.memories[0]?.id, "fact-archived");
    assert.equal(browse.memories[0]?.status, "archived");
    assert.equal(browse.memories[0]?.entityRef, "person-retired");
    assert.deepEqual([...((browse.memories[0]?.tags ?? []).slice())].sort(), ["browser", "legacy"]);
    assert.match(browse.memories[0]?.path ?? "", /archive\/2026-03-08\/fact-archived\.md$/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service supports explicit browse sorting for projection-backed and fallback memory pages", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-browse-sort-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-02-01/fact-older.md",
      memoryDoc("fact-older", "Older memory for browse sorting.", ['created: 2026-02-01T00:00:00.000Z', 'updated: 2026-02-02T00:00:00.000Z']),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-newer.md",
      memoryDoc("fact-newer", "Newer memory for browse sorting.", ['created: 2026-03-01T00:00:00.000Z', 'updated: 2026-03-05T00:00:00.000Z']),
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const projectedPage = await service.memoryBrowse({
      sort: "created_asc",
      limit: 10,
      offset: 0,
    });
    assert.equal(projectedPage.sort, "created_asc");
    assert.deepEqual(projectedPage.memories.map((memory) => memory.id), ["fact-older", "fact-newer"]);

    const fallbackPage = await service.memoryBrowse({
      query: "browse sorting",
      sort: "created_desc",
      limit: 10,
      offset: 0,
    });
    assert.equal(fallbackPage.sort, "created_desc");
    assert.deepEqual(fallbackPage.memories.map((memory) => memory.id), ["fact-newer", "fact-older"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service fallback browse matches projection secondary timestamp tie breakers", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-browse-tiebreak-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-earlier-created.md",
      memoryDoc(
        "fact-earlier-created",
        "Equal updated timestamps should still sort by created timestamp.",
        ['created: 2026-03-01T00:00:00.000Z', 'updated: 2026-03-08T12:00:00.000Z'],
      ),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-05/fact-later-created.md",
      memoryDoc(
        "fact-later-created",
        "Equal updated timestamps should still sort by created timestamp.",
        ['created: 2026-03-05T00:00:00.000Z', 'updated: 2026-03-08T12:00:00.000Z'],
      ),
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const projectedPage = await service.memoryBrowse({
      sort: "updated_desc",
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(projectedPage.memories.map((memory) => memory.id), [
      "fact-later-created",
      "fact-earlier-created",
    ]);

    await rm(getMemoryProjectionPath(memoryDir), { force: true });

    const fallbackPage = await service.memoryBrowse({
      sort: "updated_desc",
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(fallbackPage.memories.map((memory) => memory.id), [
      "fact-later-created",
      "fact-earlier-created",
    ]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service fallback browse infers archived status from archive paths without a projection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-fallback-archived-"));
  try {
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      memoryDoc(
        "fact-archived",
        "Archived memory that should still appear without projection browse.",
        ['entityRef: person-retired', 'tags: ["legacy", "browser", "legacy"]'],
      ),
    );

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({
      query: "archived memory",
      status: "archived",
      category: "fact",
    });
    assert.equal(browse.total, 1);
    assert.equal(browse.memories[0]?.id, "fact-archived");
    assert.equal(browse.memories[0]?.status, "archived");
    assert.deepEqual(browse.memories[0]?.tags, ["browser", "legacy"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service projection browse matches full content beyond preview text", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-projection-content-"));
  try {
    const deepNeedle = "full content projection query";
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-deep.md",
      memoryDoc(
        "fact-deep",
        `${"alpha ".repeat(60)}${deepNeedle}`,
        ['entityRef: person-deep', 'tags: ["projection", "content"]'],
      ),
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({
      query: deepNeedle,
      status: "active",
      category: "fact",
    });
    assert.equal(browse.total, 1);
    assert.equal(browse.count, 1);
    assert.equal(browse.memories[0]?.id, "fact-deep");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service reviewQueue and maintenance fall back to governance artifacts when projection is absent", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-fallback-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc("fact-duplicate-a", "Exact duplicate for governance fallback coverage.", ['confidence: 0.95']),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc("fact-duplicate-b", "Exact duplicate for governance fallback coverage.", ['confidence: 0.45']),
    );

    const governance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const queue = await service.reviewQueue(undefined, "global");
    assert.equal(queue.found, true);
    assert.equal(queue.namespace, "global");
    assert.equal(queue.runId, governance.runId);
    assert.equal(queue.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"), true);
    assert.equal((queue.qualityScore?.score ?? 0) < 100, true);
    assert.equal(Object.keys(queue.transitionReport?.proposed ?? {}).length > 0, true);

    const maintenance = await service.maintenance("global");
    assert.equal(maintenance.health.projectionAvailable, false);
    assert.equal(maintenance.namespace, "global");
    assert.equal(maintenance.latestGovernanceRun.found, true);
    assert.equal(maintenance.latestGovernanceRun.runId, governance.runId);
    assert.equal(
      maintenance.latestGovernanceRun.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"),
      true,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service serves reviewQueue and maintenance from projection when governance artifacts are gone", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-projection-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc("fact-duplicate-a", "Exact duplicate for projection review queue coverage.", ['confidence: 0.95']),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc("fact-duplicate-b", "Exact duplicate for projection review queue coverage.", ['confidence: 0.45']),
    );

    const governance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-09T12:05:00.000Z"),
    });
    await rm(path.join(memoryDir, "state", "memory-governance"), { recursive: true, force: true });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const queue = await service.reviewQueue(governance.runId);
    assert.equal(queue.found, true);
    assert.equal(queue.namespace, "global");
    assert.equal(queue.runId, governance.runId);
    assert.equal(queue.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"), true);
    assert.equal("runId" in (queue.reviewQueue?.[0] ?? {}), false);
    assert.equal((queue.qualityScore?.score ?? 0) < 100, true);
    assert.ok(queue.transitionReport);
    assert.equal(Object.keys(queue.transitionReport?.proposed ?? {}).length > 0, true);
    assert.equal(Object.keys(queue.transitionReport?.applied ?? {}).length, 0);

    const maintenance = await service.maintenance("global");
    assert.equal(maintenance.health.projectionAvailable, true);
    assert.equal(maintenance.namespace, "global");
    assert.equal(maintenance.latestGovernanceRun.found, true);
    assert.equal(maintenance.latestGovernanceRun.runId, governance.runId);
    assert.equal(
      maintenance.latestGovernanceRun.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"),
      true,
    );
    assert.equal("runId" in (maintenance.latestGovernanceRun.reviewQueue?.[0] ?? {}), false);
    assert.ok(maintenance.latestGovernanceRun.transitionReport);
    assert.equal(Object.keys(maintenance.latestGovernanceRun.transitionReport?.proposed ?? {}).length > 0, true);
    assert.equal(Object.keys(maintenance.latestGovernanceRun.transitionReport?.applied ?? {}).length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service builds a quality dashboard summary from memory state and governance artifacts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-quality-"));
  try {
    await writeText(
      memoryDir,
      "facts/2025-11-01/fact-stale-low.md",
      memoryDoc(
        "fact-stale-low",
        "Potential archive candidate with stale low-confidence memory content.",
        [
          'created: 2025-11-01T00:00:00.000Z',
          'updated: 2025-11-02T00:00:00.000Z',
          'confidence: 0.45',
          'confidenceTier: tentative',
          'status: PENDING_REVIEW',
        ],
      ),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-fresh.md",
      memoryDoc(
        "fact-fresh",
        "Fresh active memory for quality dashboard coverage.",
        [
          'created: 2026-03-08T00:00:00.000Z',
          'updated: 2026-03-08T00:00:00.000Z',
          'confidence: 0.92',
          'confidenceTier: explicit',
        ],
      ),
    );
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      memoryDoc(
        "fact-archived",
        "Archived memory for quality dashboard coverage.",
        [
          'created: 2026-02-15T00:00:00.000Z',
          'updated: 2026-02-16T00:00:00.000Z',
          'archivedAt: 2026-03-08T00:00:00.000Z',
          'confidence: 0.7',
          'confidenceTier: implied',
        ],
      ),
    );

    await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const quality = await service.quality();
    assert.equal(quality.totalMemories, 3);
    assert.equal(quality.statusCounts.pending_review, 1);
    assert.equal(quality.statusCounts.active, 1);
    assert.equal(quality.statusCounts.archived, 1);
    assert.equal(quality.confidenceTierCounts.tentative, 1);
    assert.equal(quality.archivePressure.pendingReview, 1);
    assert.equal(quality.archivePressure.archived, 1);
    assert.equal(quality.archivePressure.lowConfidenceActive, 0);
    assert.equal(quality.latestGovernanceRun.found, true);
    assert.equal(typeof quality.latestGovernanceRun.qualityScore?.score, "number");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service backfills projected governance quality scores from projected metrics when artifacts are gone", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-quality-"));
  try {
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () =>
        ({
          dir: memoryDir,
          async getProjectedGovernanceRecord() {
            return {
              runId: "gov-legacy",
              summary: {
                runId: "gov-legacy",
                traceId: "trace-legacy",
                mode: "shadow",
                createdAt: "2026-03-09T12:00:00.000Z",
                scannedMemories: 2,
                reviewQueueCount: 1,
                proposedActionCount: 1,
                appliedActionCount: 0,
                ruleVersion: "memory-governance.v2",
                schemaVersion: 1,
              },
              metrics: {
                reviewReasons: {
                  exact_duplicate: 1,
                  semantic_duplicate_candidate: 0,
                  disputed_memory: 0,
                  speculative_low_confidence: 0,
                  archive_candidate: 0,
                  explicit_capture_review: 0,
                  malformed_import: 0,
                },
                proposedStatuses: {
                  pending_review: 1,
                },
                keptMemoryCount: 1,
              },
              reviewQueueRows: [{
                runId: "gov-legacy",
                entryId: "review:fact-1:exact_duplicate",
                memoryId: "fact-1",
                path: path.join(memoryDir, "facts/2026-03-01/fact-1.md"),
                reasonCode: "exact_duplicate",
                severity: "medium",
                suggestedAction: "set_status",
                suggestedStatus: "pending_review",
                relatedMemoryIds: ["fact-2"],
              }],
              appliedActionRows: [],
              report: "legacy projected report",
            };
          },
          async getMemoryById(memoryId: string) {
            if (memoryId !== "fact-1") return null;
            return {
              path: path.join(memoryDir, "facts/2026-03-01/fact-1.md"),
              frontmatter: {
                id: "fact-1",
                category: "fact",
                created: "2026-03-01T00:00:00.000Z",
                updated: "2026-03-01T00:00:00.000Z",
                source: "test",
                confidence: 0.9,
                confidenceTier: "explicit",
                tags: [],
              },
              content: "Exact duplicate for projected quality-score fallback coverage.",
            };
          },
        }) as any,
    } as any);

    const queue = await service.reviewQueue("gov-legacy");
    assert.equal(queue.found, true);
    assert.equal(queue.qualityScore?.score, 94);
    assert.equal(queue.qualityScore?.grade, "excellent");
    assert.equal(queue.metrics?.qualityScore?.score, 94);
    assert.equal(queue.metrics?.qualityScore?.grade, "excellent");
    assert.equal(Object.keys(queue.transitionReport?.proposed ?? {}).length > 0, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service projected governance fallback mirrors same-status filtering and per-memory action priority", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-proposed-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-01/fact-1.md");
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () =>
        ({
          dir: memoryDir,
          async getProjectedGovernanceRecord() {
            return {
              runId: "gov-proposed",
              summary: {
                runId: "gov-proposed",
                traceId: "trace-proposed",
                mode: "shadow",
                createdAt: "2026-03-09T12:00:00.000Z",
                scannedMemories: 1,
                reviewQueueCount: 2,
                proposedActionCount: 1,
                appliedActionCount: 0,
                ruleVersion: "memory-governance.v2",
                schemaVersion: 1,
              },
              metrics: {
                reviewReasons: {
                  exact_duplicate: 0,
                  semantic_duplicate_candidate: 0,
                  disputed_memory: 0,
                  speculative_low_confidence: 0,
                  archive_candidate: 1,
                  explicit_capture_review: 1,
                  malformed_import: 0,
                },
                proposedStatuses: {
                  archived: 1,
                },
                keptMemoryCount: 0,
              },
              reviewQueueRows: [
                {
                  runId: "gov-proposed",
                  entryId: "review:fact-1:explicit_capture_review",
                  memoryId: "fact-1",
                  path: memoryPath,
                  reasonCode: "explicit_capture_review",
                  severity: "low",
                  suggestedAction: "set_status",
                  suggestedStatus: "pending_review",
                  relatedMemoryIds: [],
                },
                {
                  runId: "gov-proposed",
                  entryId: "review:fact-1:archive_candidate",
                  memoryId: "fact-1",
                  path: memoryPath,
                  reasonCode: "archive_candidate",
                  severity: "medium",
                  suggestedAction: "archive",
                  suggestedStatus: undefined,
                  relatedMemoryIds: [],
                },
              ],
              appliedActionRows: [],
              report: "projected proposed report",
            };
          },
          async getMemoryById(memoryId: string) {
            if (memoryId !== "fact-1") return null;
            return {
              path: memoryPath,
              frontmatter: {
                id: "fact-1",
                category: "fact",
                created: "2026-03-01T00:00:00.000Z",
                updated: "2026-03-01T00:00:00.000Z",
                source: "test",
                confidence: 0.9,
                confidenceTier: "explicit",
                status: "pending_review",
                tags: [],
              },
              content: "Projected review queue dedupe coverage.",
            };
          },
        }) as any,
    } as any);

    const queue = await service.reviewQueue("gov-proposed");
    assert.equal(queue.found, true);
    assert.deepEqual(Object.keys(queue.transitionReport?.proposed ?? {}), ["archived"]);
    assert.equal(queue.transitionReport?.proposed.archived?.length, 1);
    assert.equal(queue.transitionReport?.proposed.archived?.[0]?.reasonCode, "archive_candidate");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service projected governance response reconstructs proposed transitions when legacy artifacts leave them empty", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-legacy-transitions-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-01/fact-1.md");
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/summary.json",
      JSON.stringify({
        runId: "gov-legacy-artifact",
        traceId: "trace-legacy-artifact",
        mode: "shadow",
        createdAt: "2026-03-09T12:00:00.000Z",
        scannedMemories: 1,
        reviewQueueCount: 1,
        proposedActionCount: 1,
        appliedActionCount: 0,
        ruleVersion: "memory-governance.v2",
        schemaVersion: 1,
      }),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/metrics.json",
      JSON.stringify({
        reviewReasons: {
          exact_duplicate: 0,
          semantic_duplicate_candidate: 0,
          disputed_memory: 0,
          speculative_low_confidence: 0,
          archive_candidate: 1,
          explicit_capture_review: 0,
          malformed_import: 0,
        },
        proposedStatuses: {
          archived: 1,
        },
        keptMemoryCount: 0,
      }),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/kept-memories.json",
      JSON.stringify([]),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/review-queue.json",
      JSON.stringify([]),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/applied-actions.json",
      JSON.stringify([]),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/status-transitions.json",
      JSON.stringify({
        proposed: {},
        applied: {},
      }),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        runId: "gov-legacy-artifact",
        traceId: "trace-legacy-artifact",
        mode: "shadow",
        createdAt: "2026-03-09T12:00:00.000Z",
        ruleVersion: "memory-governance.v2",
        artifacts: {},
      }),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/report.md",
      "legacy artifact report\n",
    );

    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () =>
        ({
          dir: memoryDir,
          async getProjectedGovernanceRecord() {
            return {
              runId: "gov-legacy-artifact",
              summary: {
                runId: "gov-legacy-artifact",
                traceId: "trace-legacy-artifact",
                mode: "shadow",
                createdAt: "2026-03-09T12:00:00.000Z",
                scannedMemories: 1,
                reviewQueueCount: 1,
                proposedActionCount: 1,
                appliedActionCount: 0,
                ruleVersion: "memory-governance.v2",
                schemaVersion: 1,
              },
              metrics: {
                reviewReasons: {
                  exact_duplicate: 0,
                  semantic_duplicate_candidate: 0,
                  disputed_memory: 0,
                  speculative_low_confidence: 0,
                  archive_candidate: 1,
                  explicit_capture_review: 0,
                  malformed_import: 0,
                },
                proposedStatuses: {
                  archived: 1,
                },
                keptMemoryCount: 0,
              },
              reviewQueueRows: [{
                runId: "gov-legacy-artifact",
                entryId: "review:fact-1:archive_candidate",
                memoryId: "fact-1",
                path: memoryPath,
                reasonCode: "archive_candidate",
                severity: "medium",
                suggestedAction: "archive",
                suggestedStatus: undefined,
                relatedMemoryIds: [],
              }],
              appliedActionRows: [],
              report: "legacy artifact report",
            };
          },
          async getMemoryById(memoryId: string) {
            if (memoryId !== "fact-1") return null;
            return {
              path: memoryPath,
              frontmatter: {
                id: "fact-1",
                category: "fact",
                created: "2026-03-01T00:00:00.000Z",
                updated: "2026-03-01T00:00:00.000Z",
                source: "test",
                confidence: 0.9,
                confidenceTier: "explicit",
                status: "active",
                tags: [],
              },
              content: "Legacy artifact projected transition fallback coverage.",
            };
          },
        }) as any,
    } as any);

    const queue = await service.reviewQueue("gov-legacy-artifact");
    assert.equal(queue.found, true);
    assert.deepEqual(Object.keys(queue.transitionReport?.proposed ?? {}), ["archived"]);
    assert.equal(queue.transitionReport?.proposed.archived?.length, 1);
    assert.equal(queue.transitionReport?.proposed.archived?.[0]?.memoryId, "fact-1");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service maintenance uses namespace-scoped health metadata", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-maintenance-namespace-"));
  try {
    const globalDir = memoryDir;
    const projectDir = path.join(memoryDir, "namespaces", "project-x");
    await mkdir(path.dirname(getMemoryProjectionPath(projectDir)), { recursive: true });
    await writeFile(getMemoryProjectionPath(projectDir), "");

    const globalStorage = new StorageManager(globalDir);
    const projectStorage = new StorageManager(projectDir);
    const service = new EngramAccessService({
      config: {
        memoryDir: globalDir,
        namespacesEnabled: true,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [
          {
            name: "project-x",
            readPrincipals: ["project-x"],
            writePrincipals: ["project-x"],
          },
        ],
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async (namespace?: string) => (namespace === "project-x" ? projectStorage : globalStorage),
    } as any);

    const maintenance = await service.maintenance("project-x", "project-x");
    assert.equal(maintenance.namespace, "project-x");
    assert.equal(maintenance.health.memoryDir, projectDir);
    assert.equal(maintenance.health.projectionAvailable, true);

    const globalMaintenance = await service.maintenance("global", "test-user");
    assert.equal(globalMaintenance.health.memoryDir, globalDir);
    assert.equal(globalMaintenance.health.projectionAvailable, false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service governanceRun skips entity synthesis refresh in shadow mode", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-shadow-synthesis-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    let synthesisCalls = 0;
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "default",
        searchBackend: "qmd",
        qmdEnabled: false,
        nativeKnowledge: undefined,
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [],
        dreamsPhases: dreamsPhasesConfig(),
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
      processEntitySynthesisQueue: async () => {
        synthesisCalls += 1;
        throw new Error("shadow mode must not refresh synthesis");
      },
    } as any);

    const result = await service.governanceRun({ mode: "shadow" });
    assert.equal(result.mode, "shadow");
    assert.equal(synthesisCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service governanceRun rejects when deep sleep is disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-disabled-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "default",
        searchBackend: "qmd",
        qmdEnabled: false,
        nativeKnowledge: undefined,
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [],
        dreamsPhases: dreamsPhasesConfig(false, true),
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    await assert.rejects(
      () => service.governanceRun({ mode: "shadow" }),
      /memory governance is disabled by dreams\.phases\.deepSleep\.enabled=false/,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service governanceRun allows defaulted deep sleep false for manual runs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-defaulted-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "default",
        searchBackend: "qmd",
        qmdEnabled: false,
        nativeKnowledge: undefined,
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [],
        dreamsPhases: dreamsPhasesConfig(false),
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const result = await service.governanceRun({ mode: "shadow" });
    assert.equal(result.mode, "shadow");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service governanceRun preserves apply result when entity synthesis refresh fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-apply-synthesis-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    let synthesisCalls = 0;
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "default",
        searchBackend: "qmd",
        qmdEnabled: false,
        nativeKnowledge: undefined,
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [],
        dreamsPhases: dreamsPhasesConfig(),
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
      processEntitySynthesisQueue: async () => {
        synthesisCalls += 1;
        throw new Error("synthetic refresh failure");
      },
    } as any);

    const result = await service.governanceRun({ mode: "apply" });
    assert.equal(result.mode, "apply");
    assert.equal(synthesisCalls, 1);
    assert.match(result.runId, /^gov-/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service maps trust-zone promotion validation failures to input errors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-trust-zone-promote-"));
  try {
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
        trustZonesEnabled: true,
        quarantinePromotionEnabled: true,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => ({ dir: memoryDir }),
    } as any);

    await assert.rejects(
      () => service.trustZonePromote({
        recordId: "tz-missing",
        targetZone: "trusted",
        promotionReason: "Operator approved",
        recordedAt: "2026-03-08T00:05:00.000Z",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        err.message === "source trust-zone record not found: tz-missing",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service maps invalid trust-zone demo seed requests to input errors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-trust-zone-seed-"));
  try {
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
        trustZonesEnabled: true,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => ({ dir: memoryDir }),
    } as any);

    await assert.rejects(
      () => service.trustZoneDemoSeed({ scenario: "bogus-scenario" }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        err.message === "unsupported trust-zone demo scenario: bogus-scenario",
    );

    await assert.rejects(
      () => service.trustZoneDemoSeed({ recordedAt: "2026-03-30Tbad" }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        err.message === "recordedAt must be an ISO timestamp",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service trust-zone browse reports promotions as blocked when promotion is disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-trust-zone-browse-disabled-"));
  try {
    await recordTrustZoneRecord({
      memoryDir,
      record: {
        schemaVersion: 1,
        recordId: "tz-working-demo",
        zone: "working",
        recordedAt: "2026-03-08T00:00:00.000Z",
        kind: "state",
        summary: "Anchored working record.",
        provenance: {
          sourceClass: "tool_output",
          observedAt: "2026-03-08T00:00:00.000Z",
          sourceId: "tool:deploy",
          evidenceHash: "sha256:deploy",
        },
        entityRefs: ["deploy:47"],
        tags: ["release-47"],
      },
    });
    await recordTrustZoneRecord({
      memoryDir,
      record: {
        schemaVersion: 1,
        recordId: "tz-working-corroboration",
        zone: "working",
        recordedAt: "2026-03-08T00:01:00.000Z",
        kind: "external",
        summary: "Corroborating ticket.",
        provenance: {
          sourceClass: "web_content",
          observedAt: "2026-03-08T00:01:00.000Z",
          sourceId: "https://tickets.example.com/CHG-47",
          evidenceHash: "sha256:chg-47",
        },
        entityRefs: ["deploy:47"],
        tags: ["release-47"],
      },
    });

    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
        trustZonesEnabled: true,
        quarantinePromotionEnabled: false,
        memoryPoisoningDefenseEnabled: true,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => ({ dir: memoryDir }),
    } as any);

    const browse = await service.trustZoneBrowse({ zone: "working", limit: 10 });
    const target = browse.records.find((record) => record.recordId === "tz-working-demo");
    assert.ok(target);
    assert.equal(target.nextPromotionTarget, "trusted");
    assert.equal(target.nextPromotionAllowed, false);
    assert.match((target.nextPromotionReasons ?? []).join(" "), /quarantinePromotionEnabled=true/i);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 3 (#396): briefing() must reject invalid window tokens
// ──────────────────────────────────────────────────────────────────────────

function createBriefingService() {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "restricted-ns",
          readPrincipals: ["trusted-agent"],
          writePrincipals: ["trusted-agent"],
        },
      ],
      defaultRecallNamespaces: ["global"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      briefing: {
        enabled: true,
        defaultWindow: "yesterday",
        defaultFormat: "markdown",
        maxFollowups: 0,
        calendarSource: null,
        saveByDefault: false,
        saveDir: null,
        llmFollowups: false,
      },
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({
      readAllMemories: async () => [],
      readAllEntityFiles: async () => [],
      ensureDirectories: async () => {},
    }),
  };
  return new EngramAccessService(orchestrator as any);
}

test("briefing() rejects invalid since token with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ since: "3x", principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /invalid briefing window/.test(err.message),
  );
});

test("briefing() rejects invalid since token even when a default exists", async () => {
  const service = createBriefingService();
  // The explicit since value overrides the config default — it must be validated.
  await assert.rejects(
    () => service.briefing({ since: "99z" }),
    (err: unknown) => err instanceof EngramAccessInputError,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Focus filter validation (#396 Codex follow-up): `parseBriefingFocus` returns
// null for malformed values like "project:" (empty suffix). `briefing()` must
// reject these explicitly so a templating miss in automation cannot silently
// broaden a targeted project briefing into an unscoped, all-memories briefing.
// ──────────────────────────────────────────────────────────────────────────

test("briefing() rejects malformed focus filter 'project:' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ focus: "project:", principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /invalid briefing focus filter/.test(err.message),
  );
});

test("briefing() rejects malformed focus filter 'topic:' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ focus: "topic:", principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /invalid briefing focus filter/.test(err.message),
  );
});

test("briefing() accepts undefined focus (no filter applied)", async () => {
  const service = createBriefingService();
  // No focus supplied — the briefing should build normally.
  const result = await service.briefing({ principal: "test-user" });
  assert.ok(result, "briefing should succeed with no focus filter");
});

test("briefing() accepts empty-string focus as 'no filter'", async () => {
  const service = createBriefingService();
  // Empty / whitespace-only string is treated as absent, not malformed.
  const result = await service.briefing({ focus: "   ", principal: "test-user" });
  assert.ok(result, "briefing should succeed with whitespace-only focus");
});

test("briefing() accepts a well-formed focus filter 'project:remnic-core'", async () => {
  const service = createBriefingService();
  const result = await service.briefing({ focus: "project:remnic-core", principal: "test-user" });
  assert.ok(result, "briefing should succeed with a valid focus filter");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 6 (#396): briefing() uses caller principal for namespace access
// ──────────────────────────────────────────────────────────────────────────

test("briefing() rejects when namespace is not readable by the caller principal", async () => {
  const service = createBriefingService();
  // "untrusted-agent" is not in the readPrincipals for "restricted-ns"
  await assert.rejects(
    () =>
      service.briefing({
        namespace: "restricted-ns",
        principal: "untrusted-agent",
      }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /namespace is not readable/.test(err.message),
  );
});

test("briefing() allows access when namespace is readable by the caller principal", async () => {
  const service = createBriefingService();
  // "trusted-agent" is in readPrincipals for "restricted-ns"
  const result = await service.briefing({
    namespace: "restricted-ns",
    principal: "trusted-agent",
  });
  assert.equal(result.namespace, "restricted-ns");
});

// ──────────────────────────────────────────────────────────────────────────
// PRRT_kwDORJXyws56U_7P: Reject unsupported briefing formats in access service
// ──────────────────────────────────────────────────────────────────────────
// Direct / programmatic callers bypass CLI and MCP pre-validation layers.
// Passing an unknown format must raise EngramAccessInputError rather than
// silently falling back to the configured default format.

test("briefing() rejects unsupported format 'jsno' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ format: "jsno" as never, principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /unsupported briefing format/.test(err.message) &&
      err.message.includes("jsno"),
  );
});

test("briefing() rejects unsupported format 'xml' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ format: "xml" as never, principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /unsupported briefing format/.test(err.message),
  );
});

test("briefing() rejects unsupported format 'text' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ format: "text" as never }),
    (err: unknown) => err instanceof EngramAccessInputError,
  );
});

test("briefing() accepts valid format 'markdown' without error", async () => {
  const service = createBriefingService();
  const result = await service.briefing({ format: "markdown", principal: "test-user" });
  assert.equal(result.format, "markdown", "valid markdown format must be accepted");
});

test("briefing() accepts valid format 'json' without error", async () => {
  const service = createBriefingService();
  const result = await service.briefing({ format: "json", principal: "test-user" });
  assert.equal(result.format, "json", "valid json format must be accepted");
});

test("briefing() accepts absent format (undefined) without error and uses default", async () => {
  const service = createBriefingService();
  // No format supplied — should use config.briefing.defaultFormat ("markdown").
  const result = await service.briefing({ principal: "test-user" });
  assert.ok(
    result.format === "markdown" || result.format === "json",
    "absent format must resolve to the configured default",
  );
});

test("access service recall records audit entries and detects anomalies when enabled", async () => {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallAuditAnomalyDetectionEnabled: true,
      recallAuditAnomalyWindowMs: 60_000,
      recallAuditAnomalyRepeatQueryLimit: 2,
      recallAuditAnomalyNamespaceWalkLimit: 3,
      recallAuditAnomalyHighCardinalityLimit: 50,
      recallAuditAnomalyRapidFireLimit: 30,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  const service = new EngramAccessService(orchestrator as any);

  // First recall — no anomalies expected
  const res1 = await service.recall({
    query: "test query",
    sessionKey: "agent:test:chat",
  });
  assert.ok(res1, "first recall should succeed");

  // Repeat the same query to trigger repeat-query anomaly
  const res2 = await service.recall({
    query: "test query",
    sessionKey: "agent:test:chat",
  });
  assert.ok(res2, "second recall should succeed");

  // Third repeat should trigger the anomaly detector
  const res3 = await service.recall({
    query: "test query",
    sessionKey: "agent:test:chat",
  });
  assert.ok(res3, "third recall should succeed");
  assert.ok(res3.auditAnomalies, "should have audit anomalies after repeat queries");
  assert.ok(res3.auditAnomalies!.flags.length > 0, "should have at least one anomaly flag");
});

test("access service recall has no audit anomalies when detection is disabled", async () => {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallAuditAnomalyDetectionEnabled: false,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  const service = new EngramAccessService(orchestrator as any);

  const res = await service.recall({
    query: "test query",
    sessionKey: "agent:test:chat",
  });
  assert.equal(res.auditAnomalies, undefined, "no audit anomalies when disabled");
});

test("access service recall enforces cross-namespace budget when enabled", async () => {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        { name: "project-x", readPrincipals: ["project-x", "attacker"], writePrincipals: ["project-x"] },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: true,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 2,
      recallCrossNamespaceBudgetHardLimit: 3,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  const service = new EngramAccessService(orchestrator as any);

  // First 3 cross-namespace recalls should succeed (under hard limit)
  for (let i = 0; i < 3; i++) {
    const res = await service.recall({
      query: `query ${i}`,
      sessionKey: "agent:attacker:chat",
      namespace: "project-x",
    });
    assert.ok(res, `recall ${i} should succeed`);
  }

  // 4th cross-namespace recall should be denied
  await assert.rejects(
    () => service.recall({
      query: "one more",
      sessionKey: "agent:attacker:chat",
      namespace: "project-x",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message.includes("cross-namespace budget exceeded"),
  );
});

test("access service recall surfaces budgetWarning when over soft limit", async () => {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        { name: "project-x", readPrincipals: ["project-x", "attacker"], writePrincipals: ["project-x"] },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: true,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 1,
      recallCrossNamespaceBudgetHardLimit: 10,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  const service = new EngramAccessService(orchestrator as any);

  // First call — under soft limit, no warning
  const res1 = await service.recall({
    query: "first",
    sessionKey: "agent:attacker:chat",
    namespace: "project-x",
  });
  assert.equal(res1.budgetWarning, undefined);

  // Second call — over soft limit, warning present
  const res2 = await service.recall({
    query: "second",
    sessionKey: "agent:attacker:chat",
    namespace: "project-x",
  });
  assert.ok(res2.budgetWarning, "should have budgetWarning");
  assert.equal(res2.budgetWarning!.reason, "warn-over-soft");
});

test("access service liveConnectorsRun enforces write ACL before ingestion", async () => {
  let runCount = 0;
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "global",
          readPrincipals: ["reader", "writer"],
          writePrincipals: ["writer"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      recallAuditAnomalyDetectionEnabled: false,
    },
    runLiveConnectors: async () => {
      runCount += 1;
      return {
        ranAt: "2026-04-28T00:00:00.000Z",
        force: false,
        totalDocsImported: 0,
        ranCount: 0,
        skippedCount: 0,
        errorCount: 0,
        results: [],
      };
    },
  };
  const service = new EngramAccessService(orchestrator as any);

  await assert.rejects(
    () => service.liveConnectorsRun({}, "reader"),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message.includes("namespace is not writable: global"),
  );
  assert.equal(runCount, 0);

  await service.liveConnectorsRun({}, "writer");
  assert.equal(runCount, 1);
});

test("access service idempotent recall retries do not double count cross-namespace budget", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-recall-idempotent-"));
  let recallCalls = 0;
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "shared",
          readPrincipals: ["project-x"],
          writePrincipals: [],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: true,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 0,
      recallCrossNamespaceBudgetHardLimit: 1,
      dreamsPhases: dreamsPhasesConfig(),
    },
    recall: async () => {
      recallCalls += 1;
      if (recallCalls === 1) {
        throw new Error("transient recall failure");
      }
      return "ctx";
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      dir: memoryDir,
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  } as any);

  const request = {
    query: "hello",
    sessionKey: "agent:project-x:chat",
    namespace: "shared",
    idempotencyKey: "recall-retry-key",
  };

  try {
    await assert.rejects(
      () => service.recall(request),
      /transient recall failure/,
    );

    const response = await service.recall(request);
    assert.equal(response.context, "ctx");
    assert.equal(recallCalls, 2);
    assert.equal(response.budgetWarning?.reason, "warn-over-soft");

    const replay = await service.recall(request);
    assert.equal(replay.context, "ctx");
    assert.equal(recallCalls, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service serializes recall budget records under the hard limit", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-recall-budget-lock-"));
  let recallCalls = 0;
  let releaseFirstRecall: (() => void) | undefined;
  let markFirstRecallEntered: (() => void) | undefined;
  const firstRecallEntered = new Promise<void>((resolve) => {
    markFirstRecallEntered = resolve;
  });
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "shared",
          readPrincipals: ["project-x"],
          writePrincipals: [],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: true,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 0,
      recallCrossNamespaceBudgetHardLimit: 1,
      dreamsPhases: dreamsPhasesConfig(),
    },
    recall: async () => {
      recallCalls += 1;
      if (recallCalls === 1) {
        markFirstRecallEntered?.();
        await new Promise<void>((release) => {
          releaseFirstRecall = release;
        });
      }
      return "ctx";
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      dir: memoryDir,
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  } as any);

  try {
    const first = service.recall({
      query: "hello",
      sessionKey: "agent:project-x:chat",
      namespace: "shared",
      idempotencyKey: "recall-budget-lock-1",
    });
    await firstRecallEntered;

    const second = service.recall({
      query: "hello again",
      sessionKey: "agent:project-x:chat",
      namespace: "shared",
      idempotencyKey: "recall-budget-lock-2",
    });

    await new Promise((settle) => setTimeout(settle, 25));
    assert.equal(recallCalls, 1);
    releaseFirstRecall?.();

    const firstResponse = await first;
    assert.equal(firstResponse.context, "ctx");
    assert.equal(firstResponse.budgetWarning?.reason, "warn-over-soft");
    await assert.rejects(
      () => second,
      /cross-namespace budget exceeded/,
    );
    assert.equal(recallCalls, 1);
  } finally {
    releaseFirstRecall?.();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
