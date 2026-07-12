import assert from "node:assert/strict";
import { test } from "node:test";

import {
  registerCli,
  type CliApi,
  type CliCommand,
  type CliProgram,
} from "./cli.js";
import type { WearablesService } from "./wearables/service.js";

/**
 * Host-CLI registration test for the wearables `fuse`/`fused` subcommands.
 *
 * The shared runner (`runWearablesCliCommand`) already handles fuse/fused, but
 * the host CLI must ALSO register forwarders under `wearablesCmd` — otherwise
 * commander rejects `remnic wearables fuse <date>` / `remnic wearables fused
 * <date>` as unknown subcommands before the runner is ever reached (issue
 * #1849). This drives `registerCli` with a recording program mock plus a stub
 * orchestrator and asserts both that the subcommands are registered and that
 * their actions dispatch into the runner (which calls the wearables service).
 */

/** Recording commander stand-in: records the command tree + action callbacks. */
class RecCmd implements CliCommand {
  readonly children = new Map<string, RecCmd>();
  readonly options: string[] = [];
  readonly args: string[] = [];
  actionFn?: (...args: unknown[]) => unknown;
  constructor(readonly rawName: string) {}
  description(): CliCommand {
    return this;
  }
  option(flags: string): CliCommand {
    this.options.push(flags);
    return this;
  }
  requiredOption(flags: string): CliCommand {
    this.options.push(flags);
    return this;
  }
  argument(name: string): CliCommand {
    this.args.push(name);
    return this;
  }
  action(fn: (...args: unknown[]) => Promise<void> | void): CliCommand {
    this.actionFn = fn;
    return this;
  }
  command(name: string): CliCommand {
    const key = name.split(/\s+/)[0]!;
    const child = new RecCmd(name);
    this.children.set(key, child);
    return child;
  }
}

class RecProgram implements CliProgram {
  readonly root = new RecCmd("__program__");
  command(name: string): CliCommand {
    return this.root.command(name);
  }
}

/**
 * Deterministic orchestrator stub. registerCli only reads `config.*` while
 * building the command tree (feature flags gate subcommand registration;
 * memoryDir is an option default), so every accessed field returns a real
 * primitive — no Proxy ever reaches a string/number call site. The wearables
 * forwarder is the only action that touches the stub, via getWearablesService.
 */
function makeOrchestratorStub(
  service: WearablesService,
): Parameters<typeof registerCli>[1] {
  const config = new Proxy(
    { memoryDir: "/tmp/cli-wearables-fuse-test" } as Record<string, unknown>,
    {
      get(target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop in target) return target[prop as string];
        const key = prop as string;
        if (
          key.endsWith("WindowMs") ||
          key.endsWith("SoftLimit") ||
          key.endsWith("HardLimit")
        ) {
          return 0;
        }
        return true; // feature flags -> enabled (every subcommand registers)
      },
    },
  );
  return { config, getWearablesService: () => service } as unknown as Parameters<
    typeof registerCli
  >[1];
}

/** Spy service recording fuseDay/fusedConversations dispatch. */
function spyService(): WearablesService & {
  calls: Array<[string, string]>;
} {
  const calls: Array<[string, string]> = [];
  const svc = {
    fuseDay: async (date: string) => {
      calls.push(["fuseDay", date]);
      return {
        date,
        sources: ["limitless", "bee"],
        conversationCount: 2,
        contentHash: "h",
        written: true,
      };
    },
    fusedConversations: async (date: string) => {
      calls.push(["fusedConversations", date]);
      return [];
    },
  };
  return { ...svc, calls } as unknown as WearablesService & {
    calls: Array<[string, string]>;
  };
}

function buildRegisteredTree(): {
  program: RecProgram;
  wearables: RecCmd;
  service: WearablesService & { calls: Array<[string, string]> };
} {
  const program = new RecProgram();
  const service = spyService();
  const api: CliApi = {
    registerCli: (handler) => handler({ program }),
  };
  registerCli(api, makeOrchestratorStub(service));
  const wearables = program.root.children.get("engram")?.children.get("wearables");
  assert.ok(wearables, "wearables command registered under engram");
  return { program, wearables: wearables!, service };
}

test("wearablesCmd registers fuse and fused subcommands (#1849)", () => {
  const { wearables } = buildRegisteredTree();
  // fuse/fused must be present alongside the previously-registered forwarders.
  const subcommands = [...wearables.children.keys()];
  for (const expected of [
    "status",
    "check",
    "sync",
    "transcript",
    "search",
    "memories",
    "speakers",
    "corrections",
    "fuse",
    "fused",
  ]) {
    assert.ok(
      subcommands.includes(expected),
      `wearables ${expected} subcommand registered`,
    );
  }

  const fuse = wearables.children.get("fuse")!;
  assert.ok(
    fuse.rawName.includes("<date>"),
    "fuse declares a <date> argument",
  );
  assert.ok(fuse.options.includes("--json"), "fuse forwards --json");

  const fused = wearables.children.get("fused")!;
  assert.ok(
    fused.rawName.includes("<date>"),
    "fused declares a <date> argument",
  );
  assert.ok(fused.options.includes("--json"), "fused forwards --json");
});

test("wearables fuse/fused forwarders dispatch to the runner, not rejected (#1849)", async () => {
  const { wearables, service } = buildRegisteredTree();
  const fuse = wearables.children.get("fuse")!;
  const fused = wearables.children.get("fused")!;

  // commander passes the <date> positional as arg[0] and the options object
  // as the trailing arg — the same shape the `search <query>` forwarder uses.
  await fuse.actionFn!("2026-06-10", { json: false });
  assert.deepEqual(
    service.calls[0],
    ["fuseDay", "2026-06-10"],
    "wearables fuse <date> dispatches into the runner -> service.fuseDay",
  );

  await fused.actionFn!("2026-06-10", { json: true });
  assert.deepEqual(
    service.calls[1],
    ["fusedConversations", "2026-06-10"],
    "wearables fused <date> dispatches into the runner -> service.fusedConversations",
  );
});
