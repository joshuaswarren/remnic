import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";

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
