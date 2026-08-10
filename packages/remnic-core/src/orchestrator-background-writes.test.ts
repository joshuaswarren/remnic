import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
type ShutdownTestSurface = {
  extractionQueueCoordinator: { pauseAndDrain(): Promise<boolean> };
  dependencyPropagationDelivery: { shutdown(): Promise<void> };
};
function stubOrchestratorInit(orchestrator: Orchestrator): void {
  const initCoordinator = (orchestrator as unknown as {
    orchestratorInitCoordinator: { initialize: () => Promise<void> };
  }).orchestratorInitCoordinator;
  initCoordinator.initialize = async () => {};
}

test("destroy cancels maintenance and waits for tracked writes before disposing search backends", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-background-writes-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      knowledgeIndexEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
    })
  );
  const maintenanceScheduler = (orchestrator as unknown as { maintenanceScheduler: { dispose(): Promise<void> } })
    .maintenanceScheduler;
  const originalMaintenanceDispose = maintenanceScheduler.dispose.bind(maintenanceScheduler);
  let maintenanceDisposed = false;
  maintenanceScheduler.dispose = () => {
    maintenanceDisposed = true;
    return originalMaintenanceDispose();
  };
  const writeGate = Promise.withResolvers<void>();
  let destroySettled = false;
  let destroyPromise: Promise<void> | undefined;

  try {
    orchestrator.trackRecallBackgroundWrite(writeGate.promise, "test background write");
    destroyPromise = orchestrator.destroy().then(() => {
      destroySettled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(destroySettled, false, "destroy must remain pending while a tracked write is pending");
    assert.equal(maintenanceDisposed, true, "destroy must cancel maintenance before waiting for writes");

    writeGate.resolve();
    await destroyPromise;
    assert.equal(destroySettled, true);
  } finally {
    writeGate.resolve();
    await (destroyPromise ?? orchestrator.destroy());
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("disabled propagation does not construct the lazy delivery during initialize", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-disabled-propagation-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      knowledgeIndexEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
    }),
  );
  stubOrchestratorInit(orchestrator);
  const internals = orchestrator as unknown as {
    _dependencyPropagationDelivery: unknown;
    extractionPersistCoordinator: { dependencyPropagationDelivery: unknown };
  };
  try {
    assert.equal(internals._dependencyPropagationDelivery, undefined);
    assert.equal(internals.extractionPersistCoordinator.dependencyPropagationDelivery, undefined);
    await orchestrator.initialize();
    assert.equal(internals._dependencyPropagationDelivery, undefined);
    assert.equal(internals.extractionPersistCoordinator.dependencyPropagationDelivery, undefined);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("enabled propagation recovery rejection does not block initialize", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recovery-rejection-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      dependencyPropagation: {
        enabled: true,
        linkTypes: ["supports"],
        maxDependents: 10,
        timeoutMs: 100,
        dryRun: false,
      },
    }),
  );
  stubOrchestratorInit(orchestrator);
  let recoverCalls = 0;
  Reflect.set(orchestrator, "_dependencyPropagationDelivery", {
    recover: async () => {
      recoverCalls += 1;
      throw new Error("synthetic recovery failure");
    },
    shutdown: async () => {},
  });
  try {
    await orchestrator.initialize();
    assert.equal(recoverCalls, 1);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("enabled propagation recovery tolerates a missing queue directory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recovery-no-queue-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      dependencyPropagation: {
        enabled: true,
        linkTypes: ["supports"],
        maxDependents: 10,
        timeoutMs: 100,
        dryRun: false,
      },
    }),
  );
  stubOrchestratorInit(orchestrator);
  const queueRoot = path.join(memoryDir, "state", "dependency-propagation");
  try {
    await orchestrator.initialize();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(() => stat(queueRoot), /ENOENT/);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("destroy drains consolidation producers before propagation delivery", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-destroy-propagation-order-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      knowledgeIndexEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
    }),
  );
  const order: string[] = [];
  const scheduler = (orchestrator as unknown as { maintenanceScheduler: { dispose(): Promise<void> } })
    .maintenanceScheduler;
  const extractionQueue = (orchestrator as unknown as { extractionQueueCoordinator: { waitForIdle(): Promise<boolean> } })
    .extractionQueueCoordinator;
  const delivery = (orchestrator as unknown as { dependencyPropagationDelivery: { shutdown(): Promise<void> } })
    .dependencyPropagationDelivery;
  const originalSchedulerDispose = scheduler.dispose.bind(scheduler);
  const originalExtractionWait = extractionQueue.waitForIdle.bind(extractionQueue);
  const originalDeliveryShutdown = delivery.shutdown.bind(delivery);
  scheduler.dispose = async () => {
    order.push("scheduler");
    await originalSchedulerDispose();
  };
  extractionQueue.waitForIdle = async () => {
    order.push("extraction");
    return originalExtractionWait();
  };
  delivery.shutdown = async () => {
    order.push("delivery");
    await originalDeliveryShutdown();
  };

  try {
    await orchestrator.destroy();
    assert.deepEqual(order.slice(0, 3), ["scheduler", "extraction", "delivery"]);
    const internals = orchestrator as unknown as {
      _dependencyPropagationDelivery: unknown;
      dependencyPropagationDelivery: unknown;
    };
    assert.equal(internals._dependencyPropagationDelivery, undefined);
    assert.throws(
      () => internals.dependencyPropagationDelivery,
      /orchestrator has been destroyed/,
      "destroyed orchestrators must not recreate delivery",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("destroy continues cleanup when extraction drain times out", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-destroy-propagation-timeout-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      knowledgeIndexEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
    }),
  );
  const internals = orchestrator as unknown as ShutdownTestSurface & {
    _dependencyPropagationDelivery: unknown;
    qmd: { dispose?: () => void | Promise<void> };
  };
  const extractionQueue = internals.extractionQueueCoordinator;
  const delivery = internals.dependencyPropagationDelivery;
  let shutdownCalls = 0;
  let qmdDisposed = false;
  const originalShutdown = delivery.shutdown.bind(delivery);
  const originalQmdDispose = internals.qmd.dispose?.bind(internals.qmd);
  delivery.shutdown = async () => {
    shutdownCalls += 1;
    await originalShutdown();
  };
  internals.qmd.dispose = async () => {
    qmdDisposed = true;
    await originalQmdDispose?.();
  };
  extractionQueue.pauseAndDrain = async () => false;

  try {
    await assert.rejects(
      orchestrator.destroy(),
      /extraction queue did not drain before teardown/,
    );
    assert.equal(shutdownCalls, 1, "delivery shutdown must run after a drain timeout");
    assert.equal(internals._dependencyPropagationDelivery, undefined);
    assert.equal(qmdDisposed, true, "later cleanup must run before the timeout is rethrown");
  } finally {
    extractionQueue.pauseAndDrain = async () => true;
    if (!qmdDisposed) await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});


test("destroy waits for a recall-initiated last-recall write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-background-write-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      knowledgeIndexEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
    })
  );
  const writeStarted = Promise.withResolvers<void>();
  const writeGate = Promise.withResolvers<void>();
  const originalRecord = orchestrator.lastRecall.record.bind(orchestrator.lastRecall);
  orchestrator.lastRecall.record = async (...args: Parameters<typeof originalRecord>) => {
    writeStarted.resolve();
    await writeGate.promise;
    await originalRecord(...args);
  };
  let destroySettled = false;
  let destroyPromise: Promise<void> | undefined;

  try {
    await orchestrator.initialize();
    await orchestrator.recall("recall state drain contract", "session-background-write");
    await writeStarted.promise;
    destroyPromise = orchestrator.destroy().then(() => {
      destroySettled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(destroySettled, false, "destroy must wait for the recall-initiated state write");

    writeGate.resolve();
    await destroyPromise;
    assert.equal(destroySettled, true);
  } finally {
    writeGate.resolve();
    await (destroyPromise ?? orchestrator.destroy());
    await rm(memoryDir, { recursive: true, force: true });
  }
});
