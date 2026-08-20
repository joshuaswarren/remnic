import fs from "node:fs";
import { Orchestrator, parseConfig, resolveRemnicConfigRecord, type PluginConfig } from "@remnic/core";
import { exportOkfBundle, parseIncludeStatus } from "@remnic/core/export-okf";
import { resolveConfigPath } from "../index.js";

function takeFlag(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export async function runExportOkfBinaryCommand(rest: string[]): Promise<void> {
  if (rest[0] === "--help" || rest[0] === "-h" || rest.length === 0) {
    console.log("Usage: remnic export okf --out <dir> [--force] [--include-profile] [--log]");
    return;
  }
  if (rest[0] !== "okf") {
    console.error("Usage: remnic export okf --out <dir>");
    process.exitCode = 1;
    return;
  }
  const args = rest.slice(1);
  let orchestrator: Orchestrator | undefined;
  try {
    const out = takeFlag(args, "--out");
    if (!out) throw new Error("Missing --out");
    const namespace = takeFlag(args, "--namespace") ?? "";
    const configPath = resolveConfigPath();
    let config: PluginConfig;
    try {
      const rawConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
      config = parseConfig(resolveRemnicConfigRecord(rawConfig));
    } catch (err) {
      // parseConfig error strings embed raw config values — an unresolved
      // ${...} placeholder is the key's own text — so err.message must not
      // reach console output (CodeQL js/clear-text-logging).
      //
      // Nothing derived from the config is logged either. Three earlier
      // attempts each failed: redacting the parsed object (taint analysis
      // cannot see through a generic redactor, and a key deny-list is only as
      // complete as its last edit), describing its shape (still reads every
      // value), and scanning the file text for key names (CodeQL treats the
      // text as sensitive once a credential is parsed out of it, and a
      // malformed file repeatedly let a value be read as a key). The only
      // amount of config-derived logging that is safe is none.
      console.error(
        `export-okf: failed to load config at ${configPath} (${err instanceof Error ? err.name : "unknown error"})`,
      );
      console.error("  config values are never printed; inspect the file directly");
      process.exitCode = 1;
      return;
    }
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    await orchestrator.deferredReady;
    const result = await exportOkfBundle({
      memoryDir: orchestrator.config.memoryDir,
      namespace,
      outDir: out,
      includeStatus: parseIncludeStatus(takeFlag(args, "--include-status")),
      includeCategories: takeFlag(args, "--include-categories")?.split(","),
      excludeTags: takeFlag(args, "--exclude-tags")?.split(","),
      includeProfile: args.includes("--include-profile"),
      includeWearables: args.includes("--include-wearables"),
      includeLog: args.includes("--log"),
      force: args.includes("--force"),
    });
    if (result.plaintextWarning) console.log("PLAINTEXT EXPORT: the OKF bundle is unencrypted.");
    console.log(`OKF export: ${result.exported} concepts, ${result.excluded} excluded`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    orchestrator?.abortDeferredInit();
    await orchestrator?.destroy();
  }
}
