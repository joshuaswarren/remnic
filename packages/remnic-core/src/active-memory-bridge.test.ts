import assert from "node:assert/strict";
import test from "node:test";

import {
  getMemoryForActiveMemory,
  recallForActiveMemory,
} from "./active-memory-bridge.js";

const keepVisibleSearchResults = async <T>(results: T[]): Promise<T[]> => results;

test("recallForActiveMemory caps limit, truncates snippets, and strips internal scoring fields", async () => {
  const orchestrator = {
    resolveSelfNamespace: (_sessionKey?: string) => "resolved-namespace",
    filterPrivateSearchResults: keepVisibleSearchResults,
    searchAcrossNamespaces: async (_params: unknown) => [
      {
        id: "mem-1",
        score: 0.91,
        path: "/tmp/memory/default/facts/mem-1.md",
        snippet:
          "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
        raw_bm25: 9.2,
        raw_vector: 0.73,
        metadata: {
          type: "preference",
          topic: "style",
          updatedAt: "2026-04-12T10:00:00Z",
          sourceUri: "memory://mem-1",
        },
      },
    ],
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "writing style",
    limit: 1000,
    snippetMaxChars: 24,
    sessionKey: "session-a",
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.id, "mem-1");
  assert.equal(result.results[0]?.score, 0.91);
  assert.match(result.results[0]?.text ?? "", /^Alpha beta gamma delta/);
  assert.ok((result.results[0]?.text?.length ?? 0) <= 24);
  assert.deepEqual(result.results[0]?.metadata, {
    type: "preference",
    topic: "style",
    updatedAt: "2026-04-12T10:00:00Z",
    sourceUri: "memory://mem-1",
  });
  assert.ok(!("raw_bm25" in (result.results[0] as unknown as Record<string, unknown>)));
  assert.ok(!("raw_vector" in (result.results[0] as unknown as Record<string, unknown>)));
  assert.equal(result.truncated, false);
});

test("recallForActiveMemory truncates snippets without splitting surrogate pairs", async () => {
  const orchestrator = {
    resolveSelfNamespace: () => "resolved-namespace",
    getStorageForNamespace: async () => ({
      getMemoryById: async () => ({ content: "emoji memory", frontmatter: {} } as never),
    }),
    searchAcrossNamespaces: async () => [
      {
        id: "mem-emoji",
        score: 0.5,
        snippet: "emoji 😀😀😀 trail",
      },
    ],
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "emoji",
    snippetMaxChars: 8,
    sessionKey: "session-a",
  });

  assert.equal(result.results[0]?.text, "emoji 😀😀");
});

test("recallForActiveMemory defaults to the caller namespace derived from sessionKey", async () => {
  let receivedNamespaces: string[] | undefined;
  const orchestrator = {
    resolveSelfNamespace: (sessionKey?: string) =>
      sessionKey === "session-b" ? "session-b-namespace" : "fallback-namespace",
    searchAcrossNamespaces: async (params: { namespaces?: string[] }) => {
      receivedNamespaces = params.namespaces;
      return [];
    },
  };

  await recallForActiveMemory(orchestrator as never, {
    query: "api docs",
    sessionKey: "session-b",
  });

  assert.deepEqual(receivedNamespaces, ["session-b-namespace"]);
});

test("recallForActiveMemory prioritizes an explicit namespace filter over the session namespace", async () => {
  let receivedNamespaces: string[] | undefined;
  const orchestrator = {
    resolveSelfNamespace: () => "session-namespace",
    filterPrivateSearchResults: keepVisibleSearchResults,
    searchAcrossNamespaces: async (params: { namespaces?: string[] }) => {
      receivedNamespaces = params.namespaces;
      return [];
    },
  };

  await recallForActiveMemory(orchestrator as never, {
    query: "api docs",
    sessionKey: "session-b",
    filters: {
      namespace: "explicit-namespace",
    },
  });

  assert.deepEqual(receivedNamespaces, ["explicit-namespace"]);
});

test("recallForActiveMemory ignores explicit namespace filters when namespaces are disabled", async () => {
  let receivedNamespaces: string[] | undefined;
  const orchestrator = {
    config: { namespacesEnabled: false },
    resolveSelfNamespace: () => "self-namespace",
    searchAcrossNamespaces: async (params: { namespaces?: string[] }) => {
      receivedNamespaces = params.namespaces;
      return [];
    },
  };

  await recallForActiveMemory(orchestrator as never, {
    query: "api docs",
    sessionKey: "session-b",
    filters: {
      namespace: "explicit-namespace",
    },
  });

  assert.deepEqual(receivedNamespaces, ["self-namespace"]);
});

