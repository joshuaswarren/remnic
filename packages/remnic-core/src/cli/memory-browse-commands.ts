/**
 * Memory-store browse command group (issue #2978) — extracted from cli.ts
 * so the surface file stays at its structural ceiling (same seam as
 * cli/recall-navigation-commands.ts). `remnic browse ls|tree|find` runs
 * through EngramAccessService.memoryStoreBrowse — the same single
 * implementation MCP and HTTP call, sharing one renderer.
 */

import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import { EngramAccessService } from "../access-service.js";
import type { BrowseVerb } from "../memory-browse.js";

export function registerMemoryBrowseCommands(cmd: CliCommand, orchestrator: Orchestrator): void {
  const run = async (args: unknown[], verb: BrowseVerb) => {
    const options = (args[args.length - 1] ?? {}) as Record<string, unknown>;
    // `browse find <pattern>` takes the pattern as a positional arg; the
    // options object sits at the END of commander's action args.
    const pattern = typeof args[0] === "string" && args[0].length > 0
      ? args[0]
      : typeof options.pattern === "string"
        ? options.pattern
        : "";
    if (verb === "find" && pattern.trim().length === 0) {
      console.error("usage: browse <ls|tree|find> [path] [--pattern <glob>] [--depth <n>] [--namespace <ns>] [--json]");
      process.exitCode = 1;
      return;
    }
    const depth = verb === "tree" && options.depth !== undefined ? Number(options.depth) : undefined;
    if (depth !== undefined && (!Number.isFinite(depth) || !Number.isInteger(depth) || depth < 1 || depth > 4)) {
      console.error("--depth must be an integer between 1 and 4");
      process.exitCode = 1;
      return;
    }
    const service = new EngramAccessService(orchestrator);
    try {
      const result = await service.memoryStoreBrowse({
        verb,
        ...(typeof args[0] === "string" && args[0].length > 0 ? { path: args[0] } : {}),
        ...(depth !== undefined ? { depth } : {}),
        ...(verb === "find" ? { pattern } : {}),
        ...(typeof options.namespace === "string" && options.namespace.length > 0 ? { namespace: options.namespace } : {}),
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
    .command("browse ls [path]")
    .description("List children of a store path in your namespace (issue #2978)")
    .option("--namespace <ns>", "Namespace to scope the browse to")
    .option("--json", "JSON output (entries + counts + truncated flag)")
    .action(async (...args: unknown[]) => run(args, "ls"));

  cmd
    .command("browse tree [path]")
    .description("Depth-limited store tree under one path (issue #2978)")
    .option("--depth <n>", "Expansion depth, 1-4 (default 1)")
    .option("--namespace <ns>", "Namespace to scope the browse to")
    .option("--json", "JSON output (entries + counts + truncated flag)")
    .action(async (...args: unknown[]) => run(args, "tree"));

  cmd
    .command("browse find <pattern>")
    .description("Deterministic name/path glob or substring lookup (issue #2978)")
    .option("--namespace <ns>", "Namespace to scope the browse to")
    .option("--json", "JSON output (entries + counts + truncated flag)")
    .action(async (...args: unknown[]) => run(args, "find"));
}
