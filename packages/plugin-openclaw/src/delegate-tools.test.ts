import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  adoptDelegateTools,
  buildDelegateMemoryGetTool,
  registerDelegateTools,
} from "./delegate-tools.js";
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

  // An owner that opted out of the adapters makes the sibling-installed
  // `memory_get` inert; the search surface survives the flag in both modes.
  adoptDelegateTools(api, { enabled: false, tools: embeddedTools });
  await assert.rejects(
    api.tools.get("memory_get")!.execute(...([] as never[])),
    /openclawToolsEnabled: false/,
  );
  await api.tools.get("memory_search")!.execute(...([] as never[]));
});

test("adoption reports false when the api carries no delegate tools", () => {
  const api = { registerTool: () => {} };
  assert.equal(adoptDelegateTools(api, { enabled: true, tools: [] }), false);
});

/**
 * `memory_get` opens ONE deadline for the whole call, so scope resolution must
 * receive what is LEFT of it rather than a fresh full timeout — otherwise one
 * invocation can run for nearly twice the configured budget.
 */
test("memory_get hands namespace resolution the remaining budget, not the full timeout", async () => {
  const timeoutMs = 10_000;
  const budgets: number[] = [];
  const tool = buildDelegateMemoryGetTool({
    target: wiringFor("remnic").target,
    serviceId: "openclaw-remnic",
    timeoutMs,
    resolveNamespace: async (_sessionKey, remainingMs) => {
      budgets.push(remainingMs);
      throw new Error("scope resolution stops the call before any daemon request");
    },
  });
  await assert.rejects(
    tool.execute("tc-1", { id: "fact-1" }, undefined, { sessionKey: "s" }),
    /scope resolution stops the call/,
  );
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0]! <= timeoutMs, `resolution must not get a fresh budget (got ${budgets[0]})`);
  assert.ok(budgets[0]! > 0, "and must still get a usable one");
});

/**
 * Embedded parity for the handle contract: `getMemoryForActiveMemory` answers
 * an unresolvable `[m:xxxx]` handle with `not_found`, so delegate mode must not
 * turn the daemon's 400 for the same input into a tool exception. Other 400s
 * still surface.
 */
test("memory_get maps a daemon 400 for an unresolvable handle to not_found", async () => {
  const statuses = new Map<string, number>([
    ["%5Bm%3Adead%5D", 400],
    ["plain-id", 400],
  ]);
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    const status = [...statuses].find(([id]) => path.includes(id))?.[1] ?? 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad request" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const tool = buildDelegateMemoryGetTool({
      target: { ...wiringFor("remnic").target, port },
      serviceId: "openclaw-remnic",
      timeoutMs: 5_000,
      resolveNamespace: async () => undefined,
    });
    const missed = (await tool.execute("tc-1", { id: "[m:dead]" }, undefined, { sessionKey: "s" })) as {
      content: Array<{ text: string }>;
    };
    assert.deepEqual(JSON.parse(missed.content[0]!.text), { error: "not_found" });
    // A 400 for a raw id is a real protocol error, not a miss.
    await assert.rejects(
      tool.execute("tc-2", { id: "plain-id" }, undefined, { sessionKey: "s" }),
      /responded 400/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