test("recallForActiveMemory denies blank session keys when namespaces are enabled", async () => {
  const orchestrator = {
    config: {
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
      principalFromSessionKeyMode: "disabled",
      principalFromSessionKeyRules: [],
    },
    searchAcrossNamespaces: async () => {
      throw new Error("search should not run without an authenticated principal");
    },
  };

  await assert.rejects(
    () =>
      recallForActiveMemory(orchestrator as never, {
        query: "api docs",
        sessionKey: "   ",
        filters: {
          namespace: "default",
        },
      }),
    /authentication required/,
  );
});

test("recallForActiveMemory marks results truncated when the underlying recall exceeds the requested limit", async () => {
  const orchestrator = {
    resolveSelfNamespace: () => "session-namespace",
    filterPrivateSearchResults: keepVisibleSearchResults,
    searchAcrossNamespaces: async () =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `mem-${index + 1}`,
        score: 0.9 - index * 0.1,
        path: `/tmp/memory/default/facts/mem-${index + 1}.md`,
        snippet: `memory ${index + 1}`,
      })),
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "project status",
    limit: 2,
    sessionKey: "session-b",
  });

  assert.equal(result.results.length, 2);
  assert.equal(result.truncated, true);
});

test("recallForActiveMemory excludes artifact-backed hits before applying the visible result cap", async () => {
  const orchestrator = {
    resolveSelfNamespace: () => "session-namespace",
    filterPrivateSearchResults: keepVisibleSearchResults,
    searchAcrossNamespaces: async () => [
      {
        id: "artifact-1",
        score: 0.99,
        path: "/tmp/memory/default/artifacts/artifact-1.md",
        snippet: "artifact snippet should stay isolated",
      },
      {
        id: "mem-1",
        score: 0.88,
        path: "/tmp/memory/default/facts/mem-1.md",
        snippet: "first visible memory",
      },
      {
        id: "mem-2",
        score: 0.77,
        path: "/tmp/memory/default/facts/mem-2.md",
        snippet: "second visible memory",
      },
    ],
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "infra outage",
    limit: 2,
    sessionKey: "session-b",
  });

  assert.deepEqual(
    result.results.map((entry) => entry.id),
    ["mem-1", "mem-2"],
  );
  assert.equal(result.truncated, false);
  assert.equal(
    result.results.some((entry) => /artifact snippet/i.test(entry.text)),
    false,
  );
});

test("recallForActiveMemory excludes support passport records before applying the visible result cap", async () => {
  const memories = new Map([
    ["/tmp/memory/preferences/card.md", {
      content: "Give me time to answer.",
      frontmatter: { tags: ["support-passport-card"] },
    } as never],
    ["/tmp/memory/corrections/audit.md", {
      content: "Superseded: Give me time to answer.",
      frontmatter: { tags: ["support-passport-audit"] },
    } as never],
    ["/tmp/memory/facts/safe.md", {
      content: "Safe memory.",
      frontmatter: { tags: [] },
    } as never],
  ]);
  const orchestrator = {
    resolveSelfNamespace: () => "session-namespace",
    getStorageForNamespace: async () => ({
      readMemoryByPath: async (memoryPath: string) => memories.get(memoryPath) ?? null,
    }),
    filterPrivateSearchResults: async (results: Array<{ path: string }>) =>
      results.filter((result) => !result.path.includes("/preferences/card.md") && !result.path.includes("/corrections/audit.md")),
    searchAcrossNamespaces: async () => [
      { id: "card", score: 0.99, path: "/tmp/memory/preferences/card.md", snippet: "private card" },
      { id: "audit", score: 0.98, path: "/tmp/memory/corrections/audit.md", snippet: "private audit" },
      { id: "safe", score: 0.8, path: "/tmp/memory/facts/safe.md", snippet: "safe memory" },
    ],
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "support",
    limit: 2,
    sessionKey: "session-b",
  });

  assert.deepEqual(result.results.map((entry) => entry.id), ["safe"]);
  assert.equal(result.truncated, false);
});

