import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig keeps native knowledge disabled by default", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.nativeKnowledge, undefined);
  assert.equal(cfg.recallPipeline.some((section) => section.id === "native-knowledge"), true);
  const section = cfg.recallPipeline.find((entry) => entry.id === "native-knowledge");
  assert.equal(section?.enabled, false);
  assert.equal(section?.maxResults, 4);
  assert.equal(section?.maxChars, 2400);
});

test("parseConfig supports explicit native knowledge settings", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    nativeKnowledge: {
      enabled: true,
      includeFiles: ["IDENTITY.md", "TEAM.md", "  "],
      maxChunkChars: 1200,
      maxResults: 6,
      maxChars: 3000,
    },
  });

  assert.deepEqual(cfg.nativeKnowledge, {
    enabled: true,
    includeFiles: ["IDENTITY.md", "TEAM.md"],
    maxChunkChars: 1200,
    maxResults: 6,
    maxChars: 3000,
    stateDir: "state/native-knowledge",
    openclawWorkspace: undefined,
    obsidianVaults: [],
  });
  const section = cfg.recallPipeline.find((entry) => entry.id === "native-knowledge");
  assert.equal(section?.enabled, true);
  assert.equal(section?.maxResults, 6);
  assert.equal(section?.maxChars, 3000);
});

test("parseConfig sanitizes obsidian vault adapter settings", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    nativeKnowledge: {
      enabled: true,
      stateDir: "state/custom-native-knowledge",
      obsidianVaults: [
        {
          id: " personal ",
          rootDir: " /vaults/personal ",
          includeGlobs: ["**/*.md", " ", "Projects/**/*.md"],
          excludeGlobs: [".obsidian/**", "", "**/*.png"],
          namespace: " shared ",
          privacyClass: " private ",
          folderRules: [
            { pathPrefix: "Projects/", namespace: "work", privacyClass: "team" },
            { pathPrefix: "  " },
          ],
          dailyNotePatterns: ["YYYY-MM-DD", "Daily/YYYY/MM/DD", ""],
          materializeBacklinks: true,
        },
      ],
    },
  });

  assert.deepEqual(cfg.nativeKnowledge, {
    enabled: true,
    includeFiles: ["IDENTITY.md", "MEMORY.md"],
    maxChunkChars: 900,
    maxResults: 4,
    maxChars: 2400,
    stateDir: "state/custom-native-knowledge",
    openclawWorkspace: undefined,
    obsidianVaults: [
      {
        id: "personal",
        rootDir: "/vaults/personal",
        includeGlobs: ["**/*.md", "Projects/**/*.md"],
        excludeGlobs: [".obsidian/**", "**/*.png"],
        namespace: "shared",
        privacyClass: "private",
        folderRules: [
          { pathPrefix: "Projects/", namespace: "work", privacyClass: "team" },
        ],
        dailyNotePatterns: ["YYYY-MM-DD", "Daily/YYYY/MM/DD"],
        materializeBacklinks: true,
      },
    ],
  });
});

test("parseConfig keeps native knowledge stateDir memory-relative", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    nativeKnowledge: {
      enabled: true,
      stateDir: "/tmp/../custom//native-state",
    },
  });

  assert.equal(cfg.nativeKnowledge?.stateDir, "tmp/custom/native-state");
});

test("parseConfig sanitizes openclaw workspace adapter settings", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    nativeKnowledge: {
      enabled: true,
      openclawWorkspace: {
        enabled: true,
        bootstrapFiles: [" IDENTITY.md ", "USER.md", " "],
        handoffGlobs: ["handoffs/**/*.md", " "],
        dailySummaryGlobs: ["summaries/daily/**/*.md", ""],
        automationNoteGlobs: ["automation/**/*.md", " "],
        workspaceDocGlobs: ["docs/**/*.md", " "],
        excludeGlobs: ["node_modules/**", ""],
        sharedSafeGlobs: ["shared/**/*.md", " "],
      },
    },
  });

  assert.deepEqual(cfg.nativeKnowledge?.openclawWorkspace, {
    enabled: true,
    bootstrapFiles: ["IDENTITY.md", "USER.md"],
    handoffGlobs: ["handoffs/**/*.md"],
    dailySummaryGlobs: ["summaries/daily/**/*.md"],
    automationNoteGlobs: ["automation/**/*.md"],
    workspaceDocGlobs: ["docs/**/*.md"],
    excludeGlobs: [
      ".git/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "**/*.log",
      "**/.env*",
      "**/*.pem",
      "**/*.key",
    ],
    sharedSafeGlobs: ["shared/**/*.md"],
  });
});
