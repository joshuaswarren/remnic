import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { PluginConfig } from "@remnic/core/types";
import { parseConfig } from "@remnic/core/config";
import { NamespaceSearchRouter, namespaceCollectionName } from "@remnic/core/namespaces/search";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions } from "@remnic/core/search/port";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function baseConfig(memoryDir: string): PluginConfig {
  return parseConfig({
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "openclaw-engram",
    conversationIndexQmdCollection: "openclaw-engram-convo",
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    principalFromSessionKeyMode: "prefix",
    namespacePolicies: [
      { name: "team-alpha", readPrincipals: ["default"], writePrincipals: ["default"] },
    ],
    defaultRecallNamespaces: ["self", "shared"],
  });
}

type FakeSearchBackend = SearchBackend & {
  calls: string[];
  lastSearchOptions?: SearchQueryOptions;
  lastUpdateExecution?: SearchExecutionOptions;
  isDaemonMode?: () => boolean;
};

function backendForResultSet(resultSet: Array<{ docid: string; path: string; score: number; snippet: string }>): FakeSearchBackend {
  const calls: string[] = [];
  const backend: FakeSearchBackend = {
    calls,
    isAvailable: () => true,
    debugStatus: () => "ok",
    isDaemonMode: () => false,
    probe: async () => true,
    search: async (_query, _collection, _maxResults, options) => {
      calls.push("search");
      backend.lastSearchOptions = options;
      return resultSet;
    },
    searchGlobal: async () => [],
    bm25Search: async () => {
      calls.push("bm25");
      return resultSet;
    },
    vectorSearch: async () => {
      calls.push("vector");
      return resultSet;
    },
    hybridSearch: async () => {
      calls.push("hybrid");
      return resultSet;
    },
    update: async (execution) => {
      calls.push("update");
      backend.lastUpdateExecution = execution;
    },
    updateCollection: async () => {
      calls.push("updateCollection");
    },
    embed: async () => {
      calls.push("embed");
    },
    embedCollection: async () => {
      calls.push("embedCollection");
    },
    ensureCollection: async () => "present",
  };
  return backend;
}

test("namespaceCollectionName keeps legacy default collection and derives namespaced collections", () => {
  assert.equal(
    namespaceCollectionName("openclaw-engram", "default", {
      defaultNamespace: "default",
      useLegacyDefaultCollection: true,
    }),
    "openclaw-engram",
  );

  assert.equal(
    namespaceCollectionName("openclaw-engram", "shared", {
      defaultNamespace: "default",
      useLegacyDefaultCollection: true,
    }),
    "openclaw-engram--ns-736861726564",
  );

  assert.equal(
    namespaceCollectionName("openclaw-engram", "default", {
      defaultNamespace: "default",
      useLegacyDefaultCollection: false,
    }),
    "openclaw-engram--ns-64656661756c74",
  );
});

