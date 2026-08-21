import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  collectNativeKnowledgeChunks,
  resolveNativeKnowledgeStatePath,
  searchNativeKnowledge,
} from "../src/native-knowledge.js";
import type { NativeKnowledgeConfig } from "../src/types.js";

async function buildHarness(prefix: string): Promise<{
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
      maxChunkChars: 240,
      maxResults: 4,
      maxChars: 2400,
      stateDir: "state/native-knowledge",
      obsidianVaults: [
        {
          id: "personal",
          rootDir: vaultDir,
          includeGlobs: ["**/*.md"],
          excludeGlobs: [".obsidian/**"],
          namespace: "shared",
          privacyClass: "private",
          folderRules: [
            { pathPrefix: "Projects", namespace: "work", privacyClass: "team" },
          ],
          dailyNotePatterns: ["Daily/YYYY-MM-DD", "YYYY-MM-DD"],
          materializeBacklinks: true,
        },
      ],
    },
  };
}

test("obsidian vault sync preserves aliases tags wikilinks backlinks and daily-note dates", async () => {
  const { memoryDir, workspaceDir, vaultDir, config } = await buildHarness("engram-obsidian-native");
  config.obsidianVaults[0]!.privacyClass = undefined;
  await mkdir(path.join(vaultDir, "Daily"), { recursive: true });
  await mkdir(path.join(vaultDir, "Projects"), { recursive: true });

  await writeFile(
    path.join(vaultDir, "Projects", "Launch Plan.md"),
    [
      "---",
      "aliases:",
      "  - Launch Runbook",
      "tags:",
      "  - ship",
      "  - release",
      "---",
      "# Launch Plan",
      "",
      "Coordinate the [[Daily/2026-03-09]] deployment retrospective and #operations follow-up.",
      "",
      "## Risks",
      "",
      "Track rollback rehearsal windows.",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(vaultDir, "Daily", "2026-03-09.md"),
    "# Daily Note\n\nDeployment retrospective captured the launch checklist.\n",
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["work", "shared"],
    defaultNamespace: "default",
  });

  const launchChunk = chunks.find((chunk) => chunk.notePath === "Projects/Launch Plan.md");
  const dailyChunk = chunks.find((chunk) => chunk.notePath === "Daily/2026-03-09.md");

  assert.equal(launchChunk?.sourceKind, "obsidian_note");
  assert.deepEqual(launchChunk?.aliases, ["Launch Runbook"]);
  assert.deepEqual(launchChunk?.tags, ["operations", "release", "ship"]);
  assert.deepEqual(launchChunk?.wikilinks, ["Daily/2026-03-09"]);
  assert.equal(launchChunk?.namespace, "work");
  assert.equal(launchChunk?.privacyClass, "team");
  assert.ok(dailyChunk?.backlinks?.includes("Projects/Launch Plan.md"));
  assert.equal(dailyChunk?.derivedDate, "2026-03-09");

  const state = JSON.parse(await readFile(resolveNativeKnowledgeStatePath(memoryDir, config), "utf-8")) as {
    vaults: Record<string, { notes: Record<string, { deleted: boolean }> }>;
  };
  assert.equal(state.vaults.personal.notes["personal:Projects/Launch Plan.md"]?.deleted, false);

  const results = searchNativeKnowledge({
    query: "Launch Runbook release 2026-03-09 retrospective",
    chunks,
    maxResults: 3,
  });
  assert.equal(results[0]?.notePath, "Projects/Launch Plan.md");
});

test("obsidian vault sync keeps note aliases separate from aliased wikilinks", async () => {
  const { memoryDir, workspaceDir, vaultDir, config } = await buildHarness("engram-obsidian-link-aliases");
  await mkdir(path.join(vaultDir, "Projects"), { recursive: true });

  await writeFile(
    path.join(vaultDir, "Projects", "Launch Plan.md"),
    [
      "---",
      "aliases:",
      "  - Launch Runbook",
      "---",
      "# Launch Plan",
      "",
      "Coordinate the [[Daily/2026-03-09|retro note]] follow-up.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["work", "shared"],
    defaultNamespace: "default",
  });

  const launchChunk = chunks.find((chunk) => chunk.notePath === "Projects/Launch Plan.md");
  assert.deepEqual(launchChunk?.aliases, ["Launch Runbook"]);
  assert.deepEqual(launchChunk?.wikilinks, ["Daily/2026-03-09"]);
});

test("obsidian vault sync parses CRLF frontmatter metadata", async () => {
  const { memoryDir, workspaceDir, vaultDir, config } = await buildHarness("engram-obsidian-crlf");
  config.obsidianVaults[0]!.privacyClass = undefined;
  await mkdir(path.join(vaultDir, "Daily"), { recursive: true });

  await writeFile(
    path.join(vaultDir, "Daily", "2026-03-10.md"),
    [
      "---",
      "aliases:",
      "  - Release Debrief",
      "tags: [ops, launch]",
      "---",
      "# Daily Note",
      "",
      "Release debrief captured the March 10 checklist.",
      "",
    ].join("\r\n"),
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["shared"],
    defaultNamespace: "default",
  });

  const chunk = chunks.find((entry) => entry.notePath === "Daily/2026-03-10.md");
  assert.deepEqual(chunk?.aliases, ["Release Debrief"]);
  assert.deepEqual(chunk?.tags, ["launch", "ops"]);
  assert.equal(chunk?.derivedDate, "2026-03-10");
});

test("obsidian vault sync enforces namespace boundaries from folder rules", async () => {
  const { memoryDir, workspaceDir, vaultDir, config } = await buildHarness("engram-obsidian-ns");
  await mkdir(path.join(vaultDir, "Projects"), { recursive: true });
  await writeFile(
    path.join(vaultDir, "Projects", "Launch Plan.md"),
    "# Launch Plan\n\nShared rollout details.\n",
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["shared"],
    defaultNamespace: "default",
  });

  assert.equal(chunks.some((chunk) => chunk.notePath === "Projects/Launch Plan.md"), false);
});
