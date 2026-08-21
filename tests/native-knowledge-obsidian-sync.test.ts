import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  collectNativeKnowledgeChunks,
  resolveNativeKnowledgeStatePath,
  syncObsidianVaults,
} from "../src/native-knowledge.js";
import type { NativeKnowledgeConfig } from "../src/types.js";

async function createConfig(prefix: string): Promise<{
  memoryDir: string;
  workspaceDir: string;
  vaultDir: string;
  config: NativeKnowledgeConfig;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const memoryDir = path.join(root, "memory");
  const workspaceDir = path.join(root, "workspace");
  const vaultDir = path.join(root, "vault");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(vaultDir, { recursive: true });

  return {
    memoryDir,
    workspaceDir,
    vaultDir,
    config: {
      enabled: true,
      includeFiles: [],
      maxChunkChars: 220,
      maxResults: 4,
      maxChars: 2400,
      stateDir: "state/native-knowledge",
      obsidianVaults: [
        {
          id: "personal",
          rootDir: vaultDir,
          includeGlobs: ["**/*.md"],
          excludeGlobs: [".obsidian/**"],
          folderRules: [],
          dailyNotePatterns: ["YYYY-MM-DD"],
          materializeBacklinks: false,
        },
      ],
    },
  };
}

test("obsidian vault sync tracks incremental updates and deletion tombstones", async () => {
  const { memoryDir, workspaceDir, vaultDir, config } = await createConfig("engram-obsidian-sync");
  const notePath = path.join(vaultDir, "Ideas.md");
  await writeFile(notePath, "# Ideas\n\nCapture agent-native roadmap notes.\n", "utf-8");

  const first = await syncObsidianVaults({ memoryDir, config });
  assert.equal(first.vaultCount, 1);
  assert.equal(first.touchedNotes, 1);
  assert.equal(first.deletedNotes, 0);

  const second = await syncObsidianVaults({ memoryDir, config });
  assert.equal(second.touchedNotes, 0);
  assert.equal(second.deletedNotes, 0);

  await writeFile(notePath, "# Ideas\n\nCapture updated roadmap notes with [[Launch Plan]].\n", "utf-8");
  const third = await syncObsidianVaults({ memoryDir, config });
  assert.equal(third.touchedNotes, 1);

  let chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    defaultNamespace: "default",
  });
  assert.equal(chunks.some((chunk) => chunk.notePath === "Ideas.md"), true);

  await rm(notePath);
  const fourth = await syncObsidianVaults({ memoryDir, config });
  assert.equal(fourth.deletedNotes, 1);

  const state = JSON.parse(await readFile(resolveNativeKnowledgeStatePath(memoryDir, config), "utf-8")) as {
    vaults: Record<string, { notes: Record<string, { deleted: boolean; deletedAt?: string }> }>;
  };
  assert.equal(state.vaults.personal.notes["personal:Ideas.md"]?.deleted, true);
  assert.equal(typeof state.vaults.personal.notes["personal:Ideas.md"]?.deletedAt, "string");

  chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    defaultNamespace: "default",
  });
  assert.equal(chunks.some((chunk) => chunk.notePath === "Ideas.md"), false);
});

test("obsidian vault sync fail-opens when a configured vault root is unavailable", async () => {
  const { memoryDir, workspaceDir, vaultDir, config } = await createConfig("engram-obsidian-unavailable");
  const notePath = path.join(vaultDir, "Ideas.md");
  await writeFile(notePath, "# Ideas\n\nCapture agent-native roadmap notes.\n", "utf-8");

  await syncObsidianVaults({ memoryDir, config });
  await rm(vaultDir, { recursive: true, force: true });

  const result = await syncObsidianVaults({ memoryDir, config });
  assert.equal(result.deletedNotes, 0);

  const state = JSON.parse(await readFile(resolveNativeKnowledgeStatePath(memoryDir, config), "utf-8")) as {
    vaults: Record<string, { notes: Record<string, { deleted: boolean }> }>;
  };
  assert.equal(state.vaults.personal.notes["personal:Ideas.md"]?.deleted, false);

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    defaultNamespace: "default",
  });
  assert.equal(chunks.some((chunk) => chunk.notePath === "Ideas.md"), true);
});

test("obsidian sync persistence failure preserves already collected workspace chunks", async () => {
  const { memoryDir, workspaceDir, vaultDir, config } = await createConfig("engram-obsidian-write-fail");
  config.includeFiles = ["IDENTITY.md"];
  const workspaceDoc = path.join(workspaceDir, "IDENTITY.md");
  const notePath = path.join(vaultDir, "Ideas.md");
  await writeFile(workspaceDoc, "# Identity\n\nWorkspace memory survives sync persistence failures.\n", "utf-8");
  await writeFile(notePath, "# Ideas\n\nCapture agent-native roadmap notes.\n", "utf-8");

  await writeFile(path.join(memoryDir, "state"), "not-a-directory\n", "utf-8");

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    defaultNamespace: "default",
  });

  assert.equal(chunks.some((chunk) => chunk.sourcePath === "IDENTITY.md"), true);
  assert.equal(chunks.some((chunk) => chunk.notePath === "Ideas.md"), true);
});
