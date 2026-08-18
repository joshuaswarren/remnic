import fs from "node:fs";
import path from "node:path";
import { Orchestrator, parseConfig, resolveRemnicConfigRecord } from "@remnic/core";
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
    const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    const config = parseConfig(resolveRemnicConfigRecord(raw));
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    await orchestrator.deferredReady;
    const memoryDir = namespace
      ? path.join(orchestrator.config.memoryDir, "namespaces", namespace)
      : orchestrator.config.memoryDir;
    const result = await exportOkfBundle({
      memoryDir,
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
