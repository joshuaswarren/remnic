/**
 * Deep-recall command group (issue #2332) — extracted from cli.ts so the
 * surface file stays at its structural ceiling (same seam as
 * meetings-commands.ts). `engram deep-recall <query>` runs the budgeted
 * REFINE/EXPAND/STOP loop through EngramAccessService — the same single
 * implementation MCP and HTTP call.
 */

import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import { EngramAccessService } from "../access-service.js";

function parseMaxSteps(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`--max-steps must be a non-negative integer; got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function registerDeepRecallCommands(cmd: CliCommand, orchestrator: Orchestrator): void {
  cmd
    .command("deep-recall <query>")
    .description("Budgeted multi-hop retrieval over the anchor graph (slow, thorough; issue #2332)")
    .option("--max-steps <n>", "Policy-step ceiling (cannot exceed the configured deepRecall.maxSteps)")
    .option("--namespace <ns>", "Namespace to scope the retrieval to")
    .option("--json", "JSON output (full entries + trace)")
    .action(async (...args: unknown[]) => {
      const query = String(args[0] ?? "");
      const options = (args[args.length - 1] ?? {}) as Record<string, unknown>;
      let maxSteps: number | undefined;
      try {
        maxSteps = parseMaxSteps(options.maxSteps);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const service = new EngramAccessService(orchestrator);
      try {
        const result = await service.deepRecall({
          query,
          ...(maxSteps !== undefined ? { maxSteps } : {}),
          ...(typeof options.namespace === "string" && options.namespace.length > 0
            ? { namespace: options.namespace }
            : {}),
        });
        if (options.json === true) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.rendered);
        }
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
