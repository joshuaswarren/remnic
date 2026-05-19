/**
 * Tests for `remnic openclaw install` CLI command structure.
 *
 * Since the CLI package depends on @remnic/core (which requires a build step),
 * these tests verify the CLI source code structure directly.
 *
 * Tests:
 * - CLI source declares the "openclaw" command type
 * - install subcommand handler is defined
 * - --yes / -y / --force flags are handled
 * - --dry-run flag is handled
 * - --memory-dir flag is handled
 * - --config flag is handled
 * - legacy migration detection is implemented
 * - openclaw command is registered in the main switch
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI_SRC = path.join(ROOT, "packages", "remnic-cli", "src", "index.ts");
const OPTIONAL_BENCH_SRC = path.join(
  ROOT,
  "packages",
  "remnic-cli",
  "src",
  "optional-bench.ts",
);
const OPTIONAL_WECLONE_SRC = path.join(
  ROOT,
  "packages",
  "remnic-cli",
  "src",
  "optional-weclone-export.ts",
);

async function readCli(): Promise<string> {
  return readFile(CLI_SRC, "utf-8");
}

async function readOptionalBench(): Promise<string> {
  return readFile(OPTIONAL_BENCH_SRC, "utf-8");
}

async function readOptionalWeclone(): Promise<string> {
  return readFile(OPTIONAL_WECLONE_SRC, "utf-8");
}

test("CLI CommandName type includes 'openclaw'", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('"openclaw"'),
    "CommandName type must include 'openclaw'",
  );
});

test("CLI has cmdOpenclawInstall function", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("cmdOpenclawInstall"),
    "CLI must define cmdOpenclawInstall function",
  );
});

test("CLI has cmdOpenclawUpgrade function", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("cmdOpenclawUpgrade"),
    "CLI must define cmdOpenclawUpgrade function",
  );
});

test("CLI has cmdOpenclawMigrateEngram function", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("cmdOpenclawMigrateEngram"),
    "CLI must define explicit legacy Engram migration tooling",
  );
});

test("CLI --yes / -y / --force flags are supported", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('--yes') && src.includes('"-y"') || src.includes("--yes") && src.includes("-y"),
    "CLI must handle --yes flag",
  );
  assert.ok(src.includes("--force"), "CLI must handle --force flag");
});

test("CLI --dry-run flag is supported", async () => {
  const src = await readCli();
  assert.ok(src.includes("--dry-run"), "CLI must handle --dry-run flag");
  assert.ok(src.includes("DRY RUN"), "dry-run mode must print DRY RUN");
});

test("CLI --memory-dir flag is supported", async () => {
  const src = await readCli();
  assert.ok(src.includes("--memory-dir"), "CLI must handle --memory-dir flag");
});

test("CLI --config flag is supported", async () => {
  const src = await readCli();
  assert.ok(src.includes("--config"), "CLI must handle --config flag");
});

test("CLI detects legacy openclaw-engram entry", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("openclaw-engram"),
    "CLI must reference legacy openclaw-engram entry",
  );
});

test("CLI writes openclaw-remnic entry and memory slot", async () => {
  const src = await readCli();
  assert.ok(src.includes('"openclaw-remnic"'), "CLI must write openclaw-remnic entry");
  // The slot assignment may use a constant (REMNIC_OPENCLAW_PLUGIN_ID) or a literal.
  assert.ok(
    src.includes('memory: "openclaw-remnic"') ||
    src.includes("memory: \"openclaw-remnic\"") ||
    src.includes("memory: REMNIC_OPENCLAW_PLUGIN_ID"),
    "CLI must set memory slot to openclaw-remnic (literal or via REMNIC_OPENCLAW_PLUGIN_ID constant)",
  );
});

test("CLI openclaw install defaults Remnic to gateway model source", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('const defaultModelSource = !hasNew && !migrateLegacy ? "gateway" : "plugin"'),
    "OpenClaw install should prefer gateway LLM routing instead of requiring a Remnic OpenAI key",
  );
});

test("CLI openclaw install grants required conversation hook access", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("buildRemnicOpenclawHooksPolicy") &&
      src.includes("allowConversationAccess: true"),
    "OpenClaw 2026.5 requires non-bundled plugins using agent_end/llm_output hooks to set hooks.allowConversationAccess",
  );
});

test("CLI openclaw install writes config atomically", async () => {
  const src = await readCli();
  const installStart = src.indexOf("async function cmdOpenclawInstall");
  const upgradeStart = src.indexOf("async function cmdOpenclawUpgrade");
  assert.ok(installStart >= 0, "cmdOpenclawInstall must exist");
  assert.ok(upgradeStart > installStart, "cmdOpenclawUpgrade should follow cmdOpenclawInstall");
  const installBody = src.slice(installStart, upgradeStart);

  assert.ok(
    installBody.includes("atomicWriteFileSync(configPath"),
    "OpenClaw install must write openclaw.json through the atomic config writer",
  );
  assert.ok(
    !installBody.includes("writeFileSync(configPath"),
    "OpenClaw install must not write directly to the live openclaw.json path",
  );
});

test("CLI query does not wait for deferred QMD startup maintenance", async () => {
  const src = await readCli();
  const queryStart = src.indexOf("async function cmdQuery");
  const xrayStart = src.indexOf("async function cmdXray");
  assert.ok(queryStart >= 0, "cmdQuery must exist");
  assert.ok(xrayStart > queryStart, "cmdXray should follow cmdQuery in CLI source");
  const cmdQueryBody = src.slice(queryStart, xrayStart);
  assert.ok(
    !cmdQueryBody.includes("await orchestrator.deferredReady"),
    "remnic query should not block foreground recall on startup index maintenance",
  );
  assert.ok(
    cmdQueryBody.includes("orchestrator.abortDeferredInit()"),
    "remnic query should cancel its own deferred startup maintenance before exit",
  );
});

test("CLI xray waits for deferred QMD startup maintenance before diagnostic recall", async () => {
  const src = await readCli();
  const xrayStart = src.indexOf("async function cmdXray");
  const versionsStart = src.indexOf("async function cmdVersions");
  assert.ok(xrayStart >= 0, "cmdXray must exist");
  assert.ok(versionsStart > xrayStart, "cmdVersions should follow cmdXray in CLI source");
  const cmdXrayBody = src.slice(xrayStart, versionsStart);
  assert.ok(
    cmdXrayBody.includes("await orchestrator.deferredReady"),
    "remnic xray should diagnose recall after startup index maintenance refreshes disk-backed search state",
  );
  assert.ok(
    cmdXrayBody.includes("orchestrator.abortDeferredInit()"),
    "remnic xray should retain the deferred startup abort guard before exit",
  );
});

test("CLI openclaw subcommand is in the main switch statement", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('case "openclaw":'),
    "main switch must handle 'openclaw' command",
  );
});

test("CLI wires openclaw upgrade subcommand", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('subcommand === "upgrade"') ||
    src.includes("case \"upgrade\"") ||
    src.includes("cmdOpenclawUpgrade"),
    "CLI must handle `remnic openclaw upgrade`",
  );
});

test("CLI openclaw upgrade supports release and restart flags", async () => {
  const src = await readCli();
  assert.ok(src.includes("--version"), "CLI upgrade must handle --version");
  assert.ok(
    src.includes("--no-restart") || src.includes("restartGateway"),
    "CLI upgrade must handle restart control",
  );
});

test("CLI openclaw migrate-engram backs up legacy extension dir", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('subAction === "migrate-engram"'),
    "CLI must wire remnic openclaw migrate-engram",
  );
  assert.ok(
    src.includes("--legacy-plugin-dir") &&
      src.includes("legacyPluginDirForBackup") &&
      src.includes("Backed up legacy plugin dir"),
    "migrate-engram must support and report legacy extension backup",
  );
});

test("CLI openclaw upgrade rejects missing values for value-bearing flags", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('resolveRequiredValueFlag(args, "--version")'),
    "CLI upgrade must reject bare --version flags instead of defaulting",
  );
  assert.ok(
    src.includes('resolveRequiredValueFlag(args, "--plugin-dir")'),
    "CLI upgrade must reject bare --plugin-dir flags",
  );
});

test("CLI openclaw upgrade mentions backups and npm package refresh", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("backup") || src.includes("backups"),
    "CLI upgrade must mention backups",
  );
  assert.ok(
    src.includes("npm pack") || src.includes("@remnic/plugin-openclaw"),
    "CLI upgrade must mention the published npm package",
  );
});

test("CLI openclaw upgrade uses collision-resistant backup directories", async () => {
  const src = await readCli();
  const upgradeStart = src.indexOf("async function cmdOpenclawUpgrade");
  const migrateStart = src.indexOf("async function cmdOpenclawMigrateEngram");
  assert.ok(upgradeStart >= 0 && migrateStart > upgradeStart, "CLI upgrade function must be present");
  const upgradeSrc = src.slice(upgradeStart, migrateStart);
  assert.ok(
    src.includes("function createOpenclawUpgradeBackupDir"),
    "CLI upgrade must isolate backup directory creation behind a helper",
  );
  assert.ok(
    src.includes("fs.mkdtempSync(") &&
      src.includes("remnic-openclaw-upgrade-${formatOpenclawUpgradeStamp()}-"),
    "CLI upgrade backups must reserve a unique directory even for same-second retries",
  );
  assert.ok(
    src.includes("const backupDir = createOpenclawUpgradeBackupDir();"),
    "CLI upgrade must use the collision-resistant backup directory helper",
  );
  assert.ok(
    upgradeSrc.indexOf("if (opts.dryRun)") <
      upgradeSrc.indexOf("const backupDir = createOpenclawUpgradeBackupDir();"),
    "CLI upgrade must not create backup directories during dry runs",
  );
  assert.ok(
    upgradeSrc.indexOf("if (!opts.yes)") <
      upgradeSrc.indexOf("const backupDir = createOpenclawUpgradeBackupDir();"),
    "CLI upgrade must not create backup directories before confirmation",
  );
});

test("CLI openclaw upgrade rolls back if the published plugin install fails after swap", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("PublishedOpenclawPluginInstallError"),
    "CLI upgrade must track plugin install failures that happen after the staged swap",
  );
  assert.ok(
    src.includes("let installResult") &&
      src.includes("installResult = installPublishedOpenclawPlugin(packageSpec, pluginDir)"),
    "CLI upgrade must assign the published plugin install inside the rollback try/catch",
  );
  assert.ok(
    src.includes("const publishedInstallError = installError instanceof PublishedOpenclawPluginInstallError") &&
      src.includes("const rollbackDir = publishedInstallError") &&
      src.includes("? publishedInstallError.rollbackDir"),
    "CLI upgrade must reuse rollbackDir from install failures that occur before installResult is assigned",
  );
});

test("CLI openclaw upgrade preserves the original install error if rollback also fails", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("createOpenclawUpgradeRollbackFailure"),
    "CLI upgrade must construct a combined failure when rollback throws",
  );
  assert.ok(
    /try\s*\{\s*rollbackNotes = rollbackOpenclawUpgrade\(\{[\s\S]*?\}\);\s*\}\s*catch \(rollbackError\)\s*\{\s*throw createOpenclawUpgradeRollbackFailure\(\{[\s\S]*?installError,[\s\S]*?rollbackError,[\s\S]*?\}\);\s*\}/s.test(src),
    "CLI upgrade must catch rollback failures separately so the original install error is still surfaced",
  );
  assert.ok(
    src.includes("Original failure: ${installErrorText}."),
    "CLI upgrade must include the original install error text in the post-rollback failure message",
  );
  assert.ok(
    src.includes("const installErrorText = describeErrorWithCause(installError);"),
    "CLI upgrade must include wrapped install causes in the surfaced failure text",
  );
});

test("CLI openclaw upgrade skips rollback work when install fails before any swap or reconfigure", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("const shouldRestorePlugin =") &&
      src.includes("const shouldRestoreConfig = Boolean(installResult);") &&
      src.includes("const shouldRollback = shouldRestorePlugin || shouldRestoreConfig;"),
    "CLI upgrade must distinguish plugin rollback from config rollback before deciding to restore",
  );
  assert.ok(
    /if \(!shouldRollback\)\s*\{\s*throw new Error\(\s*`OpenClaw upgrade failed while \$\{failurePhase\}\. ` \+\s*`Original failure: \$\{installErrorText\}\.`/s.test(src),
    "CLI upgrade must surface the install failure directly when rollback is unnecessary",
  );
});

test("CLI openclaw upgrade preserves backup rollback for swap failures that lose rollbackDir", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("readonly shouldRestoreBackup: boolean;") &&
      src.includes("this.shouldRestoreBackup = options.shouldRestoreBackup ?? false;"),
    "published plugin install errors must carry whether durable backup rollback is still required",
  );
  assert.ok(
    src.includes("shouldRestoreBackup = swapError instanceof AggregateError;"),
    "published plugin install must remember swap+restore double failures that still need backup rollback",
  );
  assert.ok(
    src.includes("publishedInstallError?.shouldRestoreBackup"),
    "CLI upgrade rollback gating must honor the durable-backup restore signal from install failures",
  );
});

test("CLI openclaw upgrade rejects file-backed pluginDir paths before backup and swap", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("function assertDirectoryPathOrMissing"),
    "CLI upgrade must define a shared directory guard for pluginDir",
  );
  assert.ok(
    src.includes('assertDirectoryPathOrMissing(pluginDir, "OpenClaw plugin dir");'),
    "CLI upgrade must validate pluginDir before backup/install work begins",
  );
  assert.ok(
    src.includes('childProcess.execFileSync("npm", ["install", "--omit=dev"]') &&
      src.includes('assertDirectoryPathOrMissing(pluginDir, "OpenClaw plugin dir");') &&
      src.includes("const swapResult = (() => {") &&
      src.includes("return swapDirectoryWithRollback(stagedDir, pluginDir, rollbackDir);"),
    "published plugin installs must validate pluginDir immediately before the staged swap",
  );
});

test("CLI next-step instructions mention gateway restart", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("launchctl kickstart") || src.includes("gateway"),
    "CLI should include gateway restart instructions",
  );
});

test("CLI next-step instructions mention gateway_start fired log line", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("gateway_start fired") || src.includes("[remnic] gateway_start"),
    "CLI should reference the gateway_start fired log line",
  );
});

test("CLI install creates memory directory", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("mkdirSync") || src.includes("mkdir"),
    "CLI install must create the memory directory",
  );
});

test("CLI legacy migration note is included", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("legacy") || src.includes("retained") || src.includes("rollback"),
    "CLI must include a note about the legacy entry being retained for rollback",
  );
});

test("CLI preserves existing memoryDir on reinstall when --memory-dir not provided", async () => {
  const src = await readCli();
  // The CLI should use the existing configured memoryDir as fallback, not always the default.
  assert.ok(
    src.includes("existingMemoryDir") || src.includes("existingNewEntryConfig.memoryDir"),
    "CLI must preserve the existing memoryDir when --memory-dir is not provided",
  );
});

test("CLI ignores foreign slots.memory values when preserving the current OpenClaw memoryDir", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("slots.memory === REMNIC_OPENCLAW_PLUGIN_ID") &&
      src.includes("slots.memory === REMNIC_OPENCLAW_LEGACY_PLUGIN_ID"),
    "CLI must only trust recognized OpenClaw plugin ids when reading slots.memory",
  );
});

test("CLI validates plugins.entries shape before using in operator", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("rawEntries") || src.includes("plugins.entries field"),
    "CLI must validate plugins.entries shape before property access",
  );
});

test("CLI expands tilde in memoryDir paths", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("expandTilde"),
    "CLI must expand tilde (~) in memoryDir paths before path.resolve",
  );
});

test("CLI preserves slot when operator declines migration", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("slotIsActiveLegacy") || src.includes("shouldSwitchSlot"),
    "CLI must conditionally switch slot based on migration consent",
  );
});

test("CLI uses resolveFlagStrict for --memory-dir and --config to reject flag-like values", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("resolveFlagStrict"),
    "CLI must use resolveFlagStrict for value-bearing flags in openclaw install",
  );
});

test("CLI lazy-loads bench and training-export runtime packages", async () => {
  const [cliSrc, optionalBenchSrc, optionalWecloneSrc] = await Promise.all([
    readCli(),
    readOptionalBench(),
    readOptionalWeclone(),
  ]);
  assert.ok(
    cliSrc.includes("loadTrainingExportCoreRuntime") &&
      cliSrc.includes("loadWecloneExportModule"),
    "CLI must lazy-load training export runtime dependencies",
  );
  assert.ok(
    cliSrc.includes("loadBenchModule") &&
      cliSrc.includes("tryLoadBenchModule"),
    "CLI must lazy-load bench runtime dependencies",
  );
  assert.ok(
    optionalWecloneSrc.includes('const SPECIFIER = "@remnic/" + "export-weclone"') &&
      optionalWecloneSrc.includes("await import(SPECIFIER)"),
    "training export lazy loading must happen in the optional weclone loader via computed dynamic import",
  );
  assert.ok(
    optionalBenchSrc.includes('const SPECIFIER = "@remnic/" + "bench"') &&
      optionalBenchSrc.includes("await import(SPECIFIER)"),
    "bench lazy loading must happen in the optional bench loader via computed dynamic import",
  );
});
