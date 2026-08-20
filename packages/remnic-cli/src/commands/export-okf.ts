import fs from "node:fs";
import { Orchestrator, parseConfig, resolveRemnicConfigRecord, type PluginConfig } from "@remnic/core";
import { exportOkfBundle, parseIncludeStatus } from "@remnic/core/export-okf";
import { resolveConfigPath } from "../index.js";
import { redactConfigForLog } from "../redact-config.js";

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
    let rawConfig: Record<string, unknown> = {};
    let config: PluginConfig;
    try {
      rawConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
      config = parseConfig(resolveRemnicConfigRecord(rawConfig));
    } catch (err) {
      // parseConfig error strings embed raw config values (unresolved ${...}
      // placeholder text from key material, JSON.stringify'd rejects), so
      // err.message must not reach console output (CodeQL js/clear-text-
      // logging). The key-redacted config keeps the diagnostic value:
      // operators still see every field except secret-named ones.
      console.error(
        `export okf: failed to load config at ${configPath} (${err instanceof Error ? err.name : "unknown error"})`,
      );
      console.error(JSON.stringify(redactConfigForLog(rawConfig), null, 2));
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
