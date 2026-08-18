import fs from "node:fs";
import { Orchestrator, parseConfig, resolveRemnicConfigRecord, runOkfCliCommand } from "@remnic/core";
import { resolveConfigPath } from "../index.js";

export async function runOkfBinaryCommand(rest: string[]): Promise<void> {
  const argv = rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" ? ["help"] : rest;
  let orchestrator: Orchestrator | undefined;
  try {
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    const config = parseConfig(resolveRemnicConfigRecord(raw));
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    await orchestrator.deferredReady;
    const code = await runOkfCliCommand(argv, { stdout: process.stdout, stderr: process.stderr }, {
      memoryDir: config.memoryDir,
      conformanceEnabled: config.okf.conformanceEnabled,
      sweepEnabled: config.okf.sweepEnabled,
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
