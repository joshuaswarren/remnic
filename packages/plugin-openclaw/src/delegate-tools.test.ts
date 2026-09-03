import assert from "node:assert/strict";
import test from "node:test";

import { adoptDelegateTools, registerDelegateTools } from "./delegate-tools.js";
import type { RemnicCapabilityRuntime } from "./memory-capability-types.js";

type Tool = { name: string; execute: (...args: never[]) => Promise<unknown> };

function wiringFor(label: string) {
  return {
    target: {
      host: "127.0.0.1",
      port: 4318,
      resolveAuthToken: () => ({ token: "t", source: "REMNIC_AUTH_TOKEN" as const }),
    },
    serviceId: `openclaw-${label}`,
    runtime: {
      getMemorySearchManager: async () => ({ manager: null, error: `${label} daemon unreachable` }),
    } as unknown as RemnicCapabilityRuntime,
    agentId: "main",
    timeoutMs: 1_000,
    resolveSearchNamespace: async () => undefined,
    resolveScopedNamespace: async () => undefined,
  };
}

/**
 * The canonical and legacy plugin ids register separately against one api, so a
 * passive delegate entry can install the model-facing tools before the
 * slot-owning sibling resolves ITS bridge mode. When that owner is embedded it
 * must not register the same names again (a host tool-name conflict) and must
 * not leave the model on the passive entry's daemon.
 */
test("an embedded slot owner adopts the tools a passive delegate sibling installed", async () => {
  const api: { registerTool(tool: Record<string, unknown>): void } & { tools: Map<string, Tool> } = {
    tools: new Map<string, Tool>(),
    registerTool(tool) {
      const named = tool as unknown as Tool;
      assert.equal(api.tools.has(named.name), false, `${named.name} registered twice on one api`);
      api.tools.set(named.name, named);
    },
  };
  registerDelegateTools(api, { ...wiringFor("engram"), enabled: true, passive: true });
  assert.deepEqual([...api.tools.keys()].sort(), ["memory_get", "memory_search"]);

  const calls: string[] = [];
  const embeddedTools: Tool[] = ["memory_search", "memory_get"].map((name) => ({
    name,
    execute: async () => {
      calls.push(name);
      return { content: [{ text: "embedded" }] };
    },
  }));
  assert.equal(
    adoptDelegateTools(api, { enabled: true, tools: embeddedTools }),
    true,
    "the embedded owner must be told to skip its own registration",
  );
  assert.equal(api.tools.size, 2, "no second registration of either name");

  // The registered tools keep their identity but now run the embedded owner's
  // implementations rather than reaching the passive entry's daemon.
  await api.tools.get("memory_search")!.execute(...([] as never[]));
  await api.tools.get("memory_get")!.execute(...([] as never[]));
  assert.deepEqual(calls, ["memory_search", "memory_get"]);

  // An owner that opted out makes the sibling-installed tools inert.
  adoptDelegateTools(api, { enabled: false, tools: embeddedTools });
  await assert.rejects(
    api.tools.get("memory_search")!.execute(...([] as never[])),
    /openclawToolsEnabled: false/,
  );
});

test("adoption reports false when the api carries no delegate tools", () => {
  const api = { registerTool: () => {} };
  assert.equal(adoptDelegateTools(api, { enabled: true, tools: [] }), false);
});
