/**
 * #3287 review: the orchestrator's entity-migration hook used to report success
 * right after arming a debounced timer, so the migration deleted its pending
 * marker before any re-index ran. The hook must report whether the maintenance
 * pass was actually served: false when QMD cannot maintain, and after destroy().
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";

test("the entity-migration hook does not report served when QMD cannot maintain, nor after destroy()", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3287-hook-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3287-hook-ws-"));
  try {
    const orchestrator = new Orchestrator(
      parseConfig({
        openaiApiKey: "sk-test",
        memoryDir,
        workspaceDir,
        qmdEnabled: false,
        topicExtractionEnabled: false,
        summarizationEnabled: false,
        identityEnabled: false,
        entitySummaryEnabled: false,
      }),
    );
    const hook = orchestrator.storage.onEntityMigrationComplete;
    assert.ok(hook, "the orchestrator binds the hook on its storage");
    assert.equal(await hook(), false, "no QMD: nothing will re-index, so the request is not served");
    await orchestrator.destroy();
    assert.equal(await hook(), false, "after destroy() a request is refused");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("the entity-migration hook scopes its request to the namespace its storage is bound to", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3287-scope-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3287-scope-ws-"));
  try {
    const orchestrator = new Orchestrator(
      parseConfig({
        openaiApiKey: "sk-test",
        memoryDir,
        workspaceDir,
        qmdEnabled: false,
        topicExtractionEnabled: false,
        summarizationEnabled: false,
        identityEnabled: false,
        entitySummaryEnabled: false,
      }),
    );
    const requested: Array<string | undefined> = [];
    // SAFETY: maintenanceScheduler is a private MaintenanceScheduler field; this narrows it to the one method the hook calls.
    const scheduler = Object.getOwnPropertyDescriptor(orchestrator, "maintenanceScheduler")?.value as {
      requestQmdMaintenanceCompletion(namespace?: string): Promise<boolean>;
    };
    scheduler.requestQmdMaintenanceCompletion = async (namespace) => {
      requested.push(namespace);
      return false;
    };
    const hook = orchestrator.storage.onEntityMigrationComplete;
    assert.ok(hook);
    await hook();
    assert.deepEqual(requested, ["default"], "the default storage is bound to the default namespace");
    await orchestrator.destroy();
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
