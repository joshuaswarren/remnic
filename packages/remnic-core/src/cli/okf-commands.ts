import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import { runOkfCliCommand } from "../okf/cli.js";

export function registerOkfCommands(cmd: CliCommand, orchestrator: Orchestrator): void {
  const okfCmd = cmd.command("okf").description("OKF v0.1 conformance (lint, sweep)");
  const forward = async (argv: string[]): Promise<void> => {
    const code = await runOkfCliCommand(argv, { stdout: process.stdout, stderr: process.stderr }, {
      memoryDir: orchestrator.config.memoryDir,
      conformanceEnabled: orchestrator.config.okf.conformanceEnabled,
      sweepEnabled: orchestrator.config.okf.sweepEnabled,
    });
    if (code !== 0) process.exitCode = code;
  };
  okfCmd.command("lint").description("Report OKF conformance findings").option("--json", "JSON output").action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    await forward(["lint", ...(options.json === true ? ["--json"] : [])]);
  });
  okfCmd.command("sweep").description("Add missing type fields without bumping updated").option("--json", "JSON output").action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    await forward(["sweep", ...(options.json === true ? ["--json"] : [])]);
  });
}
