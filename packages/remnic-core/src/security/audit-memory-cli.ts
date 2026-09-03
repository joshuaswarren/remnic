/**
 * Security command group extracted from cli.ts (#1955).
 *
 * Behaviour is identical to the inline registration it replaces.
 */

import type { CliCommand } from "../cli.js";
import { runAuditMemoryCliCommand } from "../cli.js";
import type { Orchestrator } from "../orchestrator.js";
import { auditScreenProfile } from "./audit-memory.js";
import { formatAuditMemoryReport } from "./audit-memory.js";

export function registerSecurityCommands(
  cmd: CliCommand,
  orchestrator: Orchestrator,
): void {
  const securityCmd = cmd
    .command("security")
    .description("Memory security audit and hardening workflows");

  securityCmd
    .command("audit-memory")
    .description("Audit the memory store for injection signatures, write bursts, and authority escalation")
    .option("--since <date>", "Only scan memories created or updated on or after this ISO date")
    .option("--quarantine", "Move flagged active memories to pending_review")
    .option("--json", "Emit machine-readable JSON only")
    .action(async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as Record<string, unknown>;
      const report = await runAuditMemoryCliCommand({
        memoryDir: orchestrator.config.memoryDir,
        storage: orchestrator.storage,
        since: typeof options.since === "string" && options.since.trim().length > 0
          ? options.since.trim()
          : undefined,
        quarantine: options.quarantine === true,
        // Screen with the profile live ingestion uses, or a memory this
        // deployment would quarantine on write stays active once stored
        // (#3078). A deployment with the screen DISABLED keeps the previous
        // `default` weighting: the sweep must not be stricter than the
        // write path the operator configured.
        profile: auditScreenProfile(orchestrator.config),
      });
      if (options.json === true) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(formatAuditMemoryReport(report));
    });
}