test("NamespaceSearchRouter scopes backends by namespace root and keeps namespace-scoped results", async () => {
  const memoryDir = tmpDir("engram-ns-search");
  const cfg = baseConfig(memoryDir);
  const seenConfigs: Array<{ memoryDir: string; collection: string }> = [];
  const backends = new Map<string, FakeSearchBackend>();
  const storageRouter = {
    async storageFor(namespace: string) {
      return {
        dir:
          namespace === "default"
            ? memoryDir
            : path.join(memoryDir, "namespaces", namespace),
      };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    (backendCfg) => {
      seenConfigs.push({
        memoryDir: backendCfg.memoryDir,
        collection: backendCfg.qmdCollection,
      });
      const backend =
        backendCfg.qmdCollection === "openclaw-engram--ns-736861726564"
          ? backendForResultSet([
              { docid: "shared-1", path: path.join(memoryDir, "namespaces", "shared", "facts", "shared.md"), score: 0.8, snippet: "shared" },
              { docid: "dup", path: path.join(memoryDir, "namespaces", "shared", "facts", "dup.md"), score: 0.6, snippet: "shared dup" },
            ])
          : backendForResultSet([
              { docid: "default-1", path: path.join(memoryDir, "facts", "default.md"), score: 0.9, snippet: "default" },
              { docid: "dup", path: path.join(memoryDir, "facts", "dup.md"), score: 0.7, snippet: "default dup" },
            ]);
      backends.set(backendCfg.qmdCollection, backend);
      return backend;
    },
  );

  const results = await router.searchAcrossNamespaces({
    query: "memory",
    namespaces: ["default", "shared"],
    maxResults: 5,
    mode: "search",
  });

  assert.deepEqual(
    seenConfigs,
    [
      { memoryDir, collection: "openclaw-engram" },
      { memoryDir: path.join(memoryDir, "namespaces", "shared"), collection: "openclaw-engram--ns-736861726564" },
    ],
  );
  assert.deepEqual(
    results.map((result) => [result.path, result.score, result.snippet]),
    [
      [path.join(memoryDir, "facts", "default.md"), 0.9, "default"],
      [path.join(memoryDir, "namespaces", "shared", "facts", "shared.md"), 0.8, "shared"],
      [path.join(memoryDir, "facts", "dup.md"), 0.7, "default dup"],
      [path.join(memoryDir, "namespaces", "shared", "facts", "dup.md"), 0.6, "shared dup"],
    ],
  );
});

test("NamespaceSearchRouter rejects QMD hits outside the queried namespace storage root", async () => {
  const memoryDir = tmpDir("engram-ns-search-containment");
  const cfg = baseConfig(memoryDir);
  const sharedRoot = path.join(memoryDir, "namespaces", "shared");
  const storageRouter = {
    async storageFor(namespace: string) {
      return {
        dir: namespace === "default" ? memoryDir : path.join(memoryDir, "namespaces", namespace),
      };
    },
  };

  const router = new NamespaceSearchRouter(cfg, storageRouter, (backendCfg) =>
    backendCfg.qmdCollection === "openclaw-engram--ns-736861726564"
      ? backendForResultSet([
          // In-root hit — kept.
          { docid: "ok", path: path.join(sharedRoot, "facts", "ok.md"), score: 0.9, snippet: "ok" },
          // Stale-collection hit whose absolute path belongs to another
          // namespace's storage root (#2077) — must be rejected before the
          // queried namespace is stamped as owner.
          { docid: "leak", path: path.join(memoryDir, "namespaces", "other", "facts", "leak.md"), score: 0.95, snippet: "leak" },
          // Absolute path fully outside the memory dir — must be rejected too.
          { docid: "escape", path: "/etc/passwd", score: 0.99, snippet: "escape" },
        ])
      : backendForResultSet([]),
  );

  const results = await router.searchAcrossNamespaces({
    query: "memory",
    namespaces: ["shared"],
    maxResults: 5,
    mode: "search",
  });

  assert.deepEqual(
    results.map((result) => [result.namespace, result.path]),
    [["shared", path.join(sharedRoot, "facts", "ok.md")]],
  );
});

test("NamespaceSearchRouter derives a namespaced collection for migrated default roots", async () => {
  const memoryDir = tmpDir("engram-ns-search-default");
  const cfg = baseConfig(memoryDir);
  let seenCollection = "";
  const storageRouter = {
    async storageFor() {
      return {
        dir: path.join(memoryDir, "namespaces", "default"),
      };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    (backendCfg) => {
      seenCollection = backendCfg.qmdCollection;
      return backendForResultSet([]);
    },
  );

  await router.searchAcrossNamespaces({
    query: "memory",
    namespaces: ["default"],
    maxResults: 3,
    mode: "hybrid",
  });

  assert.equal(seenCollection, "openclaw-engram--ns-64656661756c74");
});

test("NamespaceSearchRouter forwards search options to backend search mode", async () => {
  const memoryDir = tmpDir("engram-ns-search-options");
  const cfg = baseConfig(memoryDir);
  const backend = backendForResultSet([
    { docid: "default-1", path: "/tmp/default.md", score: 0.9, snippet: "default" },
  ]);
  const router = new NamespaceSearchRouter(
    cfg,
    {
      async storageFor() {
        return { dir: memoryDir };
      },
    } as any,
    () => backend,
  );

  await router.searchAcrossNamespaces({
    query: "memory",
    namespaces: ["default"],
    maxResults: 3,
    mode: "search",
    searchOptions: { intent: "goal:review action:review", explain: true },
  });

  assert.deepEqual(backend.lastSearchOptions, {
    intent: "goal:review action:review",
    explain: true,
  });
});

test("NamespaceSearchRouter skips namespaces whose collection is missing", async () => {
  const memoryDir = tmpDir("engram-ns-search-missing");
  const cfg = baseConfig(memoryDir);
  const storageRouter = {
    async storageFor(namespace: string) {
      return {
        dir:
          namespace === "default"
            ? memoryDir
            : path.join(memoryDir, "namespaces", namespace),
      };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    (backendCfg) => ({
      ...backendForResultSet([
        {
          docid: `${backendCfg.qmdCollection}-1`,
          path: path.join(backendCfg.memoryDir, "facts", `${backendCfg.qmdCollection}.md`),
          score: 0.8,
          snippet: backendCfg.qmdCollection,
        },
      ]),
      ensureCollection: async () =>
        backendCfg.qmdCollection === "openclaw-engram--ns-736861726564" ? "missing" : "present",
    }),
  );

  const results = await router.searchAcrossNamespaces({
    query: "memory",
    namespaces: ["default", "shared"],
    maxResults: 5,
  });

  assert.equal(results.length, 1);
  assert.match(results[0]?.path ?? "", /openclaw-engram\.md$/);
});

test("NamespaceSearchRouter runs maintenance only for present namespace collections", async () => {
  const memoryDir = tmpDir("engram-ns-search-maintenance");
  const cfg = baseConfig(memoryDir);
  const backends = new Map<string, FakeSearchBackend>();
  const storageRouter = {
    async storageFor(namespace: string) {
      return {
        dir:
          namespace === "default"
            ? memoryDir
            : path.join(memoryDir, "namespaces", namespace),
      };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    (backendCfg) => {
      const backend: FakeSearchBackend = {
        ...backendForResultSet([]),
        ensureCollection: async () =>
          backendCfg.qmdCollection === "openclaw-engram--ns-736861726564" ? "missing" : "present",
      };
      backends.set(backendCfg.qmdCollection, backend);
      return backend;
    },
  );

  await router.updateNamespaces(["default", "shared"]);
  await router.embedNamespaces(["default", "shared"]);

  assert.deepEqual(backends.get("openclaw-engram")?.calls, ["update", "embedCollection"]);
  assert.deepEqual(backends.get("openclaw-engram--ns-736861726564")?.calls ?? [], []);
});

test("NamespaceSearchRouter forwards execution options to namespace updates", async () => {
  const memoryDir = tmpDir("engram-ns-search-update-execution");
  const cfg = baseConfig(memoryDir);
  const backend = backendForResultSet([]);
  const signal = new AbortController().signal;
  const router = new NamespaceSearchRouter(
    cfg,
    {
      async storageFor() {
        return { dir: memoryDir };
      },
    } as any,
    () => backend,
  );

  await router.updateNamespaces(["default"], { signal });

  assert.deepEqual(backend.calls, ["update"]);
  assert.equal(backend.lastUpdateExecution?.signal, signal);
});

test("NamespaceSearchRouter ensureNamespaceCollection returns cached availability without re-ensuring", async () => {
  const memoryDir = tmpDir("engram-ns-search-ensure");
  const cfg = baseConfig(memoryDir);
  let ensureCalls = 0;
  const storageRouter = {
    async storageFor() {
      return { dir: memoryDir };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    () => ({
      ...backendForResultSet([]),
      probe: async () => false,
      ensureCollection: async () => {
        ensureCalls += 1;
        return "present";
      },
    }),
  );

  const state = await router.ensureNamespaceCollection("default");

  assert.equal(state, "unknown");
  assert.equal(ensureCalls, 0);
});

test("NamespaceSearchRouter rejects a symlinked hit that escapes the namespace root and keeps a '..'-prefixed child (#2077)", async () => {
  const memoryDir = mkdtempSync(path.join(os.tmpdir(), "engram-ns-symlink-"));
  try {
    const cfg = baseConfig(memoryDir);
    const sharedRoot = path.join(memoryDir, "namespaces", "shared");
    const otherRoot = path.join(memoryDir, "namespaces", "other");
    mkdirSync(path.join(sharedRoot, "facts"), { recursive: true });
    mkdirSync(path.join(otherRoot, "facts"), { recursive: true });
    const secret = path.join(otherRoot, "facts", "secret.md");
    writeFileSync(secret, "secret");
    const linkInShared = path.join(sharedRoot, "facts", "link.md");
    symlinkSync(secret, linkInShared);
    const inRoot = path.join(sharedRoot, "facts", "ok.md");
    writeFileSync(inRoot, "ok");
    // A real file whose name begins with ".." — contained, must NOT be treated
    // as parent traversal.
    const dotNotes = path.join(sharedRoot, "..notes.md");
    writeFileSync(dotNotes, "notes");

    const storageRouter = {
      async storageFor(namespace: string) {
        return {
          dir: namespace === "default" ? memoryDir : path.join(memoryDir, "namespaces", namespace),
        };
      },
    };
    const router = new NamespaceSearchRouter(cfg, storageRouter, (backendCfg) =>
      backendCfg.qmdCollection === "openclaw-engram--ns-736861726564"
        ? backendForResultSet([
            { docid: "ok", path: inRoot, score: 0.9, snippet: "ok" },
            { docid: "dotdot", path: dotNotes, score: 0.8, snippet: "notes" },
            // Lexically inside the shared root, but realpath escapes into `other`.
            { docid: "leak", path: linkInShared, score: 0.95, snippet: "leak" },
          ])
        : backendForResultSet([]),
    );

    const results = await router.searchAcrossNamespaces({
      query: "memory",
      namespaces: ["shared"],
      maxResults: 5,
      mode: "search",
    });

    assert.deepEqual(
      results.map((result) => result.path),
      [inRoot, dotNotes],
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});
