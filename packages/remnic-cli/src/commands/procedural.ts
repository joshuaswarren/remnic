import fs from "node:fs";
import {
  StorageManager,
  computeProcedureStats,
  formatProcedureStatsText,
  initLogger,
  parseConfig,
  resolveRemnicConfigRecord,
  runProcedureLibraryMaintenance,
  type ProcedureLibraryMaintenanceReport,
} from "@remnic/core";
import { hasFlag, resolveFlag } from "../cli-args.js";
import { expandTilde } from "../path-utils.js";
import { resolveConfigPath } from "../config-path.js";
import { resolveMemoryDir } from "../index.js";

export async function runProceduralBinaryCommand(rest: string[]): Promise<void> {
  initLogger();
  const subcommand = rest[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`remnic procedural — Procedural memory operations (issue #567)

Usage:
  remnic procedural stats [--format json|text] [--memory-dir <path>]
  remnic procedural maintain [--apply] [--format json|text] [--memory-dir <path>]

Subcommands:
  stats                Print counts by status + recent activity + active config.
  maintain             Run library-health maintenance (issue #2370): shadow
                       report of merge / repair-flag / retire proposals.
                       --apply executes them (requires
                       procedural.maintenance.enabled in config).

Shared with:
  GET /engram/v1/procedural/stats
  MCP remnic.procedural_stats (alias engram.procedural_stats)
  MCP remnic.procedure_library_maintenance (alias engram.procedure_library_maintenance)`);
    return;
  }

  if (subcommand !== "stats" && subcommand !== "maintain") {
    console.error(
      `Unknown procedural subcommand "${subcommand}". Run \`remnic procedural --help\` for usage.`,
    );
    process.exit(1);
  }

  const args = rest.slice(1);
  const formatPresent = hasFlag(args, "--format");
  const formatRaw = resolveFlag(args, "--format");
  if (formatPresent && (formatRaw === undefined || formatRaw === null)) {
    console.error("--format requires a value. Use `--format json` or `--format text`.");
    process.exit(1);
  }
  const format = (() => {
    if (!formatPresent || formatRaw === undefined || formatRaw === null) return "text";
    const normalized = String(formatRaw).trim().toLowerCase();
    if (normalized !== "text" && normalized !== "json") {
      console.error(`Invalid --format "${formatRaw}". Allowed: text, json.`);
      process.exit(1);
    }
    return normalized;
  })();

  const memoryDirPresent = hasFlag(args, "--memory-dir");
  const memoryDirOverride = resolveFlag(args, "--memory-dir");
  if (memoryDirPresent && (memoryDirOverride === undefined || memoryDirOverride === null)) {
    console.error("--memory-dir requires a path. Omit the flag to use the resolved default.");
    process.exit(1);
  }
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const config = parseConfig(resolveRemnicConfigRecord(raw));
  const memoryDir = expandTilde(
    typeof memoryDirOverride === "string" && memoryDirOverride.length > 0
      ? memoryDirOverride
      : config.memoryDir ?? resolveMemoryDir(),
  );

  const storage = new StorageManager(memoryDir);
  if (subcommand === "maintain") {
    const report = await runProcedureLibraryMaintenance({
      memoryDir,
      storage,
      config,
      apply: hasFlag(args, "--apply"),
    });
    if (format === "json") {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    process.stdout.write(formatProcedureMaintenanceText(report));
    return;
  }
  const report = await computeProcedureStats({ storage, config });
  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatProcedureStatsText(report));
}

function formatProcedureMaintenanceText(report: ProcedureLibraryMaintenanceReport): string {
  const lines = [
    `Procedure library maintenance (schema v${report.schemaVersion}, ${report.mode})`,
    `  generated:        ${report.generatedAt}`,
    `  scanned:          ${report.scannedProcedures}`,
  ];
  if (report.skippedReason) {
    lines.push(`  skipped:          ${report.skippedReason}`);
  }
  lines.push(`  proposed:         ${report.proposed.length}`);
  lines.push(`  applied:          ${report.appliedCount}`);
  for (const action of report.proposed) {
    lines.push("");
    lines.push(`  [${action.action}] ${action.reasonCode}`);
    lines.push(`    ids:      ${action.memoryIds.join(", ")}`);
    if (action.canonicalId) {
      lines.push(`    canonical: ${action.canonicalId}`);
    }
    lines.push(`    reason:   ${action.reason}`);
    for (const ev of action.evidence) {
      lines.push(
        `    ${ev.memoryId}: mw_success=${ev.mwSuccess} mw_fail=${ev.mwFail} lastAccessed=${ev.lastAccessed ?? "(none)"}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
