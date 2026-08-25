/**
 * Recall-navigation command group (issue #1956) — extracted from cli.ts so
 * the surface file stays at its structural ceiling (same seam as
 * deep-recall-commands.ts). `remnic navigate expand|traverse <memoryId>`
 * runs through EngramAccessService.recallNavigate — the same single
 * implementation MCP and HTTP call, sharing one renderer.
 */

import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import { EngramAccessService } from "../access-service.js";

function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`--limit must be a positive integer; got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function registerRecallNavigationCommands(cmd: CliCommand, orchestrator: Orchestrator): void {
  const run = async (args: unknown[], action: "expand" | "traverse") => {
    const memoryId = String(args[0] ?? "");
    const options = (args[args.length - 1] ?? {}) as Record<string, unknown>;
    const sessionKey = typeof options.sessionKey === "string" ? options.sessionKey : "";
    if (memoryId.length === 0 || sessionKey.length === 0) {
      console.error("usage: navigate <expand|traverse> <memoryId> --session-key <key> [--namespace <ns>]");
      process.exitCode = 1;
      return;
    }
    let limit: number | undefined;
    try {
      limit = action === "traverse" ? parseLimit(options.limit) : undefined;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const service = new EngramAccessService(orchestrator);
    try {
      const result = await service.recallNavigate({
        action,
        memoryId,
        sessionKey,
        ...(action === "expand" && typeof options.disclosure === "string"
          ? { disclosure: options.disclosure as "chunk" | "section" | "raw" }
          : {}),
        ...(action === "traverse" && typeof options.relation === "string" ? { relation: options.relation } : {}),
        ...(limit !== undefined ? { limit } : {}),
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
  };

  cmd
    .command("navigate expand <memoryId>")
    .description("Re-render a served memory at deeper disclosure (issue #1956)")
    .option("--session-key <key>", "Session key whose recent recalls authorize the id (required)")
    .option("--disclosure <level>", "Target depth: section or raw (default raw)")
    .option("--namespace <ns>", "Namespace to scope the read to")
    .option("--json", "JSON output (items + budget + disclosure spend)")
    .action(async (...args: unknown[]) => run(args, "expand"));

  cmd
    .command("navigate traverse <memoryId>")
    .description("Follow typed links from a served memory; neighbors as chunk summaries (issue #1956)")
    .option("--session-key <key>", "Session key whose recent recalls authorize the id (required)")
    .option("--relation <type>", "Optional relation filter (supports, contradicts, elaborates, ...)")
    .option("--limit <n>", "Optional cap on returned neighbors")
    .option("--namespace <ns>", "Namespace to scope the read to")
    .option("--json", "JSON output (items + budget + disclosure spend)")
    .action(async (...args: unknown[]) => run(args, "traverse"));
}