test("recallForActiveMemory pages past private passport records", async () => {
  const corpus = [
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `private-${index}`,
      score: 1 - index / 100,
      path: `/tmp/memory/preferences/private-${index}.md`,
      snippet: "private support card",
    })),
    { id: "safe", score: 0.5, path: "/tmp/memory/facts/safe.md", snippet: "safe memory" },
  ];
  const limits: number[] = [];
  const orchestrator = {
    resolveSelfNamespace: () => "session-namespace",
    filterPrivateSearchResults: async (results: Array<{ path: string }>) =>
      results.filter((result) => result.path.endsWith("safe.md")),
    searchAcrossNamespaces: async ({ maxResults }: { maxResults?: number }) => {
      limits.push(maxResults ?? corpus.length);
      return corpus.slice(0, maxResults);
    },
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "support",
    limit: 1,
    sessionKey: "session-b",
  });

  assert.deepEqual(result.results.map((entry) => entry.id), ["safe"]);
  assert.ok(limits.length > 1);
  assert.equal(result.truncated, false);
});

test("recallForActiveMemory resolves collection-prefixed paths through the private-result filter", async () => {
  const calls: Array<{ paths: string[]; namespaces: readonly string[] | undefined }> = [];
  const orchestrator = {
    resolveSelfNamespace: () => "session-namespace",
    getStorageForNamespace: async () => ({
      readMemoryByPath: async () => {
        throw new Error("direct path reads must not decide QMD visibility");
      },
    }),
    filterPrivateSearchResults: async (
      results: Array<{ path: string }>,
      namespaces: readonly string[] | undefined,
    ) => {
      calls.push({ paths: results.map((result) => result.path), namespaces });
      return results.filter((result) => result.path.endsWith("safe.md"));
    },
    searchAcrossNamespaces: async () => [
      { id: "card", score: 0.99, path: "openclaw-engram/preferences/card.md", snippet: "private card" },
      { id: "safe", score: 0.8, path: "openclaw-engram/facts/safe.md", snippet: "safe memory" },
    ],
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "support",
    sessionKey: "session-b",
  });

  assert.deepEqual(result.results.map((entry) => entry.id), ["safe"]);
  assert.deepEqual(calls, [{
    paths: ["openclaw-engram/preferences/card.md", "openclaw-engram/facts/safe.md"],
    namespaces: ["session-namespace"],
  }]);
});

test("recallForActiveMemory fails closed when candidate storage cannot be resolved", async () => {
  const orchestrator = {
    resolveSelfNamespace: () => "session-namespace",
    searchAcrossNamespaces: async () => [
      { id: "unresolved-path", path: "openclaw-engram/preferences/card.md", snippet: "private path" },
      { id: "unresolved-id", snippet: "private id" },
    ],
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "support",
    sessionKey: "session-b",
  });

  assert.deepEqual(result, { results: [], truncated: false });
});

test("getMemoryForActiveMemory returns not_found instead of throwing", async () => {
  const orchestrator = {
    resolveSelfNamespace: () => "readable-session",
    getStorageForNamespace: async () => ({
      getMemoryById: async () => null,
    }),
  };

  const result = await getMemoryForActiveMemory(orchestrator as never, "missing");
  assert.deepEqual(result, { error: "not_found" });
});

test("getMemoryForActiveMemory hides support passport records", async () => {
  for (const tag of ["support-passport-card", "support-passport-audit"]) {
    const orchestrator = {
      resolveSelfNamespace: () => "readable-session",
      getStorageForNamespace: async () => ({
        getMemoryById: async () => ({
          content: "owner-controlled content",
          frontmatter: { tags: [tag] },
        } as never),
      }),
    };

    assert.deepEqual(
      await getMemoryForActiveMemory(orchestrator as never, "private-record"),
      { error: "not_found" },
      tag,
    );
  }
});

test("getMemoryForActiveMemory reads via the session-derived namespace storage", async () => {
  let readNamespace: string | undefined;
  const orchestrator = {
    getStorageForNamespace: async (namespace: string) => {
      readNamespace = namespace;
      return {
        getMemoryById: async (id: string) =>
          id === "present" ? ({ content: "text", frontmatter: {} } as never) : null,
      };
    },
    resolveSelfNamespace: (sessionKey?: string) =>
      sessionKey === "session-x" ? "session-x-namespace" : "fallback-namespace",
  };

  const result = await getMemoryForActiveMemory(
    orchestrator as never,
    "present",
    { sessionKey: "session-x" },
  );

  assert.equal(readNamespace, "session-x-namespace");
  assert.equal(result.id, "present");
  assert.equal(result.text, "text");
});

