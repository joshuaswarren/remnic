import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpMemoryAdapter,
  McpMemoryBackendError,
  type McpListedTool,
  type McpToolCallResult,
  type McpToolClient,
} from "./mcp-memory-adapter.ts";

type Shape = "canonical" | "alternate";

class FakeMemoryClient implements McpToolClient {
  closeCount = 0;
  malformedRecall = false;
  malformedStore = false;
  correctApplied = true;
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(
    private readonly shape: Shape,
    private readonly storage: Map<string, string[]>,
    private readonly failRecall = false,
    private readonly omitCorrect = false
  ) {}

  async listTools(): Promise<McpListedTool[]> {
    if (this.shape === "canonical") {
      return [
        tool("store_memory", ["namespace", "sessionId", "content", "role"]),
        tool("search_memory", ["namespace", "sessionId", "query", "limit"]),
        ...(!this.omitCorrect ? [tool("correct_memory", ["namespace", "sessionId", "content"])] : []),
        tool("delete_memory", ["namespace", "sessionId"]),
      ];
    }
    return [
      tool("remember", ["scope", "conversation_id", "memory", "speaker"]),
      tool("find", ["scope", "conversation_id", "q", "top_k"]),
      ...(!this.omitCorrect ? [tool("revise", ["scope", "conversation_id", "correction"])] : []),
      tool("forget", ["scope", "conversation_id"]),
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    this.calls.push({ name, args });
    const session = String(args.sessionId ?? args.conversation_id);
    if (name === "search_memory" || name === "find") {
      if (this.failRecall) throw new Error("synthetic connection loss");
      if (this.malformedRecall) return { structuredContent: { ok: true } };
      const values = this.storage.get(session) ?? [];
      return this.shape === "canonical"
        ? { content: [{ type: "text", text: JSON.stringify({ memories: values }) }] }
        : { structuredContent: { payload: { hits: values.map((text) => ({ text })) } } };
    }
    if (name === "store_memory" || name === "remember") {
      if (this.malformedStore) return { structuredContent: { id: "unacknowledged" } };
      const content = String(args.content ?? args.memory);
      this.storage.set(session, [...(this.storage.get(session) ?? []), content]);
      return { structuredContent: { stored: true } };
    }
    if (name === "correct_memory" || name === "revise") {
      if (!this.correctApplied) return { structuredContent: { applied: false } };
      const correction = String(args.content ?? args.correction);
      const match = /^Correction: replace (.+) with (.+)\.$/s.exec(correction);
      const values = this.storage.get(session) ?? [];
      this.storage.set(
        session,
        match ? values.map((value) => value.replaceAll(match[1]!, match[2]!)) : [...values, correction]
      );
      return { structuredContent: { applied: true } };
    }
    if (name === "delete_memory" || name === "forget") {
      this.storage.delete(session);
      return { structuredContent: { deleted: true } };
    }
    return { isError: true, content: [{ type: "text", text: "unknown tool" }] };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function tool(name: string, properties: string[]): McpListedTool {
  return {
    name,
    inputSchema: {
      properties: Object.fromEntries(properties.map((property) => [property, {}])),
    },
  };
}

const inertTransport = { type: "stdio" as const, command: "unused" };

test("canonical MCP surface passes conformance and preserves empty recall", async () => {
  const storage = new Map<string, string[]>();
  const adapter = await createMcpMemoryAdapter({
    transport: inertTransport,
    namespacePrefix: "canonical-run",
    clientFactory: async () => new FakeMemoryClient("canonical", storage),
  });
  try {
    assert.equal((await adapter.preflight()).ok, true);
    assert.equal(await adapter.recall("empty", "anything"), "");
    await adapter.store("s1", [{ role: "user", content: "prefers teal" }]);
    assert.match(await adapter.recall("s1", "color"), /prefers teal/);
  } finally {
    await adapter.destroy();
  }
});

test("explicit mapping supports an independently shaped MCP surface", async () => {
  const storage = new Map<string, string[]>();
  const adapter = await createMcpMemoryAdapter({
    transport: inertTransport,
    namespacePrefix: "alternate-run",
    tools: {
      store: "remember",
      recall: { name: "find", resultPath: "payload.hits" },
      correct: "revise",
      reset: "forget",
    },
    clientFactory: async () => new FakeMemoryClient("alternate", storage),
  });
  try {
    await adapter.store("s1", [{ role: "user", content: "uses SQLite" }]);
    assert.match(await adapter.recall("s1", "database"), /uses SQLite/);
    await adapter.correct!("s1", "Correction: replace SQLite with Postgres.");
    const corrected = await adapter.recall("s1", "database");
    assert.match(corrected, /Postgres/);
    assert.doesNotMatch(corrected, /SQLite/);
  } finally {
    await adapter.destroy();
  }
});

test("missing required tool fails preflight as backend_unusable", async () => {
  const client = new FakeMemoryClient("canonical", new Map(), false, true);
  await assert.rejects(
    createMcpMemoryAdapter({
      transport: inertTransport,
      namespacePrefix: "missing-tool",
      clientFactory: async () => client,
    }),
    (error: unknown) =>
      error instanceof McpMemoryBackendError &&
      error.code === "backend_unusable" &&
      /missing correct tool/.test(error.detail)
  );
  assert.equal(client.closeCount, 1);
});

test("rejects an unscoped clear_memories mapping before any canary mutation", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let closeCount = 0;
  const client: McpToolClient = {
    async listTools() {
      return [
        tool("store_memory", ["sessionId", "content"]),
        tool("search_memory", ["sessionId", "query"]),
        tool("correct_memory", ["sessionId", "content"]),
        tool("clear_memories", []),
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { structuredContent: { ok: true } };
    },
    async close() {
      closeCount += 1;
    },
  };
  await assert.rejects(
    createMcpMemoryAdapter({
      transport: inertTransport,
      tools: { reset: "clear_memories" },
      clientFactory: async () => client,
    }),
    /unsafe reset tool clear_memories.*namespace or sessionId/
  );
  assert.deepEqual(calls, []);
  assert.equal(closeCount, 1);
});

test("rejects an unscoped recall tool before it can leak backend data", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpToolClient = {
    async listTools() {
      return [
        tool("store_memory", ["sessionId", "content"]),
        tool("search_memory", ["query"]),
        tool("correct_memory", ["sessionId", "content"]),
        tool("delete_memory", ["sessionId"]),
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { structuredContent: { memories: ["private real-store memory"] } };
    },
    async close() {},
  };
  await assert.rejects(
    createMcpMemoryAdapter({
      transport: inertTransport,
      clientFactory: async () => client,
    }),
    /unsafe recall tool search_memory.*schema-declared namespace or sessionId/
  );
  assert.deepEqual(calls, []);
});

test("explicit scope mapping is not proof unless the tool schema declares that argument", async () => {
  const client: McpToolClient = {
    async listTools() {
      return [
        tool("store_memory", ["sessionId", "content"]),
        tool("search_memory", ["query"]),
        tool("correct_memory", ["sessionId", "content"]),
        tool("delete_memory", ["sessionId"]),
      ];
    },
    async callTool() {
      throw new Error("must not be called");
    },
    async close() {},
  };
  await assert.rejects(
    createMcpMemoryAdapter({
      transport: inertTransport,
      tools: {
        recall: {
          name: "search_memory",
          arguments: { sessionId: "invented_session" },
        },
      },
      clientFactory: async () => client,
    }),
    /unsafe recall tool search_memory/
  );
});

test("package API rejects malformed tool maps before creating a client", async () => {
  let factoryCalls = 0;
  await assert.rejects(
    createMcpMemoryAdapter({
      transport: inertTransport,
      tools: { reset: { name: "forget", arguments: { global: "all" } } } as never,
      clientFactory: async () => {
        factoryCalls += 1;
        return new FakeMemoryClient("canonical", new Map());
      },
    }),
    /unknown semantic: global/
  );
  assert.equal(factoryCalls, 0);
});

test("malformed recall is invalid_response while a valid empty result stays empty", async () => {
  const client = new FakeMemoryClient("canonical", new Map());
  const adapter = await createMcpMemoryAdapter({
    transport: inertTransport,
    clientFactory: async () => client,
  });
  try {
    assert.equal(await adapter.recall("empty", "query"), "");
    client.malformedRecall = true;
    await assert.rejects(
      adapter.recall("empty", "query"),
      (error: unknown) => error instanceof McpMemoryBackendError && error.code === "invalid_response"
    );
  } finally {
    client.malformedRecall = false;
    await adapter.destroy();
  }
});

test("correct propagates an explicit applied=false acknowledgement", async () => {
  const client = new FakeMemoryClient("canonical", new Map());
  const adapter = await createMcpMemoryAdapter({
    transport: inertTransport,
    clientFactory: async () => client,
  });
  try {
    client.correctApplied = false;
    assert.deepEqual(await adapter.correct!("session", "Correction: replace old with new."), { applied: false });
  } finally {
    client.correctApplied = true;
    await adapter.destroy();
  }
});

test("store rejects a response without a mutation acknowledgement", async () => {
  const client = new FakeMemoryClient("canonical", new Map());
  const adapter = await createMcpMemoryAdapter({
    transport: inertTransport,
    clientFactory: async () => client,
  });
  try {
    client.malformedStore = true;
    await assert.rejects(
      adapter.store("session", [{ role: "user", content: "must not count" }]),
      (error: unknown) => error instanceof McpMemoryBackendError && error.code === "invalid_response"
    );
    assert.equal((await adapter.getStats()).totalMessages, 0);
  } finally {
    client.malformedStore = false;
    await adapter.destroy();
  }
});

test("preflight timeout closes a connected client whose discovery never settles", async () => {
  let closeCount = 0;
  const client: McpToolClient = {
    async listTools() {
      return new Promise<McpListedTool[]>(() => {});
    },
    async callTool() {
      throw new Error("must not be called");
    },
    async close() {
      closeCount += 1;
    },
  };
  await assert.rejects(
    createMcpMemoryAdapter({
      transport: inertTransport,
      timeoutMs: 10,
      clientFactory: async () => client,
    }),
    /timed out after 10ms/
  );
  assert.equal(closeCount, 1);
});

test("connection timeout closes a client that resolves after the deadline", async () => {
  let resolveClient!: (client: McpToolClient) => void;
  const pendingClient = new Promise<McpToolClient>((resolve) => {
    resolveClient = resolve;
  });
  const client = new FakeMemoryClient("canonical", new Map());
  const creation = createMcpMemoryAdapter({
    transport: inertTransport,
    timeoutMs: 10,
    clientFactory: async () => pendingClient,
  });
  await assert.rejects(creation, /timed out after 10ms/);
  resolveClient(client);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(client.closeCount, 1);
});

test("transport/tool failure remains distinct from successful empty recall", async () => {
  await assert.rejects(
    createMcpMemoryAdapter({
      transport: inertTransport,
      namespacePrefix: "failed-recall",
      clientFactory: async () => new FakeMemoryClient("canonical", new Map(), true),
    }),
    (error: unknown) =>
      error instanceof McpMemoryBackendError &&
      error.code === "backend_unusable" &&
      /synthetic connection loss/.test(error.detail)
  );
});

test("two adapters sharing one backend cannot see or reset each other's namespace", async () => {
  const storage = new Map<string, string[]>();
  const create = (namespacePrefix: string) =>
    createMcpMemoryAdapter({
      transport: inertTransport,
      namespacePrefix,
      clientFactory: async () => new FakeMemoryClient("canonical", storage),
    });
  const [first, second] = await Promise.all([create("run-a"), create("run-b")]);
  try {
    await first.store("same-session", [{ role: "user", content: "alpha-only" }]);
    await second.store("same-session", [{ role: "user", content: "beta-only" }]);
    assert.match(await first.recall("same-session", "value"), /alpha-only/);
    assert.doesNotMatch(await first.recall("same-session", "value"), /beta-only/);
    await first.reset();
    assert.match(await second.recall("same-session", "value"), /beta-only/);
  } finally {
    await Promise.all([first.destroy(), second.destroy()]);
  }
});
