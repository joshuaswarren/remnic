import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { parseConfig } from "../packages/remnic-core/src/config.js";
import { Orchestrator } from "../packages/remnic-core/src/orchestrator.js";
import { buildBriefing } from "../packages/remnic-core/src/briefing.js";
import { StorageManager, normalizeEntityName } from "../packages/remnic-core/src/storage.js";
import { withHeldFileLock } from "../packages/remnic-core/src/utils/serialize-mutations.js";

/** Comfortably above a healthy local initialize(), decisively below the 300 s lock wait. */
const STARTUP_BUDGET_MS = 10_000;
/** Budget for work that resumes once the held lock is released. */
const RESUME_BUDGET_MS = 30_000;

const TIMED_OUT = Symbol("timed-out");

async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const expiry = Promise.withResolvers<void>();
  const timer = setTimeout(expiry.resolve, ms);
  try {
    return await Promise.race([work, expiry.promise.then((): typeof TIMED_OUT => TIMED_OUT)]);
  } finally {
    clearTimeout(timer);
  }
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function buildConfig(memoryDir: string, workspaceDir: string) {
  return parseConfig({
    openaiApiKey: false,
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    namespacesEnabled: false,
    embeddingFallbackEnabled: false,
    compoundingEnabled: false,
    transcriptEnabled: false,
    identityContinuityEnabled: false,
    daySummaryEnabled: false,
    hourlySummariesEnabled: false,
    sharedContextEnabled: false,
    entitySummaryEnabled: false,
    nightlyGovernanceCronAutoRegister: false,
    factDeduplicationEnabled: false,
    knowledgeIndexEnabled: false,
    conversationIndexEnabled: false,
    localLlmEnabled: false,
  });
}

async function stop(orchestrator: Orchestrator | undefined): Promise<void> {
  if (!orchestrator) return;
  await orchestrator.storage.ensureDirectories().catch(() => undefined);
  await orchestrator.deferredReady;
  await orchestrator.destroy();
}

async function holdMigrationLock(memoryDir: string): Promise<{ release: () => Promise<void> }> {
  const acquired = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const holder = withHeldFileLock(
    path.join(memoryDir, "state", "entity-canonical-id-migration.lock"),
    { staleMs: 60_000, maxWaitMs: 60_000 },
    async () => {
      acquired.resolve();
      await released.promise;
    },
  );
  await acquired.promise;
  return {
    release: async () => {
      released.resolve();
      await holder;
    },
  };
}

async function seedStore(
  memoryDir: string,
): Promise<{ legacyId: string; canonicalId: string }> {
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  await storage.writeMemory("fact", "The nightly ingest lane owns release approvals.");
  await storage.writeMemory("fact", "Weekly report renders on Mondays at 09:00.");
  await storage.writeEntity("Jane Doe", "person", ["Led the roadmap release."], {
    timestamp: new Date().toISOString(),
    sessionKey: "session-1",
    principal: "agent:main",
    source: "extraction",
  });
  const legacyId = normalizeEntityName("Weekly Report", "automation");
  const canonicalId = normalizeEntityName("Weekly Report", "automation-cron-job");
  assert.notEqual(legacyId, canonicalId, "fixture must actually straddle the rename");
  const stamp = new Date().toISOString();
  await writeFile(
    path.join(memoryDir, "entities", `${legacyId}.md`),
    `---\nid: ${legacyId}\ncreated: ${stamp}\nupdated: ${stamp}\n---\n\n`
    + "# Weekly Report\n\n**Type:** automation-cron-job\n\nRuns Mondays.\n",
    "utf8",
  );
  return { legacyId, canonicalId };
}

