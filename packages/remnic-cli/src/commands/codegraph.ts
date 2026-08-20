import fs from "node:fs";
import { Orchestrator, parseConfig, resolveRemnicConfigRecord, type PluginConfig } from "@remnic/core";
import {
  exportCodegraphOkfBundle,
  parseOkfCodegraphSymbolFilter,
} from "@remnic/core/export-okf-codegraph";
import { resolveConfigPath } from "../index.js";
import { formatConfigKeyReport, reportConfigKeys } from "../config-key-report.js";

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
    let rawConfig: Record<string, unknown> = {};
    let rawText = "";
    let config: PluginConfig;
    try {
      rawText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
      rawConfig = rawText === "" ? {} : JSON.parse(rawText);
      config = parseConfig(resolveRemnicConfigRecord(rawConfig));
    } catch (err) {
      // parseConfig error strings embed raw config values, so err.message must
      // not reach console output (CodeQL js/clear-text-logging). Neither a
      // redactor nor a shape walk is enough: both READ the sensitive
      // properties. The key report scans the raw TEXT, so no config property
      // is ever accessed here.
      console.error(
        `codegraph export-okf: failed to load config at ${configPath} (${err instanceof Error ? err.name : "unknown error"})`,
      );
      console.error(formatConfigKeyReport(reportConfigKeys(rawText)));
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
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    orchestrator?.abortDeferredInit();
    await orchestrator?.destroy();
  }
}
