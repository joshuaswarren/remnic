import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  buildDelegateMemoryGetTool,
  registerDelegateTools,
  registerEmbeddedTools,
} from "./delegate-tools.js";
import type { RemnicCapabilityRuntime } from "./memory-capability-types.js";
import { MemoryGetInputSchema, MemorySearchInputSchema } from "./openclaw-tools/shapes.js";

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
  assert.deepEqual(
    registerEmbeddedTools(api, { enabled: true, passive: false, tools: embeddedTools }).sort(),
    ["memory_get", "memory_search"],
    "the owner is told which names the api already carries",
  );
  assert.equal(api.tools.size, 2, "no second registration of either name");

  // The registered tools keep their identity but now run the embedded owner's
  // implementations rather than reaching the passive entry's daemon.
  await api.tools.get("memory_search")!.execute(...([] as never[]));
  await api.tools.get("memory_get")!.execute(...([] as never[]));
  assert.deepEqual(calls, ["memory_search", "memory_get"]);
});

/**
 * The reverse order: a PASSIVE embedded sibling registers first. Its
 * registration must join the same record, so the active delegate entry that
 * loads afterwards takes those names over instead of registering duplicates.
 */
test("an active delegate entry takes over names a passive embedded sibling registered", async () => {
  const registered: string[] = [];
  const tools = new Map<string, Tool>();
  const api = {
    registerTool(tool: Record<string, unknown>) {
      const named = tool as unknown as Tool;
      assert.equal(tools.has(named.name), false, `${named.name} registered twice on one api`);
      registered.push(named.name);
      tools.set(named.name, named);
    },
  };
  const embeddedCalls: string[] = [];
  const embeddedTools: Tool[] = ["memory_search", "memory_get"].map((name) => ({
    name,
    execute: async () => {
      embeddedCalls.push(name);
      return { content: [{ text: "embedded" }] };
    },
  }));
  assert.deepEqual(
    registerEmbeddedTools(api, { enabled: true, passive: true, tools: embeddedTools }).sort(),
    ["memory_get", "memory_search"],
  );
  assert.deepEqual(registered.sort(), ["memory_get", "memory_search"]);

  // The active delegate entry finds the record and serves the same names.
  registerDelegateTools(api, { ...wiringFor("remnic"), enabled: true, passive: false });
  assert.equal(tools.size, 2, "the delegate entry registers no duplicate names");
  await assert.rejects(
    tools.get("memory_search")!.execute(...(["tc-1", { query: "rollout" }, undefined, {}] as never[])),
    /remnic daemon unreachable/,
    "the active delegate wiring serves the adopted name",
  );
  assert.deepEqual(embeddedCalls, [], "the passive embedded implementation no longer runs");
});

test("registration reports nothing when the api exposes no registerTool", () => {
  assert.deepEqual(registerEmbeddedTools({}, { enabled: true, passive: false, tools: [] }), []);
});

/**
 * A passive sibling with the adapters disabled installs `memory_search` alone,
 * so the embedded owner must still receive `memory_get` — under one name each.
 */
test("a partial adoption registers the tool the sibling skipped", async () => {
  const registered: string[] = [];
  const tools = new Map<string, Tool>();
  const api = {
    registerTool(tool: Record<string, unknown>) {
      const named = tool as unknown as Tool;
      assert.equal(tools.has(named.name), false, `${named.name} registered twice on one api`);
      registered.push(named.name);
      tools.set(named.name, named);
    },
  };
  // Passive delegate entry with the adapter toggle off: search only.
  registerDelegateTools(api, { ...wiringFor("engram"), enabled: false, passive: true });
  assert.deepEqual(registered, ["memory_search"]);

  const calls: string[] = [];
  const embeddedTools: Tool[] = ["memory_search", "memory_get"].map((name) => ({
    name,
    execute: async () => {
      calls.push(name);
      return { content: [{ text: "embedded" }] };
    },
  }));
  assert.deepEqual(
    registerEmbeddedTools(api, { enabled: true, passive: false, tools: embeddedTools }).sort(),
    ["memory_get", "memory_search"],
    "the owner ends up owning both names",
  );
  assert.deepEqual(registered.sort(), ["memory_get", "memory_search"], "the skipped adapter is registered once");
  await tools.get("memory_search")!.execute(...([] as never[]));
  await tools.get("memory_get")!.execute(...([] as never[]));
  assert.deepEqual(calls, ["memory_search", "memory_get"]);
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

/**
 * With the adapters disabled, the embedded owner hands over its LEGACY search
 * implementation. Handing over the dedicated adapter would leave the disabled
 * adapter serving every search just because a delegate sibling registered the
 * name first.
 */
test("a disabled owner serves the implementation it hands over, not the adapter", async () => {
  const tools = new Map<string, Tool>();
  const api = {
    registerTool(tool: Record<string, unknown>) {
      const named = tool as unknown as Tool;
      tools.set(named.name, named);
    },
  };
  // An enabled passive delegate sibling registers both names first.
  registerDelegateTools(api, { ...wiringFor("engram"), enabled: true, passive: true });
  assert.deepEqual([...tools.keys()].sort(), ["memory_get", "memory_search"]);

  const served: string[] = [];
  const legacySearch: Tool = {
    name: "memory_search",
    execute: async () => {
      served.push("legacy");
      return { content: [{ text: "legacy" }] };
    },
  };
  assert.deepEqual(
    registerEmbeddedTools(api, { enabled: false, passive: false, tools: [legacySearch] }).sort(),
    ["memory_get", "memory_search"],
    "both names are reserved from the caller's own registration",
  );
  await tools.get("memory_search")!.execute(...([] as never[]));
  assert.deepEqual(served, ["legacy"], "the adopted name runs what the owner handed over");
  // The adapter-only tool stays inert under the flag.
  await assert.rejects(
    tools.get("memory_get")!.execute(...(["tc-1", { id: "fact-1" }, undefined, {}] as never[])),
    /memory_get is disabled/,
  );
});

/**
 * A name keeps the schema it was registered with (there is no unregister),
 * while ownership of its executor can change hands. The shared record
 * therefore advertises the PUBLIC active-memory shape whoever registers first,
 * so a takeover never leaves the model calling one runtime's schema against
 * another runtime's implementation.
 */
test("shared names advertise the public schema regardless of who registers first", () => {
  const specs = new Map<string, Record<string, unknown>>();
  const api = {
    registerTool(tool: Record<string, unknown>) {
      specs.set(String(tool.name), tool);
    },
  };
  // A legacy-shaped implementation registers first, advertising its own
  // arguments (`maxResults`, `collection`).
  const legacyShaped = {
    name: "memory_search",
    description: "legacy search",
    parameters: { type: "object", properties: { query: {}, maxResults: {}, collection: {} } },
    execute: async () => ({ content: [{ text: "legacy" }] }),
  };
  registerEmbeddedTools(api, { enabled: false, passive: true, tools: [legacyShaped as never] });
  const spec = specs.get("memory_search");
  assert.ok(spec);
  assert.equal(spec.parameters, MemorySearchInputSchema, "the public shape is advertised");
  assert.equal(spec.inputSchema, MemorySearchInputSchema);
  assert.notEqual(spec.description, "legacy search", "and the public description with it");

  // The delegate entry can then take the name over and its implementation
  // speaks exactly what is advertised.
  registerDelegateTools(api, { ...wiringFor("remnic"), enabled: true, passive: false });
  assert.equal(specs.size, 2, "memory_get is added, memory_search is not re-registered");
  assert.equal(specs.get("memory_get")?.parameters, MemoryGetInputSchema);
});
