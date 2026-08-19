import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import { runOkfCliCommand } from "../okf/cli.js";
import { exportOkfBundle, parseIncludeStatus } from "../transfer/export-okf.js";

export function registerOkfCommands(cmd: CliCommand, orchestrator: Orchestrator): void {
  const okfCmd = cmd.command("okf").description("OKF v0.1 conformance (lint, sweep)");
  const forward = async (argv: string[]): Promise<void> => {
    const code = await runOkfCliCommand(argv, { stdout: process.stdout, stderr: process.stderr }, {
      memoryDir: orchestrator.config.memoryDir,
      conformanceEnabled: orchestrator.config.okf.conformanceEnabled,
      sweepEnabled: orchestrator.config.okf.sweepEnabled,
      indexFilesEnabled: orchestrator.config.okf.indexFilesEnabled,
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

export function registerExportOkfCommand(exportCmd: CliCommand, orchestrator: Orchestrator): void {
  exportCmd
    .command("okf")
    .description("Export a portable OKF v0.1 knowledge bundle")
    .requiredOption("--out <path>", "Output directory")
    .option("--namespace <ns>", "Namespace to export")
    .option("--include-status <status>", "Repeatable status allow-list (default: active)")
    .option("--include-categories <categories>", "Comma-separated category allow-list")
    .option("--exclude-tags <tags>", "Comma-separated tags to drop")
    .option("--include-profile", "Include profile.md (default off)")
    .option("--include-wearables", "Include wearable day transcripts (default off)")
    .option("--log", "Write log.md from the lifecycle ledger")
    .option("--force", "Replace a non-empty output directory")
    .action(async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as Record<string, unknown>;
      const out = options.out ? String(options.out) : "";
      if (!out) throw new Error("Missing --out");
      const includeStatus = parseIncludeStatus(options.includeStatus);
      const namespace = options.namespace ? String(options.namespace) : "";
      const result = await exportOkfBundle({
        memoryDir: orchestrator.config.memoryDir,
        namespace,
        outDir: out,
        includeStatus,
        includeCategories: options.includeCategories ? String(options.includeCategories).split(",") : undefined,
        excludeTags: options.excludeTags ? String(options.excludeTags).split(",") : undefined,
        includeProfile: options.includeProfile === true,
        includeWearables: options.includeWearables === true,
        includeLog: options.log === true,
        force: options.force === true,
      });
      if (result.plaintextWarning) {
        console.log("PLAINTEXT EXPORT: the OKF bundle is unencrypted.");
      }
      console.log(
        `OKF export: ${result.exported} concepts, ${result.excluded} excluded`,
      );
    });
}