test("getMemoryForActiveMemory honors an explicit namespace override", async () => {
  let readNamespace: string | undefined;
  const orchestrator = {
    getStorageForNamespace: async (namespace: string) => {
      readNamespace = namespace;
      return {
        getMemoryById: async (id: string) =>
          id === "shared-memory" ? ({ content: "shared text", frontmatter: {} } as never) : null,
      };
    },
    resolveSelfNamespace: () => "session-namespace",
  };

  const result = await getMemoryForActiveMemory(
    orchestrator as never,
    "shared-memory",
    { namespace: "shared" },
  );

  assert.equal(readNamespace, "shared");
  assert.equal(result.id, "shared-memory");
  assert.equal(result.text, "shared text");
});

test("getMemoryForActiveMemory ignores explicit namespace overrides when namespaces are disabled", async () => {
  let readNamespace: string | undefined;
  const orchestrator = {
    config: { namespacesEnabled: false },
    getStorageForNamespace: async (namespace: string) => {
      readNamespace = namespace;
      return {
        getMemoryById: async (id: string) =>
          id === "shared-memory" ? ({ content: "shared text", frontmatter: {} } as never) : null,
      };
    },
    resolveSelfNamespace: () => "self-namespace",
  };

  const result = await getMemoryForActiveMemory(
    orchestrator as never,
    "shared-memory",
    { namespace: "shared" },
  );

  assert.equal(readNamespace, "self-namespace");
  assert.equal(result.id, "shared-memory");
  assert.equal(result.text, "shared text");
});


test("getMemoryForActiveMemory resolves a [m:xxxx] handle via the orchestrator resolver (#1582)", async () => {
  const resolved: string[] = [];
  const orchestrator = {
    config: { namespacesEnabled: false },
    resolveSelfNamespace: () => "readable-session",
    getStorageForNamespace: async () => ({
      getMemoryById: async (id: string) =>
        id === "fact-1" ? ({ content: "text", frontmatter: {} } as never) : null,
    }),
    resolveMemoryIdOrHandle: (ref: string) => {
      resolved.push(ref);
      return "fact-1";
    },
  };

  const result = await getMemoryForActiveMemory(
    orchestrator as never,
    "[m:4f2a]",
    { sessionKey: "session-x" },
  );
  assert.deepEqual(resolved, ["[m:4f2a]"]);
  assert.equal(result.error, undefined);
  assert.equal(result.id, "fact-1");
});

test("getMemoryForActiveMemory passes a raw id through unchanged (no resolver call) (#1582)", async () => {
  const orchestrator = {
    config: { namespacesEnabled: false },
    resolveSelfNamespace: () => "readable-session",
    getStorageForNamespace: async () => ({
      getMemoryById: async (id: string) =>
        id === "fact-1" ? ({ content: "text", frontmatter: {} } as never) : null,
    }),
    resolveMemoryIdOrHandle: () => {
      throw new Error("resolver must not be called for a raw id");
    },
  };

  const result = await getMemoryForActiveMemory(
    orchestrator as never,
    "fact-1",
    { sessionKey: "session-x" },
  );
  assert.equal(result.id, "fact-1");
});

test("getMemoryForActiveMemory returns not_found when a handle cannot be resolved (#1582, cursor review)", async () => {
  // A missing session key, unknown handle, or ambiguous handle makes the
  // orchestrator resolver THROW. The active-memory get path must yield the SAME
  // not_found contract a bad raw id gets — not propagate the throw and crash an
  // OpenClaw active-memory caller.
  const orchestrator = {
    config: { namespacesEnabled: false },
    resolveSelfNamespace: () => "readable-session",
    getStorageForNamespace: async () => ({
      getMemoryById: async () => null,
    }),
    resolveMemoryIdOrHandle: () => {
      throw new Error("Memory handle [m:dead] cannot be resolved without a session key.");
    },
  };

  const result = await getMemoryForActiveMemory(
    orchestrator as never,
    "[m:dead]",
    // No sessionKey → resolver throws "without a session key".
    {},
  );
  assert.equal(result.error, "not_found");
});
