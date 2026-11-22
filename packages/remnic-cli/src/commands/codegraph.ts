import fs from "node:fs";
import { Orchestrator, parseConfig, resolveRemnicConfigRecord, type PluginConfig } from "@remnic/core";
import {
  exportCodegraphOkfBundle,
  parseOkfCodegraphSymbolFilter,
} from "@remnic/core/export-okf-codegraph";
import { resolveConfigPath } from "../config-path.js";

function takeFlag(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export async function runCodegraphBinaryCommand(rest: string[]): Promise<void> {
  if (rest[0] === "--help" || rest[0] === "-h" || rest.length === 0) {
    console.log(
      "Usage: remnic codegraph export-okf --project <id> --out <dir> [--max-module-concepts <n>] [--symbols none|exported|all] [--force]",
    );
    return;
  }
  if (rest[0] !== "export-okf") {
    console.error("Usage: remnic codegraph export-okf --project <id> --out <dir>");
    process.exitCode = 1;
    return;
  }
  const args = rest.slice(1);
  let orchestrator: Orchestrator | undefined;
  try {
    const project = takeFlag(args, "--project");
    const out = takeFlag(args, "--out");
    if (!project) throw new Error("Missing --project");
    if (!out) throw new Error("Missing --out");
    const configPath = resolveConfigPath();
    let config: PluginConfig;
    try {
      const rawConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
      config = parseConfig(resolveRemnicConfigRecord(rawConfig));
    } catch (err) {
      console.error(`codegraph export-okf: failed to load config at ${configPath}`);
      console.error("  config values are never printed; inspect the file directly");
      process.exitCode = 1;
      return;
    }
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    await orchestrator.deferredReady;
    const maxRaw = takeFlag(args, "--max-module-concepts");
    const result = await exportCodegraphOkfBundle({
      config: orchestrator.config,
      memoryDir: orchestrator.config.memoryDir,
      projectId: project,
      outDir: out,
      force: args.includes("--force"),
      includeAdrs: !args.includes("--no-include-adrs"),
      symbols: parseOkfCodegraphSymbolFilter(takeFlag(args, "--symbols")),
      ...(maxRaw !== undefined ? { maxModuleConcepts: Number(maxRaw) } : {}),
    });
    console.log(
      `OKF codegraph export: ${result.moduleConcepts} modules, ${result.decisions} decisions` +
        (result.truncated ? " (truncated)" : ""),
    );
  } catch (_err) {
    console.error("codegraph export-okf: command failed");
    process.exitCode = 1;
  } finally {
    orchestrator?.abortDeferredInit();
    await orchestrator?.destroy();
  }
}
