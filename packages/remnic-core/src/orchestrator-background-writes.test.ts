import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
type ShutdownTestSurface = {
  extractionQueueCoordinator: { pauseAndDrain(): Promise<boolean> };
  dependencyPropagationDelivery: { shutdown(): Promise<void> };
};


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
    const replacement = (orchestrator as unknown as { dependencyPropagationDelivery: { shutdown(): Promise<void> } })
      .dependencyPropagationDelivery;
    assert.notEqual(replacement, delivery, "destroy must clear the delivery singleton");
    await replacement.shutdown();
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("destroy keeps propagation delivery intact when extraction drain times out", async () => {
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
  const internals = orchestrator as unknown as ShutdownTestSurface;
  const extractionQueue = internals.extractionQueueCoordinator;
  const delivery = internals.dependencyPropagationDelivery;
  let shutdownCalls = 0;
  const originalShutdown = delivery.shutdown.bind(delivery);
  delivery.shutdown = async () => {
    shutdownCalls += 1;
    await originalShutdown();
  };
  extractionQueue.pauseAndDrain = async () => false;

  try {
    await assert.rejects(
      orchestrator.destroy(),
      /extraction queue did not drain before teardown/,
    );
    assert.equal(shutdownCalls, 0, "delivery must remain intact after a drain timeout");
    assert.equal(internals.dependencyPropagationDelivery, delivery);

    extractionQueue.pauseAndDrain = async () => true;
    await orchestrator.destroy();
    assert.equal(shutdownCalls, 1, "a later destroy retry must shut down delivery");
  } finally {
    extractionQueue.pauseAndDrain = async () => true;
    if (shutdownCalls === 0) await orchestrator.destroy();
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
