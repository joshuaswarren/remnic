/**
 * `remnic security audit-memory` — standalone-CLI wiring (issue #1955).
 *
 * The plugin-runtime path registers the same surface in `@remnic/core`'s
 * `registerCli`; this module wires the standalone `remnic` binary so the
 * documented usage works from both entrypoints.
 */

import fs from "node:fs";
import {
  Orchestrator,
  parseConfig,
  initLogger,
  resolveRemnicConfigRecord,
  runAuditMemoryCliCommand,
  formatAuditMemoryReport,
  auditScreenProfile,
} from "@remnic/core";
import { resolveConfigPath } from "./config-path.js";

export async function cmdSecurity(rest: string[]): Promise<void> {
  const action = rest[0] ?? "help";
  if (action !== "audit-memory") {
    console.error(
      "Unknown security subcommand. Usage: remnic security audit-memory [--since <iso-date>] [--quarantine] [--json]",
    );
    process.exitCode = 1;
    return;
  }
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const config = parseConfig(resolveRemnicConfigRecord(raw));
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  try {
    const sinceFlag = rest.indexOf("--since");
    if (sinceFlag >= 0 && !rest[sinceFlag + 1]) {
      console.error("--since requires a value");
      process.exitCode = 1;
      return;
    }
    const json = rest.includes("--json");
    const report = await runAuditMemoryCliCommand({
      memoryDir: config.memoryDir,
      storage: orchestrator.storage,
      since: sinceFlag >= 0 ? rest[sinceFlag + 1] : undefined,
      quarantine: rest.includes("--quarantine"),
      // Same profile the live write path screens with, and the previous
      // `default` weighting when that path screens nothing (#3078).
      profile: auditScreenProfile(config),
    });
    console.log(json ? JSON.stringify(report, null, 2) : formatAuditMemoryReport(report));
  } finally {
    orchestrator.abortDeferredInit();
  }
}
