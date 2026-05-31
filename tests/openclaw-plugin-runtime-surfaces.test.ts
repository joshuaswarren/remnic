import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const semver = require("semver") as {
  satisfies(version: string, range: string): boolean;
};
const ROOT = path.resolve(__dirname, "..");
const REQUIRED_RUNTIME_SURFACE_KEYS = [
  "openclawToolsEnabled",
  "openclawToolSnippetMaxChars",
  "sessionTogglesEnabled",
  "initGateTimeoutMs",
  "verboseRecallVisibility",
  "recallTranscriptsEnabled",
  "recallTranscriptRetentionDays",
  "respectBundledActiveMemoryToggle",
  "activeRecallEnabled",
  "activeRecallAgents",
  "activeRecallAllowedChatTypes",
  "activeRecallQueryMode",
  "activeRecallPromptStyle",
  "activeRecallCustomInstruction",
  "activeRecallPromptAppend",
  "activeRecallMaxSummaryChars",
  "activeRecallRecentUserTurns",
  "activeRecallRecentAssistantTurns",
  "activeRecallRecentUserChars",
  "activeRecallRecentAssistantChars",
  "activeRecallThinking",
  "activeRecallTimeoutMs",
  "activeRecallCacheTtlMs",
  "activeRecallModel",
  "activeRecallModelFallbackPolicy",
  "activeRecallPersistTranscripts",
  "activeRecallTranscriptDir",
  "activeRecallEntityGraphDepth",
  "activeRecallIncludeCausalTrajectories",
  "activeRecallIncludeDaySummary",
  "activeRecallAttachRecallExplain",
  "activeRecallAllowChainedActiveMemory",
];
const OPENCLAW_MANIFEST_PATHS = [
  "openclaw.plugin.json",
  "packages/plugin-openclaw/openclaw.plugin.json",
  "packages/shim-openclaw-engram/openclaw.plugin.json",
];
// May 31, 2026 rolling 60-day policy floor: April 1, 2026 / OpenClaw 2026.4.1.
const OPENCLAW_SUPPORT_FLOOR_RANGE = [
  ">=2026.4.1",
  "2026.4.7-1",
  "2026.4.9-beta.1",
  "2026.4.11-beta.1",
  "2026.4.12-beta.1",
  "2026.4.14-beta.1",
  "2026.4.15-beta.1",
  "2026.4.15-beta.2",
  "2026.4.19-beta.1",
  "2026.4.19-beta.2",
  "2026.4.20-beta.1",
  "2026.4.20-beta.2",
  "2026.4.22-beta.1",
  "2026.4.23-beta.1",
  "2026.4.23-beta.2",
  "2026.4.23-beta.3",
  "2026.4.23-beta.4",
  "2026.4.23-beta.5",
  "2026.4.23-beta.6",
  "2026.4.24-beta.1",
  "2026.4.24-beta.2",
  "2026.4.24-beta.3",
  "2026.4.24-beta.4",
  "2026.4.24-beta.5",
  "2026.4.24-beta.6",
  "2026.4.25-beta.1",
  "2026.4.25-beta.2",
  "2026.4.25-beta.3",
  "2026.4.25-beta.4",
  "2026.4.25-beta.5",
  "2026.4.25-beta.6",
  "2026.4.25-beta.7",
  "2026.4.25-beta.8",
  "2026.4.25-beta.9",
  "2026.4.25-beta.10",
  "2026.4.25-beta.11",
  "2026.4.26-beta.1",
  "2026.4.27-beta.1",
  "2026.4.29-beta.1",
  "2026.4.29-beta.2",
  "2026.4.29-beta.3",
  "2026.4.29-beta.4",
  "2026.4.30-beta.1",
  "2026.5.2-beta.1",
  "2026.5.2-beta.2",
  "2026.5.2-beta.3",
  "2026.5.3-1",
  "2026.5.3-beta.1",
  "2026.5.3-beta.2",
  "2026.5.3-beta.3",
  "2026.5.3-beta.4",
  "2026.5.4-beta.1",
  "2026.5.4-beta.2",
  "2026.5.4-beta.3",
  "2026.5.5-beta.1",
  "2026.5.5-beta.2",
  "2026.5.6-beta.1",
  "2026.5.7-beta.1",
  "2026.5.9-beta.1",
  "2026.5.10-beta.1",
  "2026.5.10-beta.2",
  "2026.5.10-beta.3",
  "2026.5.10-beta.4",
  "2026.5.10-beta.5",
  "2026.5.10-beta.6",
  "2026.5.12-beta.1",
  "2026.5.12-beta.2",
  "2026.5.12-beta.3",
  "2026.5.12-beta.4",
  "2026.5.12-beta.5",
  "2026.5.12-beta.6",
  "2026.5.12-beta.7",
  "2026.5.12-beta.8",
  "2026.5.14-beta.1",
  "2026.5.14-beta.2",
  "2026.5.16-beta.1",
  "2026.5.16-beta.2",
  "2026.5.16-beta.3",
  "2026.5.16-beta.4",
  "2026.5.16-beta.5",
  "2026.5.16-beta.6",
  "2026.5.16-beta.7",
  "2026.5.18-beta.1",
  "2026.5.19-alpha.1",
  "2026.5.19-beta.1",
  "2026.5.19-beta.2",
  "2026.5.20-beta.1",
  "2026.5.20-beta.2",
  "2026.5.21-alpha.1",
  "2026.5.21-beta.1",
  "2026.5.22-beta.1",
  "2026.5.23-alpha.1",
  "2026.5.24-alpha.1",
  "2026.5.24-beta.1",
  "2026.5.24-beta.2",
  "2026.5.25-alpha.1",
  "2026.5.25-alpha.2",
  "2026.5.25-beta.1",
  "2026.5.26-beta.1",
  "2026.5.26-beta.2",
  "2026.5.27-alpha.1",
  "2026.5.27-beta.1",
  "2026.5.28-alpha.1",
  "2026.5.28-beta.1",
  "2026.5.28-beta.2",
  "2026.5.28-beta.3",
  "2026.5.28-beta.4",
  "2026.5.29-alpha.1",
  "2026.5.30-beta.1",
  "2026.5.30-beta.2",
  "2026.5.31-alpha.1",
  "2026.5.31-beta.1",
  "2026.5.31-beta.2",
].join(" || ");
const OPENCLAW_MIN_HOST_VERSION_FLOOR = ">=2026.4.1";
const OPENCLAW_PACKAGE_EXPECTATIONS = [
  {
    packageJsonPath: "packages/plugin-openclaw/package.json",
    name: "@remnic/plugin-openclaw",
    buildVersion: "2026.5.31-beta.2",
    install: {
      clawhubSpec: "clawhub:@remnic/plugin-openclaw",
      npmSpec: "@remnic/plugin-openclaw",
    },
  },
  {
    packageJsonPath: "packages/shim-openclaw-engram/package.json",
    name: "@joshuaswarren/openclaw-engram",
    buildVersion: "2026.5.31-beta.2",
    install: {
      clawhubSpec: "clawhub:@remnic/plugin-openclaw",
      npmSpec: "@joshuaswarren/openclaw-engram",
    },
  },
];
const TOOL_SOURCE_PATHS = [
  "src/tools.ts",
  "packages/plugin-openclaw/src/openclaw-tools/memory-search-tool.ts",
  "packages/plugin-openclaw/src/openclaw-tools/memory-get-tool.ts",
  "packages/remnic-core/src/lcm/tools.ts",
];

