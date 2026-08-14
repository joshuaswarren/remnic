import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
};

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

function buildHarness(overrides?: {
  searchGlobal?: (query: string, maxResults?: number) => Promise<Array<{
    path: string;
    score: number;
    snippet?: string;
  }>>;
  filterPrivateSearchResults?: (results: Array<{
    path: string;
    score: number;
    snippet?: string;
  }>) => Promise<Array<{
    path: string;
    score: number;
    snippet?: string;
  }>>;
  searchAcrossNamespaces?: (params: {
    query: string;
    namespaces?: string[];
    maxResults?: number;
    mode?: string;
  }) => Promise<Array<{
    path: string;
    score: number;
    snippet?: string;
  }>>;
}) {
  const tools = new Map<string, RegisteredTool>();
  const reads: Array<{ kind: "profile" | "identity"; namespace: string }> = [];
  const requestedNamespaces: Array<string | undefined> = [];
  const globalSearchCalls: Array<{ query: string; maxResults?: number }> = [];
  const namespaceSearchCalls: Array<{
    query: string;
    namespaces?: string[];
    maxResults?: number;
    mode?: string;
  }> = [];

  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      workspaceDir: "/tmp/workspace",
      openclawToolsEnabled: false,
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
      identityContinuityEnabled: true,
    },
    qmd: {
      search: async () => [],
      searchGlobal:
        overrides?.searchGlobal ??
        (async (query: string, maxResults?: number) => {
          globalSearchCalls.push({ query, maxResults });
          return [];
        }),
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    storage: {
      readIdentity: async () => null,
      readProfile: async () => "default profile",
      readAllEntities: async () => [],
      readIdentityAnchor: async () => null,
      writeIdentityAnchor: async () => {},
    },
    getStorageForNamespace: async (namespace?: string) => {
      requestedNamespaces.push(namespace);
      const resolved = typeof namespace === "string" && namespace.length > 0 ? namespace : "default";
      return {
        readProfile: async () => {
          reads.push({ kind: "profile", namespace: resolved });
          return `${resolved} profile`;
        },
        readIdentityReflections: async () => {
          reads.push({ kind: "identity", namespace: resolved });
          return `${resolved} identity`;
        },
      };
    },
    summarizer: {
      runHourly: async () => {},
    },
    transcript: {
      listSessionKeys: async () => [],
    },
    sharedContext: null,
    compounding: null,
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
    appendMemoryActionEvent: async () => true,
    searchAcrossNamespaces: async (params: {
      query: string;
      namespaces?: string[];
      maxResults?: number;
      mode?: string;
    }) => {
      namespaceSearchCalls.push(params);
      return overrides?.searchAcrossNamespaces?.(params) ?? [];
    },
    filterPrivateSearchResults:
      overrides?.filterPrivateSearchResults ?? (async (results: unknown[]) => results),
  };

  registerTools(api as any, orchestrator as any);
  return { tools, reads, requestedNamespaces, globalSearchCalls, namespaceSearchCalls };
}

test("memory_profile reads from the requested namespace storage", async () => {
  const { tools, reads } = buildHarness();
  const tool = tools.get("memory_profile");
  assert.ok(tool);

  const result = await tool.execute("tc1", { namespace: "shared" });
  assert.match(toolText(result), /shared profile/);
  assert.deepEqual(reads, [{ kind: "profile", namespace: "shared" }]);
});

test("memory_identity accepts namespace and reads namespace-local reflections", async () => {
  const { tools, reads } = buildHarness();
  const tool = tools.get("memory_identity");
  assert.ok(tool);

  const result = await tool.execute("tc2", { namespace: "shared" });
  assert.match(toolText(result), /shared identity/);
  assert.deepEqual(reads, [{ kind: "identity", namespace: "shared" }]);
});

test("memory_profile preserves an explicit default namespace request", async () => {
  const { tools, requestedNamespaces } = buildHarness();
  const tool = tools.get("memory_profile");
  assert.ok(tool);

  await tool.execute("tc3", { namespace: "default" });

  assert.deepEqual(requestedNamespaces, ["default"]);
});

test("memory_search routes global namespace requests through namespace search", async () => {
  const { tools, globalSearchCalls, namespaceSearchCalls } = buildHarness();
  const tool = tools.get("memory_search");
  assert.ok(tool);

  await tool.execute("tc4", {
    query: "project status",
    collection: "global",
    namespace: "shared",
    maxResults: 5,
  });

  assert.deepEqual(globalSearchCalls, []);
  assert.deepEqual(namespaceSearchCalls, [
    { query: "project status", namespaces: ["shared"], maxResults: 5, mode: "search" },
  ]);
});

test("memory_search avoids pre-filter global caps for namespace requests", async () => {
  const { tools } = buildHarness({
    searchGlobal: async () => {
      throw new Error("global search should not be used for namespace-scoped requests");
    },
    searchAcrossNamespaces: async () => [
      {
        path: "/tmp/memory/namespaces/shared/facts/shared.md",
        score: 0.8,
        snippet: "shared result",
      },
    ],
  });
  const tool = tools.get("memory_search");
  assert.ok(tool);

  const result = await tool.execute("tc5", {
    query: "project status",
    collection: "global",
    namespace: "shared",
  });

  const text = toolText(result);
  assert.match(text, /shared\.md/);
});

test("memory_search refills after private records consume the first result window", async () => {
  const calls: number[] = [];
  const all = [
    { path: "/tmp/private-1.md", score: 1, snippet: "private" },
    { path: "/tmp/private-2.md", score: 0.9, snippet: "private" },
    { path: "/tmp/public-1.md", score: 0.8, snippet: "public one" },
    { path: "/tmp/public-2.md", score: 0.7, snippet: "public two" },
  ];
  const { tools } = buildHarness({
    searchGlobal: async (_query, maxResults) => {
      calls.push(maxResults ?? 0);
      return all.slice(0, maxResults);
    },
    filterPrivateSearchResults: async (results) =>
      results.filter((result) => !result.path.includes("private")),
  });
  const tool = tools.get("memory_search");
  assert.ok(tool);

  const result = await tool.execute("tc6", {
    query: "support",
    collection: "global",
    maxResults: 2,
  });

  assert.deepEqual(calls, [2, 18]);
  assert.match(toolText(result), /public-1\.md/);
  assert.match(toolText(result), /public-2\.md/);
});

test("memory_search refills beyond 500 private records", async () => {
  const calls: number[] = [];
  const privateResults = Array.from({ length: 501 }, (_, index) => ({
    path: `/tmp/private-${index}.md`,
    score: 1 - index / 1_000,
    snippet: "private",
  }));
  const all = [
    ...privateResults,
    { path: "/tmp/public-after-hidden.md", score: 0.1, snippet: "public" },
  ];
  const { tools } = buildHarness({
    searchGlobal: async (_query, maxResults) => {
      calls.push(maxResults ?? 0);
      return all.slice(0, maxResults);
    },
    filterPrivateSearchResults: async (results) =>
      results.filter((result) => !result.path.includes("private")),
  });
  const tool = tools.get("memory_search");
  assert.ok(tool);

  const result = await tool.execute("tc7", {
    query: "support",
    collection: "global",
    maxResults: 1,
  });

  assert.ok(calls.some((limit) => limit > 500));
  assert.match(toolText(result), /public-after-hidden\.md/);
});