test("initialize and briefing stay available while the entity canonical-id migration lock is held", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-canonical-startup-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-canonical-startup-workspace-"));
  let orchestrator: Orchestrator | undefined;
  try {
    const { legacyId, canonicalId } = await seedStore(memoryDir);
    const lock = await holdMigrationLock(memoryDir);
    let storage: StorageManager | undefined;
    let startup: Promise<void> | undefined;
    let startupSettled = true;
    try {
      orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir));
      startup = orchestrator.initialize();
      startupSettled = false;
      const started = await settlesWithin(startup, STARTUP_BUDGET_MS);
      startupSettled = true;
      if (started === TIMED_OUT) {
        assert.fail("initialize() waited for the entity canonical-id replay (issue #3139)");
      }
      storage = await orchestrator.getStorage();

      const memories = await storage.readAllMemories();
      assert.ok(
        memories.some((memory) => memory.content.includes("nightly ingest lane")),
        "the corpus must stay complete while the replay is queued",
      );
      const entities = await storage.readAllEntityFiles();
      assert.ok(
        entities.some((entity) => entity.name === "Jane Doe"),
        "entities must stay readable while the replay is queued",
      );
      assert.ok(
        entities.some((entity) => entity.name === "Weekly Report"),
        "an entity the replay has not reached yet must still be readable",
      );

      const briefing = await settlesWithin(
        buildBriefing({
          storage,
          maxFollowups: 0,
          window: { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000), label: "test" },
        }),
        STARTUP_BUDGET_MS,
      );
      if (briefing === TIMED_OUT) {
        assert.fail("buildBriefing() waited for the entity canonical-id replay (issue #3139)");
      }
      assert.ok(
        (briefing.sections.recentEntities ?? []).some((entity) => entity.name === "Jane Doe"),
        "the briefing must be rendered from the live corpus, not an empty one",
      );
    } finally {
      await lock.release();
      if (startup && !startupSettled) {
        await settlesWithin(startup.catch(() => undefined), RESUME_BUDGET_MS);
      }
    }

    const joined = await settlesWithin(storage!.ensureDirectories(), RESUME_BUDGET_MS);
    if (joined === TIMED_OUT) assert.fail("the deferred replay never completed");
    assert.ok(
      await exists(path.join(memoryDir, "entities", `${canonicalId}.md`)),
      "the replay must still reach the canonical id after startup released it",
    );
    assert.equal(
      await exists(path.join(memoryDir, "entities", `${legacyId}.md`)),
      false,
      "the legacy file must not survive a completed replay",
    );
    assert.equal(
      (await storage!.readAllMemories()).length,
      2,
      "the replay must not drop persisted memories",
    );
  } finally {
    await stop(orchestrator);
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("a write still waits for the canonical-id replay that startup deferred", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-canonical-writewait-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-canonical-writewait-workspace-"));
  let orchestrator: Orchestrator | undefined;
  try {
    const { legacyId, canonicalId } = await seedStore(memoryDir);
    const lock = await holdMigrationLock(memoryDir);
    let storage: StorageManager | undefined;
    let write: Promise<unknown> | undefined;
    try {
      orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir));
      const started = await settlesWithin(orchestrator.initialize(), STARTUP_BUDGET_MS);
      if (started === TIMED_OUT) {
        assert.fail("initialize() waited for the entity canonical-id replay (issue #3139)");
      }
      storage = await orchestrator.getStorage();
      write = storage.writeMemory("fact", "Release approvals moved to the platform team.");
      assert.equal(
        await settlesWithin(write, 250),
        TIMED_OUT,
        "a write must join the deferred replay before it lands",
      );
    } finally {
      await lock.release();
      if (write) await settlesWithin(write.catch(() => undefined), RESUME_BUDGET_MS);
    }

    const joined = await settlesWithin(storage!.ensureDirectories(), RESUME_BUDGET_MS);
    if (joined === TIMED_OUT) assert.fail("the deferred replay never completed");
    assert.ok(
      await exists(path.join(memoryDir, "entities", `${canonicalId}.md`)),
      "the replay the write joined must still run to completion",
    );
    assert.equal(await exists(path.join(memoryDir, "entities", `${legacyId}.md`)), false);
    assert.ok(
      (await storage!.readAllMemories()).some((memory) =>
        memory.content.includes("Release approvals moved"),
      ),
      "the write held behind the replay must land, not vanish",
    );
  } finally {
    await stop(orchestrator);
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("an entity file the replay renamed mid-read is retried under the id the journal records", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-canonical-rename-read-"));
  try {
    const entitiesDir = path.join(baseDir, "entities");
    await mkdir(entitiesDir, { recursive: true });
    const legacyId = normalizeEntityName("Weekly Report", "automation");
    const canonicalId = normalizeEntityName("Weekly Report", "automation-cron-job");
    const entityBody =
      `---\nid: ${canonicalId}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
      + "# Weekly Report\n\n**Type:** automation-cron-job\n\nRuns Mondays.\n";
    await writeFile(path.join(entitiesDir, `${legacyId}.md`), entityBody, "utf8");

    const stateDir = path.join(baseDir, "state");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "entity-canonical-id-migration-v1.json"), JSON.stringify({
      version: 1, complete: true, mappings: { [legacyId]: canonicalId },
    }));
    const store = new StorageManager(baseDir);
    const read = store["readStorageSecureFile"].bind(store);
    const legacyPath = path.join(entitiesDir, `${legacyId}.md`);
    store["readStorageSecureFile"] = async (filePath: string) => {
      if (filePath === legacyPath) {
        await rename(legacyPath, path.join(entitiesDir, `${canonicalId}.md`));
      }
      return read(filePath);
    };

    const entities = await store.readAllEntityFiles();
    assert.deepEqual(
      entities.map((entity) => entity.name),
      ["Weekly Report"],
      "an entity renamed mid-read must come back under its new id, not be dropped",
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("a startup canonical-id replay that fails is retried by the next writer", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-canonical-failure-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-canonical-failure-workspace-"));
  let orchestrator: Orchestrator | undefined;
  try {
    const { legacyId, canonicalId } = await seedStore(memoryDir);
    const journalPath = path.join(memoryDir, "state", "entity-canonical-id-migration-v1.json");
    await writeFile(journalPath, "{ not json", "utf8");

    orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir));
    const started = await settlesWithin(orchestrator.initialize(), STARTUP_BUDGET_MS);
    if (started === TIMED_OUT) {
      assert.fail("initialize() waited for the entity canonical-id replay (issue #3139)");
    }
    const storage = await orchestrator.getStorage();
    assert.equal(
      (await storage.readAllMemories()).length,
      2,
      "a failed replay must not take recall down with it",
    );

    await settlesWithin(storage.ensureDirectories().catch(() => undefined), RESUME_BUDGET_MS);
    await rm(journalPath, { force: true });
    const retry = await settlesWithin(storage.ensureDirectories(), RESUME_BUDGET_MS);
    if (retry === TIMED_OUT) assert.fail("the replay was abandoned after its failure");
    assert.ok(
      await exists(path.join(memoryDir, "entities", `${canonicalId}.md`)),
      "the retried replay must reach the canonical id",
    );
    assert.equal(await exists(path.join(memoryDir, "entities", `${legacyId}.md`)), false);
  } finally {
    await stop(orchestrator);
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});