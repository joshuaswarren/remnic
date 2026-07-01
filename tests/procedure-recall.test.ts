import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.ts";
import { parseConfig } from "../packages/remnic-core/src/config.ts";
import { buildProcedureRecallSection } from "../packages/remnic-core/src/procedural/procedure-recall.ts";
import { buildProcedureMarkdownBody } from "../packages/remnic-core/src/procedural/procedure-types.ts";

test("buildProcedureRecallSection returns ranked procedures on task-initiation prompts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-procedure-recall-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const body = buildProcedureMarkdownBody([
      { order: 1, intent: "Run deploy checks for production gateway" },
      { order: 2, intent: "Push the release tag" },
    ]);
    const id = await storage.writeMemory(
      "procedure",
      `When you deploy the gateway\n\n${body}`,
      { source: "test", tags: ["deploy", "gateway"] },
    );

    const config = parseConfig({
      memoryDir: dir,
      workspaceDir: path.join(dir, "ws"),
      openaiApiKey: "test-key",
      procedural: { enabled: true, recallMaxProcedures: 2 },
    });

    const section = await buildProcedureRecallSection(
      storage,
      "Let's deploy the gateway to production today",
      config,
    );
    assert.ok(section);
    assert.match(section, /## Relevant procedures/);
    assert.match(section, new RegExp(id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildProcedureRecallSection returns null when procedural.enabled is false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-procedure-recall-off-"));
  try {
    const storage = new StorageManager(dir);
    const config = parseConfig({
      memoryDir: dir,
      workspaceDir: path.join(dir, "ws"),
      openaiApiKey: "test-key",
      procedural: { enabled: false },
    });
    const section = await buildProcedureRecallSection(storage, "Let's deploy", config);
    assert.equal(section, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scope profile procedure recall merges procedures from later readable layers", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-procedure-profile-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [
        { name: "default", readPrincipals: ["default"], writePrincipals: ["default"] },
        { name: "shared", readPrincipals: ["default"], writePrincipals: ["default"] },
      ],
      defaultScopeProfile: "hosted",
      scopeProfiles: {
        hosted: {
          readOrder: ["userGlobal", "serverShared"],
          writeDefault: "userGlobal",
        },
      },
      procedural: { enabled: true, recallMaxProcedures: 2 },
      qmdEnabled: false,
      knowledgeIndexEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      injectQuestions: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
      recallPipeline: [
        { id: "procedure-recall", enabled: true },
      ],
    });
    const orchestrator = new Orchestrator(config) as any;
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();
    const body = buildProcedureMarkdownBody([
      { order: 1, intent: "Run deploy checks for production gateway" },
      { order: 2, intent: "Push the release tag" },
    ]);
    const id = await sharedStorage.writeMemory(
      "procedure",
      `When you deploy the gateway\n\n${body}`,
      { source: "test", tags: ["deploy", "gateway"] },
    );

    const context = await orchestrator.recallInternal(
      "Let's deploy the gateway to production today",
      "default",
    );

    assert.match(context, /## Relevant procedures/);
    assert.match(context, new RegExp(id));
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
