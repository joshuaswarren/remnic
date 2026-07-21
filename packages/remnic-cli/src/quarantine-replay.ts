/**
 * `remnic quarantine replay` command flow (issue #1888). Extracted from the CLI
 * entrypoint so index.ts stays under its size ratchet and the replay flow is
 * unit-testable. Sets `process.exitCode` (2 = usage/bootstrap error, 1 = any
 * re-submit or delete failure) and never throws.
 */
import * as fs from "node:fs";

import { EngramAccessService, Orchestrator, initLogger, parseConfig, resolveRemnicConfigRecord } from "@remnic/core";
import { WriteQuarantineStore } from "@remnic/core/write-quarantine.js";

import { type QuarantineFormat, renderReplayResult, replayQuarantine } from "./quarantine-cli.js";

/** Required-value flag: undefined when absent, throws when present without a value. */
function valueFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value. Provide it as \`${flag} <value>\`, not a bare flag.`);
  }
  return value;
}

export async function runQuarantineReplay(rest: string[], format: QuarantineFormat, configPath: string): Promise<void> {
  let targetNamespace: string | undefined;
  let principal: string | undefined;
  try {
    targetNamespace = valueFlag(rest, "--namespace");
    principal = valueFlag(rest, "--principal");
  } catch (err) {
    process.stderr.write(`quarantine replay: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  if (!targetNamespace || targetNamespace.trim().length === 0) {
    process.stderr.write("quarantine replay: --namespace <ns> is required.\n");
    process.exitCode = 2;
    return;
  }
  // Only --namespace/--principal (value flags) and --json (parsed upstream) are allowed.
  const valued = new Set(["--namespace", "--principal"]);
  const bad = rest.filter((a, i) => (a.startsWith("--") ? a !== "--json" && !valued.has(a) : !valued.has(rest[i - 1])));
  if (bad.length > 0) {
    process.stderr.write(
      `quarantine replay: unexpected argument(s): ${bad.join(", ")}. Use: replay --namespace <ns> [--principal <p>] [--json].\n`
    );
    process.exitCode = 2;
    return;
  }
  initLogger();
  let orchestrator: Orchestrator | undefined;
  try {
    // Bootstrap inside the boundary so bad config JSON / construction fails cleanly (exit 2).
    const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    const config = parseConfig(resolveRemnicConfigRecord(raw));
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    await orchestrator.deferredReady;
    const service = new EngramAccessService(orchestrator);
    // Open the store on the SAME resolved memoryDir the orchestrator dead-letters
    // into (config.memoryDir), so replay reads/removes the exact tree writes were
    // parked in — never a divergent resolveMemoryDir() result.
    const store = new WriteQuarantineStore(config.memoryDir);
    const result = await replayQuarantine({
      store,
      targetNamespace,
      principal,
      submit: async (operation, request) => {
        if (operation === "observe") {
          await service.observe(request as unknown as Parameters<EngramAccessService["observe"]>[0]);
        } else if (operation === "memory_store") {
          await service.memoryStore(request as unknown as Parameters<EngramAccessService["memoryStore"]>[0]);
        } else {
          await service.suggestionSubmit(request as unknown as Parameters<EngramAccessService["suggestionSubmit"]>[0]);
        }
      },
    });
    console.log(renderReplayResult(result, targetNamespace, format));
    // A failed re-submit OR a failed deletion is a non-clean outcome.
    if (result.failures.length > 0 || result.deleteFailures.length > 0) process.exitCode = 1;
  } catch {
    process.stderr.write("quarantine replay: unable to replay quarantine store\n");
    process.exitCode = 2;
  } finally {
    if (orchestrator) await orchestrator.destroy();
  }
}
