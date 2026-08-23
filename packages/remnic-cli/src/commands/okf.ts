import fs from "node:fs";
import { Orchestrator, parseConfig, resolveRemnicConfigRecord, runOkfCliCommand } from "@remnic/core";
import { resolveConfigPath } from "../config-path.js";

export async function runOkfBinaryCommand(rest: string[]): Promise<void> {
  const argv = rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" ? ["help"] : rest;
  let orchestrator: Orchestrator | undefined;
  try {
    // Config/bootstrap failures get a constant message: parseConfig error
    // strings can embed config values (CodeQL js/clear-text-logging), so
    // they must never reach console output.
    try {
      const configPath = resolveConfigPath();
      const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
      const config = parseConfig(resolveRemnicConfigRecord(raw));
      orchestrator = new Orchestrator(config);
      await orchestrator.initialize();
      await orchestrator.deferredReady;
    } catch {
      console.error(
        "okf: failed to load the Remnic config or start the memory engine — run `remnic doctor` and check the config file for errors",
      );
      process.exitCode = 1;
      return;
    }
    const config = orchestrator!.config;
    const code = await runOkfCliCommand(argv, { stdout: process.stdout, stderr: process.stderr }, {
      memoryDir: config.memoryDir,
      conformanceEnabled: config.okf.conformanceEnabled,
      sweepEnabled: config.okf.sweepEnabled,
      indexFilesEnabled: config.okf.indexFilesEnabled,
    });
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    orchestrator?.abortDeferredInit();
    await orchestrator?.destroy();
  }
}
