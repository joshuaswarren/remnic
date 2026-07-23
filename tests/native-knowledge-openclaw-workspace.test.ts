import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  collectNativeKnowledgeChunks,
  resolveOpenClawWorkspaceStatePath,
  searchNativeKnowledge,
  type NativeKnowledgeChunk,
} from "../src/native-knowledge.js";
import type { NativeKnowledgeConfig } from "../src/types.js";

function baseConfig(): NativeKnowledgeConfig {
  return {
    enabled: true,
    includeFiles: ["IDENTITY.md"],
    maxChunkChars: 400,
    maxResults: 6,
    maxChars: 2400,
    stateDir: "state/native-knowledge",
    obsidianVaults: [],
    openclawWorkspace: {
      enabled: true,
      bootstrapFiles: ["IDENTITY.md", "USER.md"],
      handoffGlobs: ["handoffs/**/*.md"],
      dailySummaryGlobs: ["summaries/**/*.md"],
      automationNoteGlobs: ["automation/**/*.md"],
      workspaceDocGlobs: ["docs/**/*.md"],
      excludeGlobs: ["node_modules/**", ".git/**"],
      sharedSafeGlobs: ["automation/shared/**/*.md"],
    },
  };
}

test("openclaw workspace adapter syncs metadata, dedupes bootstrap files, and tombstones deletions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-openclaw-workspace-"));
  const workspaceDir = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(path.join(workspaceDir, "handoffs"), { recursive: true });
  await mkdir(path.join(workspaceDir, "summaries"), { recursive: true });
  await mkdir(path.join(workspaceDir, "automation", "shared"), { recursive: true });
  await mkdir(path.join(workspaceDir, "docs"), { recursive: true });

  await writeFile(
    path.join(workspaceDir, "IDENTITY.md"),
    [
      "---",
      "privacyClass: private",
      "---",
      "# Identity",
      "",
      "Prefers concise responses.",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "handoffs", "api-rollout.md"),
    [
      "---",
      "sessionKey: agent:main",
      "workflowKey: roadmap",
      "author: Codex",
      "agent: engram-worker",
      "date: 2026-03-09",
      "---",
      "# API Rollout Handoff",
      "",
      "- Next: verify the replay job before merge.",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "summaries", "daily-summary-2026-03-08.md"),
    "# Daily Summary\n\nThe release checklist was updated for the March 8 ship.\n",
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "automation", "shared", "status.md"),
    [
      "---",
      "workflowKey: review-loop",
      "agent: automation-bot",
      "---",
      "# Automation Status",
      "",
      "The automation monitor is watching the replay job.",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "docs", "playbook.md"),
    "# Playbook\n\nAlways verify the replay job before cutover.\n",
    "utf-8",
  );

  const config = baseConfig();
  let chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    defaultNamespace: "default",
  });

  assert.equal(chunks.filter((chunk) => chunk.sourcePath === "IDENTITY.md").length, 1);

  const bootstrap = chunks.find((chunk) => chunk.sourceKind === "bootstrap_doc" && chunk.sourcePath === "IDENTITY.md");
  const handoff = chunks.find((chunk) => chunk.sourceKind === "handoff");
  const dailySummary = chunks.find((chunk) => chunk.sourceKind === "daily_summary");
  const automation = chunks.find((chunk) => chunk.sourceKind === "automation_note");
  const workspaceDoc = chunks.find((chunk) => chunk.sourceKind === "workspace_doc" && chunk.sourcePath === "docs/playbook.md");

  assert.equal(bootstrap?.title, "Identity");
  assert.equal(handoff?.derivedDate, "2026-03-09");
  assert.equal(handoff?.sessionKey, "agent:main");
  assert.equal(handoff?.workflowKey, "roadmap");
  assert.equal(handoff?.author, "Codex");
  assert.equal(handoff?.agent, "engram-worker");
  assert.equal(dailySummary?.derivedDate, "2026-03-08");
  assert.equal(automation?.privacyClass, "shared_safe");
  assert.equal(automation?.workflowKey, "review-loop");
  assert.equal(automation?.agent, "automation-bot");
  assert.equal(workspaceDoc?.sourcePath, "docs/playbook.md");

  const statePath = resolveOpenClawWorkspaceStatePath(memoryDir, config);
  const firstState = JSON.parse(await readFile(statePath, "utf-8")) as {
    files: Record<string, { deleted: boolean; sourceKind: string }>;
  };
  assert.equal(firstState.files["handoffs/api-rollout.md"]?.deleted, false);
  assert.equal(firstState.files["handoffs/api-rollout.md"]?.sourceKind, "handoff");

  await rm(path.join(workspaceDir, "handoffs", "api-rollout.md"));
  chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    defaultNamespace: "default",
  });

  assert.equal(chunks.some((chunk) => chunk.sourcePath === "handoffs/api-rollout.md"), false);

  const secondState = JSON.parse(await readFile(statePath, "utf-8")) as {
    files: Record<string, { deleted: boolean; deletedAt?: string }>;
  };
  assert.equal(secondState.files["handoffs/api-rollout.md"]?.deleted, true);
  assert.match(secondState.files["handoffs/api-rollout.md"]?.deletedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  const excludedConfig = baseConfig();
  excludedConfig.openclawWorkspace!.excludeGlobs = ["IDENTITY.md", "node_modules/**"];
  const excludedChunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config: excludedConfig,
    defaultNamespace: "default",
  });
  assert.equal(excludedChunks.some((chunk) => chunk.sourcePath === "IDENTITY.md"), false);

  const reclassifiedConfig = baseConfig();
  reclassifiedConfig.openclawWorkspace!.sharedSafeGlobs = [];
  const reclassifiedChunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config: reclassifiedConfig,
    defaultNamespace: "default",
  });
  const reclassifiedAutomation = reclassifiedChunks.find((chunk) => chunk.sourcePath === "automation/shared/status.md");
  assert.equal(reclassifiedAutomation?.privacyClass, undefined);
});

