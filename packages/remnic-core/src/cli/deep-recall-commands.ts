/**
 * Deep-recall command group (issue #2332) — extracted from cli.ts so the
 * surface file stays at its structural ceiling (same seam as
 * meetings-commands.ts). `engram deep-recall <query>` runs the budgeted
 * REFINE/EXPAND/STOP loop through EngramAccessService — the same single
 * implementation MCP and HTTP call.
 *
 * Identity (issue #2915): with namespaces enabled the read path requires an
 * authenticated principal, and this standalone CLI runs without a transport
 * to authenticate one. It therefore exposes the SAME identity pattern the
 * access CLI already uses — `--principal` (the authenticated identity) or
 * `--session-key` (resolved through the configured principal mapping) — so a
 * namespace-enabled deployment is usable from the CLI instead of refusing
 * every invocation as unauthenticated.
 */

import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import { EngramAccessService } from "../access-service.js";
import { parseDeepRecallMaxSteps } from "../deep-recall-config.js";

export function registerDeepRecallCommands(cmd: CliCommand, orchestrator: Orchestrator): void {
  cmd
    .command("deep-recall <query>")
    .description("Budgeted multi-hop retrieval over the anchor graph (slow, thorough; issue #2332)")
    .option("--max-steps <n>", "Policy-step ceiling (cannot exceed the configured deepRecall.maxSteps)")
    .option("--namespace <ns>", "Namespace to scope the retrieval to")
    .option("--session-key <key>", "Session key for principal/namespace resolution (namespaces enabled)")
    .option("--principal <principal>", "Authenticated principal for namespace authorization (namespaces enabled)")
    .option("--json", "JSON output (full entries + trace)")
    .action(async (...args: unknown[]) => {
      const query = String(args[0] ?? "");
      const options = (args[args.length - 1] ?? {}) as Record<string, unknown>;
      let maxSteps: number | undefined;
      try {
        maxSteps = parseDeepRecallMaxSteps(options.maxSteps);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const sessionKey =
        typeof options.sessionKey === "string" && options.sessionKey.trim().length > 0
          ? options.sessionKey.trim()
          : undefined;
      const principal =
        typeof options.principal === "string" && options.principal.trim().length > 0
          ? options.principal.trim()
          : undefined;
      const service = new EngramAccessService(orchestrator);
      try {
        const result = await service.deepRecall({
          query,
          ...(maxSteps !== undefined ? { maxSteps } : {}),
          ...(typeof options.namespace === "string" && options.namespace.length > 0
            ? { namespace: options.namespace }
            : {}),
          ...(sessionKey !== undefined ? { sessionKey } : {}),
          ...(principal !== undefined ? { authenticatedPrincipal: principal } : {}),
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
