import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  getQmdCommandName,
  getQmdPostInstallProbeTargets,
  parseQmdVersionOutput,
  parseQmdVersion,
  parseQmdExplain,
  resolveQmdCapabilities,
  shouldAutoUpgradeQmd,
} from "./qmd.js";

test("parseQmdVersion extracts semantic version from qmd output", () => {
  assert.deepEqual(parseQmdVersion("qmd 2.5.1 (abcdef)"), [2, 5, 1]);
  assert.deepEqual(parseQmdVersion("v2.1.0"), [2, 1, 0]);
  assert.equal(parseQmdVersion("Unknown command: doctor"), null);
});

test("parseQmdVersionOutput prefers qmd-labelled semantic version lines", () => {
  assert.equal(
    parseQmdVersionOutput("bun 1.2.0\nqmd 2.5.1 (abcdef)", ""),
    "qmd 2.5.1 (abcdef)",
  );
  assert.equal(parseQmdVersionOutput("wrapper ready", "v2.1.0"), "v2.1.0");
  assert.equal(parseQmdVersionOutput("", ""), null);
});

test("resolveQmdCapabilities gates qmd 2.5 features by installed version", () => {
  const current = resolveQmdCapabilities("qmd 2.5.1 (abcdef)");
  assert.equal(current.v2McpQueryTool, true);
  assert.equal(current.structuredSearches, true);
  assert.equal(current.chunkStrategy, true);
  assert.equal(current.doctor, true);
  assert.equal(current.versionedSkills, true);
  assert.equal(current.absoluteSnippetLines, true);
  assert.equal(current.fullQueryOutput, true);
  assert.equal(current.forceCpu, true);
  assert.equal(current.gpuBackendOverride, true);
  assert.equal(current.embedParallelism, true);
  assert.equal(current.modelEnvConsistency, true);
  assert.equal(current.scopedEmbed, true);

  const older = resolveQmdCapabilities("qmd 2.1.0 (abcdef)");
  assert.equal(older.v2McpQueryTool, true);
  assert.equal(older.structuredSearches, true);
  assert.equal(older.chunkStrategy, true);
  assert.equal(older.doctor, false);
  assert.equal(older.versionedSkills, false);
  assert.equal(older.absoluteSnippetLines, false);
  assert.equal(older.forceCpu, false);
  assert.equal(older.scopedEmbed, false);

  const v20 = resolveQmdCapabilities("qmd 2.0.0");
  assert.equal(v20.stableSdk, true);
  assert.equal(v20.unifiedSearch, true);
  assert.equal(v20.legacySkillInstall, false);

  const v201 = resolveQmdCapabilities("qmd 2.0.1");
  assert.equal(v201.legacySkillInstall, true);
});

test("shouldAutoUpgradeQmd only upgrades below Remnic supported version", () => {
  assert.equal(shouldAutoUpgradeQmd("qmd 2.1.0", "2.5.1"), true);
  assert.equal(shouldAutoUpgradeQmd("qmd 2.5.1", "2.5.1"), false);
  assert.equal(shouldAutoUpgradeQmd("qmd 2.6.0", "2.5.1"), false);
  assert.equal(shouldAutoUpgradeQmd("not installed", "2.5.1"), false);
});

test("getQmdCommandName preserves write command detection behind qmd 2.5 index prefix", () => {
  assert.equal(getQmdCommandName(["embed", "-c", "memory"]), "embed");
  assert.equal(getQmdCommandName(["--index", "remnic-prod", "embed", "-c", "memory"]), "embed");
  assert.equal(getQmdCommandName(["--index=remnic-prod", "update", "-c", "memory"]), "update");
  assert.equal(getQmdCommandName(["--version"]), "");
});

test("post-install auto-upgrade probes PATH qmd before stale fallback paths", () => {
  assert.deepEqual(getQmdPostInstallProbeTargets("qmd", "auto-path"), [
    { qmdPath: "qmd", source: "auto-path" },
  ]);
  assert.deepEqual(getQmdPostInstallProbeTargets("/Users/test/.bun/bin/qmd", "auto-fallback"), [
    { qmdPath: "qmd", source: "auto-path" },
    { qmdPath: "/Users/test/.bun/bin/qmd", source: "auto-fallback" },
  ]);
  assert.deepEqual(getQmdPostInstallProbeTargets("/custom/qmd", "configured"), [
    { qmdPath: "qmd", source: "auto-path" },
  ]);
});

test("QmdClient applies chunk strategy to normal and forced embed args", async () => {
  const { QmdClient } = await import("./qmd.js");
  const client = new QmdClient("test", 5, {
    qmdChunkStrategy: "regex",
  });
  (client as any).qmdCapabilities = resolveQmdCapabilities("qmd 2.5.1");
  assert.deepEqual((client as any).buildEmbedArgs("memory"), [
    "embed",
    "-c",
    "memory",
    "--chunk-strategy",
    "regex",
  ]);
  assert.deepEqual((client as any).buildEmbedArgs("memory", true), [
    "embed",
    "-f",
    "-c",
    "memory",
    "--chunk-strategy",
    "regex",
  ]);
});

test("parseQmdExplain preserves qmd 2.5 nested RRF trace fields", () => {
  assert.deepEqual(
    parseQmdExplain({
      ftsScores: [0.4],
      vectorScores: [0.2],
      rrf: {
        rank: 2,
        positionScore: 0.7,
        baseScore: 0.6,
        topRankBonus: 0.1,
        totalScore: 0.7,
      },
      rerankScore: 0.9,
      blendedScore: 0.82,
    }),
    {
      ftsScores: [0.4],
      vectorScores: [0.2],
      rrf: 0.7,
      rrfRank: 2,
      rrfPositionScore: 0.7,
      rrfBaseScore: 0.6,
      rrfTopRankBonus: 0.1,
      rerankScore: 0.9,
      blendedScore: 0.82,
    },
  );
});