test("searchNativeKnowledge favors handoffs for in-progress work queries", () => {
  const chunks: NativeKnowledgeChunk[] = [
    {
      chunkId: "workspace:1",
      sourcePath: "docs/playbook.md",
      title: "Playbook",
      sourceKind: "workspace_doc",
      startLine: 1,
      endLine: 2,
      content: "Verify the replay job before cutover.",
    },
    {
      chunkId: "automation:1",
      sourcePath: "automation/status.md",
      title: "Automation Status",
      sourceKind: "automation_note",
      startLine: 1,
      endLine: 2,
      content: "Automation is watching the replay job before cutover.",
      workflowKey: "review-loop",
      agent: "automation-bot",
    },
    {
      chunkId: "handoff:1",
      sourcePath: "handoffs/api-rollout.md",
      title: "API Rollout Handoff",
      sourceKind: "handoff",
      startLine: 1,
      endLine: 3,
      content: "Next step: verify the replay job before merge.",
      derivedDate: "2026-03-09",
      sessionKey: "agent:main",
      workflowKey: "roadmap",
    },
  ];

  const results = searchNativeKnowledge({
    query: "what is the next step before merge for the replay job?",
    chunks,
    maxResults: 3,
  });

  assert.equal(results[0]?.sourceKind, "handoff");
  assert.equal(results[0]?.sourcePath, "handoffs/api-rollout.md");
});

test("openclaw workspace adapter respects recall namespace filtering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-openclaw-workspace-namespace-"));
  const workspaceDir = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(path.join(workspaceDir, "handoffs"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, "handoffs", "shared.md"),
    [
      "---",
      "namespace: shared",
      "---",
      "# Shared Handoff",
      "",
      "Shared rollout notes.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const config = baseConfig();
  config.includeFiles = [];
  const hiddenChunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["personal"],
    defaultNamespace: "default",
  });
  assert.equal(hiddenChunks.some((chunk) => chunk.sourcePath === "handoffs/shared.md"), false);

  const visibleChunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["shared"],
    defaultNamespace: "default",
  });
  assert.equal(visibleChunks.some((chunk) => chunk.sourcePath === "handoffs/shared.md"), true);
});

test("openclaw workspace adapter excludes private chunks from shared recall scopes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-openclaw-workspace-private-"));
  const workspaceDir = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(path.join(workspaceDir, "automation", "shared"), { recursive: true });

  await writeFile(
    path.join(workspaceDir, "IDENTITY.md"),
    [
      "---",
      "privacyClass: private",
      "---",
      "# Identity",
      "",
      "Private operator note.",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "automation", "shared", "status.md"),
    "# Automation Status\n\nShared monitor note.\n",
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config: baseConfig(),
    recallNamespaces: ["shared"],
    defaultNamespace: "default",
  });

  assert.equal(chunks.some((chunk) => chunk.sourcePath === "IDENTITY.md"), false);
  assert.equal(chunks.some((chunk) => chunk.sourcePath === "automation/shared/status.md"), true);
});

test("collectNativeKnowledgeChunks keeps bootstrap files in includeFiles when the workspace adapter cannot run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-openclaw-workspace-bootstrap-fallback-"));
  const workspaceDir = path.join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "IDENTITY.md"),
    "# Identity\n\nBootstrap context should still load through includeFiles.\n",
    "utf-8",
  );

  const config = baseConfig();
  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    config,
    defaultNamespace: "default",
  });

  assert.equal(chunks.some((chunk) => chunk.sourcePath === "IDENTITY.md"), true);
  assert.equal(chunks.some((chunk) => chunk.sourceKind === "bootstrap_doc"), false);
});