function readManifest(relativePath: string): Record<string, any> {
  const raw = fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
  return JSON.parse(raw) as Record<string, any>;
}

function readRootPackageJson(): Record<string, any> {
  const raw = fs.readFileSync(path.join(ROOT, "package.json"), "utf-8");
  return JSON.parse(raw) as Record<string, any>;
}

function readPackageJson(relativePath: string): Record<string, any> {
  const raw = fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
  return JSON.parse(raw) as Record<string, any>;
}

function readSourceToolNames(): string[] {
  const names = new Set<string>();
  for (const relativePath of TOOL_SOURCE_PATHS) {
    const raw = fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
    for (const match of raw.matchAll(/name:\s*"([a-zA-Z0-9_-]+)"/g)) {
      names.add(match[1]);
    }
    for (const match of raw.matchAll(
      /registerAliasedTool\(\s*api,\s*"([a-zA-Z0-9_-]+)"/g,
    )) {
      const name = match[1];
      names.add(name);
      if (name.startsWith("engram_")) {
        names.add(`remnic_${name.slice("engram_".length)}`);
      }
    }
  }
  return [...names].sort();
}

for (const manifestPath of OPENCLAW_MANIFEST_PATHS) {
  test(`${manifestPath} keeps model defaults aligned with runtime config defaults`, () => {
    const manifest = readManifest(manifestPath);
    const configSchema = manifest.configSchema?.properties ?? {};

    assert.equal(configSchema.model?.default, "gpt-5.5");
    assert.equal(configSchema.recallPlannerModel?.default, "gpt-5.5");
  });

  test(`${manifestPath} keeps memory-slot compatibility metadata for older OpenClaw hosts`, () => {
    const manifest = readManifest(manifestPath);

    assert.equal(manifest.kind, "memory");
    assert.deepEqual(manifest.supports, {
      memorySlot: true,
      dreamingSlot: true,
      activeMemory: true,
      heartbeat: true,
      commandsList: true,
      beforeReset: true,
    });
    assert.equal("securityDisclosure" in manifest, false);
  });

  test(`${manifestPath} declares the OpenClaw 2026.5 tool contract`, () => {
    const manifest = readManifest(manifestPath);
    const declaredTools = [...(manifest.contracts?.tools ?? [])].sort();

    assert.deepEqual(
      declaredTools,
      readSourceToolNames(),
      "OpenClaw 2026.5 rejects plugin tools not declared in openclaw.plugin.json#contracts.tools",
    );
  });

  test(`${manifestPath} keeps runtime declarations on supported manifest surfaces`, () => {
    const manifest = readManifest(manifestPath);

    assert.deepEqual(manifest.commandAliases, [
      {
        name: "remnic",
        kind: "runtime-slash",
        cliCommand: "remnic",
      },
    ]);
    assert.deepEqual(manifest.activation, {
      onStartup: false,
      onCommands: ["remnic"],
      onCapabilities: ["tool", "hook"],
    });
    for (const deprecatedKey of [
      "commands",
      "hooks",
      "memoryCapabilities",
      "memoryPromptSections",
      "services",
    ]) {
      assert.equal(
        deprecatedKey in (manifest.contracts ?? {}),
        false,
        `${deprecatedKey} is no longer part of OpenClaw PluginManifestContracts`,
      );
    }
  });

  test(`${manifestPath} declares plugin-mode auth metadata without provider setup ownership`, () => {
    const manifest = readManifest(manifestPath);
    const packageJsonPath = manifestPath === "packages/shim-openclaw-engram/openclaw.plugin.json"
      ? "packages/shim-openclaw-engram/package.json"
      : "packages/plugin-openclaw/package.json";
    const packageJson = readPackageJson(packageJsonPath);

    assert.equal(manifest.name, "Remnic OpenClaw Plugin");
    assert.equal(manifest.version, packageJson.version);
    assert.deepEqual(
      manifest.setup,
      {
        providers: [
          {
            id: "openai",
            authMethods: ["api-key"],
            envVars: ["OPENAI_API_KEY"],
          },
        ],
        requiresRuntime: false,
      },
    );
    assert.equal(
      "providerAuthEnvVars" in manifest,
      true,
      "providerAuthEnvVars remains for older OpenClaw auth probes and must be mirrored by setup.providers[].envVars",
    );
    assert.deepEqual(
      manifest.providerAuthEnvVars,
      {
        openai: ["OPENAI_API_KEY"],
      },
    );
    const expectedAuthChoice = manifest.id === "openclaw-engram"
      ? {
          provider: "openai",
          method: "api-key",
          choiceId: "remnic-openai-api-key",
          choiceLabel: "OpenAI API key for Remnic memory extraction",
          choiceHint:
            "Remnic sends memory extraction, consolidation, and embedding requests to OpenAI or the configured OpenAI-compatible endpoint unless you route those tasks through OpenClaw gateway/local LLM settings.",
          groupId: "remnic-memory",
          groupLabel: "Remnic memory",
          optionKey: "openaiApiKey",
          cliFlag: "--openai-api-key",
          cliOption: "--openai-api-key <key>",
          cliDescription:
            "OpenAI API key used by Remnic memory extraction, consolidation, and embedding flows.",
          onboardingScopes: ["text-inference"],
        }
      : {
          provider: "openai",
          method: "api-key",
          choiceId: "remnic-openai-api-key",
          choiceLabel: "Optional OpenAI API key for Remnic plugin-mode extraction",
          choiceHint:
            "Not needed when Remnic uses the OpenClaw gateway model source. Set only if you intentionally use plugin mode with OpenAI or an OpenAI-compatible endpoint.",
          groupId: "remnic-memory",
          groupLabel: "Remnic memory",
          optionKey: "openaiApiKey",
          cliFlag: "--openai-api-key",
          cliOption: "--openai-api-key <key>",
          cliDescription:
            "Optional OpenAI API key used by Remnic plugin-mode extraction, consolidation, and embedding flows.",
          onboardingScopes: ["text-inference"],
        };
    assert.deepEqual(manifest.providerAuthChoices, [
      expectedAuthChoice,
    ]);
    assert.match(
      manifest.configSchema?.properties?.openaiApiKey?.description ?? "",
      /conversation and memory content/,
      "openaiApiKey schema should disclose that configured model providers may process memory content",
    );
    assert.deepEqual(
      manifest.configSchema?.properties?.openaiApiKey?.anyOf,
      [{ type: "string" }, { const: false }],
      "openaiApiKey schema must accept strings or false, but reject boolean true",
    );
  });

  test(`${manifestPath} accepts slot, reset, and codex compatibility config blocks`, () => {
    const manifest = readManifest(manifestPath);
    const properties = manifest.configSchema?.properties ?? {};

    assert.ok(properties.dreaming, "dreaming config block should exist");
    assert.deepEqual(
      Object.keys(properties.dreaming.properties ?? {}).sort(),
      [
        "enabled",
        "injectRecentCount",
        "journalPath",
        "maxEntries",
        "minIntervalMinutes",
        "narrativeModel",
        "narrativePromptStyle",
        "watchFile",
      ],
    );
    assert.ok(properties.heartbeat, "heartbeat config block should exist");
    assert.deepEqual(
      Object.keys(properties.heartbeat.properties ?? {}).sort(),
      [
        "detectionMode",
        "enabled",
        "gateExtractionDuringHeartbeat",
        "journalPath",
        "maxPreviousRuns",
        "watchFile",
      ],
    );

    assert.ok(properties.slotBehavior, "slotBehavior config block should exist");
    assert.deepEqual(
      Object.keys(properties.slotBehavior.properties ?? {}).sort(),
      ["onSlotMismatch", "requireExclusiveMemorySlot"],
    );

    assert.equal(properties.beforeResetTimeoutMs?.default, 2000);
    assert.equal(properties.initGateTimeoutMs?.default, 30000);
    assert.equal(properties.flushOnResetEnabled?.default, true);
    assert.equal(properties.commandsListEnabled?.default, true);
    assert.deepEqual(
      REQUIRED_RUNTIME_SURFACE_KEYS.filter((key) => !(key in properties)),
      [],
      "runtime-surface manifest must advertise every parser-supported OpenClaw config key",
    );
    assert.deepEqual(
      properties.activeRecallQueryMode?.enum,
      ["recent", "message", "full"],
    );
    assert.deepEqual(
      properties.activeRecallPromptStyle?.enum,
      [
        "balanced",
        "strict",
        "contextual",
        "recall-heavy",
        "precision-heavy",
        "preference-only",
      ],
    );
    assert.deepEqual(
      properties.activeRecallThinking?.enum,
      ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"],
    );
    assert.equal(properties.activeRecallCacheTtlMs?.minimum, 0);
    assert.equal(properties.activeRecallCacheTtlMs?.default, 15000);

    assert.ok(properties.codexCompat, "codexCompat config block should exist");
    assert.deepEqual(
      Object.keys(properties.codexCompat.properties ?? {}).sort(),
      ["compactionFlushMode", "enabled", "fingerprintDedup", "threadIdBufferKeying"],
    );
    assert.ok(properties.codex, "legacy Codex connector config block should remain available");
    assert.deepEqual(
      Object.keys(properties.codex.properties ?? {}).sort(),
      ["codexHome", "installExtension"],
    );
    assert.deepEqual(properties.codex.properties?.codexHome?.type, ["string", "null"]);
    assert.equal(properties.codex.properties?.codexHome?.default, null);
    assert.equal(properties.codexMaterializeMemories?.default, true);
    assert.equal(properties.codexMaterializeNamespace?.default, "auto");
    assert.equal(properties.codexMaterializeMaxSummaryTokens?.default, 4500);
    assert.equal(properties.codexMaterializeMaxSummaryTokens?.minimum, 0);
    assert.equal(properties.codexMaterializeRolloutRetentionDays?.default, 30);
    assert.equal(properties.codexMaterializeRolloutRetentionDays?.minimum, 0);
    assert.equal(properties.codexMaterializeOnConsolidation?.default, true);
    assert.equal(properties.codexMaterializeOnSessionEnd?.default, true);
    assert.equal(properties.inlineSourceAttributionEnabled?.default, false);
    assert.equal(
      properties.inlineSourceAttributionFormat?.default,
      "[Source: agent={agent}, session={sessionId}, ts={ts}]",
    );

    const maxEntries = properties.dreaming.properties?.maxEntries;
    assert.ok(
      Array.isArray(maxEntries?.anyOf),
      "dreaming.maxEntries should use an explicit 0-or-10+ schema",
    );
    assert.deepEqual(
      maxEntries.anyOf,
      [
        { type: "integer", const: 0 },
        { type: "integer", minimum: 10, maximum: 10000 },
      ],
      "dreaming.maxEntries must allow the runtime disable switch without advertising unsupported 1..9 values",
    );

    const entitySynthesisMaxTokens = properties.entitySynthesisMaxTokens;
    assert.ok(
      Array.isArray(entitySynthesisMaxTokens?.anyOf),
      "entitySynthesisMaxTokens should use an explicit 0-or-10+ schema",
    );
    assert.deepEqual(
      entitySynthesisMaxTokens.anyOf,
      [
        { type: "integer", const: 0 },
        { type: "integer", minimum: 10 },
      ],
      "entitySynthesisMaxTokens must keep 0 as a disable switch without advertising unusable 1..9 values",
    );
    assert.equal(entitySynthesisMaxTokens?.default, 500);

    const briefing = properties.briefing;
    assert.ok(briefing, "briefing config block should exist");
    assert.equal(
      briefing.additionalProperties,
      false,
      "briefing config block must reject unknown keys to prevent silent typo acceptance",
    );
    assert.deepEqual(
      Object.keys(briefing.properties ?? {}).sort(),
      [
        "calendarSource",
        "defaultFormat",
        "defaultWindow",
        "enabled",
        "llmFollowups",
        "maxFollowups",
        "saveByDefault",
        "saveDir",
      ],
    );
    assert.deepEqual(briefing.properties?.defaultFormat?.enum, ["markdown", "json"]);
    assert.equal(briefing.properties?.maxFollowups?.minimum, 0);
    assert.equal(briefing.properties?.maxFollowups?.maximum, 10);
    assert.deepEqual(briefing.properties?.calendarSource?.type, ["string", "null"]);
    assert.deepEqual(briefing.properties?.saveDir?.type, ["string", "null"]);
  });
}

for (const expectation of OPENCLAW_PACKAGE_EXPECTATIONS) {
  test(`${expectation.name} declares expected OpenClaw package install metadata`, () => {
    const packageJson = readPackageJson(expectation.packageJsonPath);
    const openclaw = packageJson.openclaw ?? {};

    assert.equal(packageJson.name, expectation.name);
    assert.deepEqual(openclaw.extensions, ["./dist/index.js"]);
    assert.deepEqual(
      openclaw.runtimeExtensions,
      ["./dist/index.js"],
      "OpenClaw 2026.5.12+ package discovery should have an explicit built runtime entrypoint",
    );
    assert.deepEqual(openclaw.compat, {
      pluginApi: OPENCLAW_SUPPORT_FLOOR_RANGE,
    });
    assert.deepEqual(openclaw.build, {
      openclawVersion: expectation.buildVersion,
      pluginSdkVersion: expectation.buildVersion,
    });
    assert.deepEqual(openclaw.install, {
      ...expectation.install,
      defaultChoice: "clawhub",
      minHostVersion: OPENCLAW_MIN_HOST_VERSION_FLOOR,
    });
    assert.equal(
      packageJson.peerDependencies?.openclaw,
      OPENCLAW_SUPPORT_FLOOR_RANGE,
    );
  });
}

test("OpenClaw support range accepts the stable floor and reviewed prerelease hosts", () => {
  for (const version of [
    "2026.4.1",
    "2026.4.9-beta.1",
    "2026.5.30-beta.1",
    "2026.5.31-alpha.1",
    "2026.5.31-beta.1",
    "2026.5.31-beta.2",
  ]) {
    assert.equal(
      semver.satisfies(version, OPENCLAW_SUPPORT_FLOOR_RANGE),
      true,
      `${version} must satisfy the default semver support range`,
    );
  }
});

test("root and package OpenClaw manifests stay byte-identical", () => {
  const root = JSON.stringify(readManifest("openclaw.plugin.json"));
  const packaged = JSON.stringify(
    readManifest("packages/plugin-openclaw/openclaw.plugin.json"),
  );

  assert.equal(
    root,
    packaged,
    "root openclaw.plugin.json must be synced from packages/plugin-openclaw/openclaw.plugin.json to prevent schema drift",
  );
});

test("workspace build verifies manifest sync instead of silently rewriting root state", () => {
  const pkg = readRootPackageJson();
  const scripts = pkg.scripts ?? {};

  assert.equal(
    scripts["check:openclaw-plugin-sync"],
    "node scripts/check-openclaw-plugin-sync.mjs",
  );
  assert.match(
    scripts.build ?? "",
    /\bcheck:openclaw-plugin-sync\b/,
    "build should fail on manifest drift instead of rewriting the committed root manifest",
  );
  assert.doesNotMatch(
    scripts.build ?? "",
    /\bsync:openclaw-plugin\b/,
    "build must not silently regenerate the committed root manifest",
  );
});