test("QmdClient runtime env maps qmd 2.5 model and GPU controls", async () => {
  const { QmdClient } = await import("./qmd.js");
  const client = new QmdClient("test", 5, {
    qmdForceCpu: true,
    qmdGpuBackend: "metal",
    qmdEmbedParallelism: 12,
    qmdEmbedModel: "hf:embed",
    qmdRerankModel: "hf:rerank",
    qmdGenerateModel: "hf:generate",
  });
  assert.deepEqual((client as any).qmdRuntimeEnv, {
    QMD_FORCE_CPU: "1",
    QMD_LLAMA_GPU: "metal",
    QMD_EMBED_PARALLELISM: "8",
    QMD_EMBED_MODEL: "hf:embed",
    QMD_RERANK_MODEL: "hf:rerank",
    QMD_GENERATE_MODEL: "hf:generate",
  });
});

test("QmdClient auto-upgrade throttle key is scoped by qmd target", async () => {
  const { QmdClient } = await import("./qmd.js");
  const base = new QmdClient("test", 5, {
    qmdAutoUpgradeEnabled: true,
    qmdIndexName: "default",
    qmdEmbedModel: "hf:embed-a",
  });
  const otherIndex = new QmdClient("test", 5, {
    qmdAutoUpgradeEnabled: true,
    qmdIndexName: "other",
    qmdEmbedModel: "hf:embed-a",
  });
  const otherRuntime = new QmdClient("test", 5, {
    qmdAutoUpgradeEnabled: true,
    qmdIndexName: "default",
    qmdEmbedModel: "hf:embed-b",
  });

  assert.notEqual((base as any).autoUpgradeTargetKey(), (otherIndex as any).autoUpgradeTargetKey());
  assert.notEqual((base as any).autoUpgradeTargetKey(), (otherRuntime as any).autoUpgradeTargetKey());
});

test("parseConfig exposes qmd 2.5 integration defaults and opt-in auto upgrade", () => {
  const defaults = parseConfig({});
  assert.equal(defaults.qmdSupportedVersion, "2.5.1");
  assert.equal(defaults.qmdAutoUpgradeEnabled, false);
  assert.equal(defaults.qmdChunkStrategy, "auto");
  assert.equal(defaults.qmdQueryRerankEnabled, true);
  assert.equal(defaults.qmdCandidateLimit, undefined);
  assert.equal(defaults.qmdIndexName, undefined);

  const configured = parseConfig({
    qmdAutoUpgradeEnabled: "true",
    qmdAutoUpgradeCheckIntervalMs: "60000",
    qmdChunkStrategy: "regex",
    qmdCandidateLimit: "25",
    qmdQueryRerankEnabled: "false",
    qmdIndexName: "remnic-prod",
    qmdForceCpu: "true",
    qmdGpuBackend: "metal",
    qmdEmbedParallelism: "4",
    qmdEmbedModel: "hf:custom/embed.gguf",
    qmdRerankModel: "hf:custom/rerank.gguf",
    qmdGenerateModel: "hf:custom/generate.gguf",
  });
  assert.equal(configured.qmdAutoUpgradeEnabled, true);
  assert.equal(configured.qmdAutoUpgradeCheckIntervalMs, 60_000);
  assert.equal(configured.qmdChunkStrategy, "regex");
  assert.equal(configured.qmdCandidateLimit, 25);
  assert.equal(configured.qmdQueryRerankEnabled, false);
  assert.equal(configured.qmdIndexName, "remnic-prod");
  assert.equal(configured.qmdForceCpu, true);
  assert.equal(configured.qmdGpuBackend, "metal");
  assert.equal(configured.qmdEmbedParallelism, 4);
  assert.equal(configured.qmdEmbedModel, "hf:custom/embed.gguf");
  assert.equal(configured.qmdRerankModel, "hf:custom/rerank.gguf");
  assert.equal(configured.qmdGenerateModel, "hf:custom/generate.gguf");

  const falseGpuBackend = parseConfig({ qmdGpuBackend: false });
  assert.equal(falseGpuBackend.qmdGpuBackend, "false");
});

test("parseConfig rejects invalid qmd version and integer config values", () => {
  assert.throws(
    () => parseConfig({ qmdSupportedVersion: "latest" }),
    /qmdSupportedVersion must be a semantic version string/,
  );
  assert.throws(
    () => parseConfig({ qmdSupportedVersion: "2.6" }),
    /qmdSupportedVersion must be a semantic version string/,
  );
  assert.throws(
    () => parseConfig({ qmdCandidateLimit: "1.9" }),
    /qmdCandidateLimit must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ qmdEmbedParallelism: 0.5 }),
    /qmdEmbedParallelism must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ qmdChunkStrategy: "regx" }),
    /qmdChunkStrategy must be "auto" or "regex"/,
  );
  assert.throws(
    () => parseConfig({ qmdChunkStrategy: false }),
    /qmdChunkStrategy must be "auto" or "regex"/,
  );
  assert.throws(
    () => parseConfig({ qmdGpuBackend: "opengl" }),
    /qmdGpuBackend must be one of/,
  );
  assert.throws(
    () => parseConfig({ qmdGpuBackend: true }),
    /qmdGpuBackend must be one of/,
  );
});
