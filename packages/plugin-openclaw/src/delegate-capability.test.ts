import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initLogger, resetLogger } from "@remnic/core/logger";

import {
  createDelegateMemoryCapability,
  registerDelegateMemoryCapability,
  type DelegateCapabilityOptions,
} from "./delegate-capability.js";

type RecordedCall = { pathname: string; body: unknown };

type DaemonStub = {
  port: number;
  calls: RecordedCall[];
  /** Runs when a health request is served, so a test can advance its clock. */
  onHealth?: () => void;
  close: () => Promise<void>;
};

type StubRoutes = {
  health?: unknown;
  /** A literal response body, for shapes `JSON.stringify` would normalize. */
  healthRaw?: string;
  healthStatus?: number;
  /** Delay the health response, so a test can observe a shared deadline. */
  healthDelayMs?: number;
  search?: unknown;
  searchStatus?: number;
};

async function startDaemonStub(routes: StubRoutes): Promise<DaemonStub> {
  const calls: RecordedCall[] = [];
  let stub: DaemonStub | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const pathname = (req.url ?? "").split("?")[0] ?? "";
      calls.push({ pathname, body: raw ? JSON.parse(raw) : undefined });
      const isSearch = pathname.endsWith("/memories/search");
      if (!isSearch) stub?.onHealth?.();
      const delayMs = isSearch ? 0 : (routes.healthDelayMs ?? 0);
      if (delayMs > 0) {
        setTimeout(() => respond(), delayMs);
        return;
      }
      respond();

      function respond(): void {
        const status = isSearch
          ? (routes.searchStatus ?? 200)
          : (routes.healthStatus ?? 200);
        res.writeHead(status, { "content-type": "application/json" });
        if (!isSearch && routes.healthRaw !== undefined) {
          // A literal body, so a test can send a 200 that is valid JSON but not
          // a record — the shape `?? {}` would otherwise paper over.
          res.end(routes.healthRaw);
          return;
        }
        let payload = isSearch ? routes.search : routes.health;
        if (isSearch && payload !== null && typeof payload === "object") {
          // Honor `maxResults` the way a real daemon does, so a client-side
          // top-up sees a genuinely truncated page.
          const requested = (
            calls[calls.length - 1]?.body as { maxResults?: number } | undefined
          )?.maxResults;
          const page = payload as { results?: unknown[]; count?: number };
          if (typeof requested === "number" && Array.isArray(page.results)) {
            const sliced = page.results.slice(0, requested);
            payload = { ...page, results: sliced, count: sliced.length };
          }
        }
        res.end(JSON.stringify(payload ?? {}));
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.on("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address !== "object") {
    server.close();
    throw new Error("stub did not bind");
  }
  stub = {
    port: address.port,
    calls,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
  return stub;
}

async function makeCorpus(): Promise<{
  memoryDir: string;
  workspaceDir: string;
}> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "remnic-delegate-cap-")),
  );
  const memoryDir = path.join(root, "memory");
  const workspaceDir = path.join(root, "workspace");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await mkdir(path.join(memoryDir, "artifacts"), { recursive: true });
  await mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "facts", "alice.md"),
    "one\ntwo\nthree\nfour\n",
  );
  // Exists ONLY under the gateway's workspace - the daemon never saw it.
  await writeFile(
    path.join(workspaceDir, "memory", "notes.md"),
    "gateway-only\n",
  );
  await writeFile(
    path.join(memoryDir, "artifacts", "report.md"),
    "secret artifact\n",
  );
  return { memoryDir, workspaceDir };
}

function optionsFor(
  port: number,
  memoryDir: string,
  workspaceDir: string,
  overrides: Partial<DelegateCapabilityOptions> = {},
): DelegateCapabilityOptions {
  return {
    serviceId: "openclaw-remnic",
    target: {
      host: "127.0.0.1",
      port,
      resolveAuthToken: () => ({
        token: "test-token",
        source: "REMNIC_AUTH_TOKEN",
      }),
    },
    namespace: "",
    resolveSearchNamespace: async () => undefined,
    memoryDir,
    workspaceDir,
    agentIds: ["generalist"],
    allowPromptInjection: true,
    readPromptLines: () => null,
    configuredSearchBackend: "qmd",
    configuredQmdCommand: "qmd",
    searchTimeoutMs: 5_000,
    healthTimeoutMs: 5_000,
    ...overrides,
  };
}

/** A daemon serving the SAME corpus as the plugin under test. */
function healthyDaemon(memoryDir: string): Record<string, unknown> {
  return {
    ok: true,
    memoryDir,
    namespacesEnabled: false,
    searchBackend: "qmd",
    qmdEnabled: true,
    qmd: {
      enabled: true,
      active: true,
      degraded: false,
      debugStatus: "cli=true",
    },
  };
}

test.before(() =>
  initLogger(
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    false,
  ),
);
test.after(() => resetLogger());

test("delegate search maps daemon hits into runtime results", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    search: {
      query: "alice",
      count: 2,
      results: [
        { path: "facts/alice.md", score: 0.9, snippet: "alice likes tea" },
        { path: "sessions/2026-01-01.md", score: 0.4, snippet: "session note" },
      ],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    assert.ok(manager);
    const results = await manager.search("alice", { maxResults: 5 });
    assert.deepEqual(results, [
      {
        path: path.join(memoryDir, "facts", "alice.md"),
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "alice likes tea",
        source: "memory",
        citation: path.join("facts", "alice.md"),
      },
      {
        path: path.join(memoryDir, "sessions", "2026-01-01.md"),
        startLine: 1,
        endLine: 1,
        score: 0.4,
        snippet: "session note",
        source: "sessions",
        citation: path.join("sessions", "2026-01-01.md"),
      },
    ]);
    const searchCall = stub.calls.find((call) =>
      call.pathname.endsWith("/memories/search"),
    );
    assert.deepEqual(searchCall?.body, {
      query: "alice",
      maxResults: 5,
      mode: "search",
    });
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search excludes artifact paths and honors minScore", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    search: {
      results: [
        { path: "artifacts/report.md", score: 0.99, snippet: "artifact" },
        { path: "facts/alice.md", score: 0.2, snippet: "low" },
        { path: "facts/bob.md", score: 0.8, snippet: "high" },
      ],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const results = await manager?.search("q", { minScore: 0.5 });
    assert.deepEqual(
      results?.map((result) => result.citation),
      [path.join("facts", "bob.md")],
      "artifacts are isolated and sub-threshold hits are dropped",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search scopes the namespace through the session resolver", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    search: { results: [] },
  });
  const seen: Array<string | undefined> = [];
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir, {
        namespace: "fallback-ns",
        resolveSearchNamespace: async (sessionKey) => {
          seen.push(sessionKey);
          return sessionKey === "s1" ? "team-a" : "fallback-ns";
        },
      }),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await manager?.search("q", { sessionKey: "s1" });
    await manager?.search("q");
    const searches = stub.calls.filter((call) =>
      call.pathname.endsWith("/memories/search"),
    );
    assert.deepEqual(searches[0]?.body, {
      query: "q",
      mode: "search",
      namespace: "team-a",
    });
    assert.deepEqual(
      searches[1]?.body,
      { query: "q", mode: "search", namespace: "fallback-ns" },
      "a search with no session key falls back to the registration-wide namespace",
    );
    assert.deepEqual(
      seen,
      ["s1", undefined],
      "the host session key reaches the resolver",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate refuses file-backed surfaces when the daemon serves another corpus", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(path.join(memoryDir, "..", "someone-elses-corpus")),
    search: {
      results: [{ path: "facts/alice.md", score: 0.5, snippet: "hit" }],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () =>
        manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
      /delegate readFile unavailable/,
      "reading a same-named local file would serve the wrong corpus",
    );
    assert.deepEqual(
      await built.listArtifacts(),
      [],
      "artifact listing is disabled too",
    );
    const results = await manager?.search("alice");
    assert.equal(results?.length, 1, "daemon-backed search still works");
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate refuses file-backed surfaces until the corpus is confirmed", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ healthStatus: 500, health: {} });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () =>
        manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
      /delegate readFile unavailable/,
      "an unconfirmed corpus fails closed rather than reading local files",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search surfaces a daemon failure instead of returning empty", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    searchStatus: 503,
    search: {},
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve([]),
      /responded 503/,
      "a backend failure must not be indistinguishable from no results",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate readFile reads the shared corpus and paginates", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const page = await manager?.readFile({
      relPath: "facts/alice.md",
      from: 2,
      lines: 2,
    });
    assert.equal(page?.text, "two\nthree");
    assert.equal(page?.truncated, true);
    assert.equal(page?.nextFrom, 4);
    const whole = await manager?.readFile({ relPath: "facts/alice.md" });
    assert.equal(whole?.truncated, undefined);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate readFile refuses paths outside the memory roots", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () => manager?.readFile({ relPath: "/etc/hosts" }) ?? Promise.resolve(),
      /memory read (outside allowed roots|restricted to \.md files|rejected)/,
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate status reflects the daemon health snapshot", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const status = manager?.status();
    assert.equal(status?.backend, "qmd");
    assert.equal(status?.dbPath, memoryDir);
    assert.deepEqual(status?.vector, { enabled: true, available: true });
    assert.equal(await manager?.probeVectorAvailability(), true);
    assert.deepEqual(await manager?.probeEmbeddingAvailability(), { ok: true });
    assert.deepEqual(
      built.runtime.resolveMemoryBackendConfig({ cfg: {}, agentId: "main" }),
      {
        backend: "qmd",
        qmd: { command: "qmd" },
      },
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate status reports a degraded daemon QMD as unavailable", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: {
      memoryDir,
      namespacesEnabled: false,
      searchBackend: "qmd",
      qmdEnabled: true,
      qmd: {
        enabled: true,
        active: true,
        degraded: true,
        debugStatus: "collection missing",
      },
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    assert.equal(manager?.status().vector?.available, false);
    assert.deepEqual(await manager?.probeEmbeddingAvailability(), {
      ok: false,
      error: "collection missing",
    });
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate status keeps the configured backend when the daemon health probe fails", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ healthStatus: 500, health: {} });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    // A failed probe must not fabricate an outage — the seeded config wins.
    assert.equal(manager?.status().backend, "qmd");
    assert.equal(manager?.status().dbPath, memoryDir);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate health is cached and refreshed on the injected clock", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  let clock = 1_000;
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir, { now: () => clock }),
    );
    await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const healthCalls = () =>
      stub.calls.filter((call) => call.pathname.endsWith("/health")).length;
    assert.equal(healthCalls(), 1, "a warm snapshot is reused");
    clock += 60_000;
    await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    assert.equal(healthCalls(), 2, "an expired snapshot is refreshed");
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate runtime offers no sync — indexing stays the daemon's job", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    assert.equal(manager?.sync, undefined);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate flush plan matches the embedded contract", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir, {
        extractionMaxTurnChars: 12_000,
        flushModel: "gpt-test",
      }),
    );
    const plan = built.flushPlanResolver();
    assert.equal(plan.forceFlushTranscriptBytes, 48_000);
    assert.equal(plan.model, "gpt-test");
    assert.equal(
      plan.relativePath,
      "state/plugins/openclaw-remnic/flush-plan.md",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate publicArtifacts lists the corpus and degrades to empty on failure", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const artifacts = await built.listArtifacts();
    assert.ok(
      artifacts.length > 0,
      "the shared corpus yields public artifacts",
    );

    const missing = createDelegateMemoryCapability(
      optionsFor(
        stub.port,
        path.join(memoryDir, "does-not-exist"),
        workspaceDir,
      ),
    );
    assert.deepEqual(await missing.listArtifacts(), []);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("registerDelegateMemoryCapability wires the unified host surface", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const registered: Record<string, unknown> = {};
    const seenSessionKeys: string[] = [];
    registerDelegateMemoryCapability(
      {
        registerMemoryCapability: (capability) => {
          registered.capability = capability;
        },
        registerMemoryRuntime: (runtime) => {
          registered.runtime = runtime;
        },
        registerMemoryFlushPlan: (resolver) => {
          registered.flushPlan = resolver;
        },
      },
      optionsFor(stub.port, memoryDir, workspaceDir, {
        readPromptLines: (sessionKey) => {
          seenSessionKeys.push(sessionKey);
          return sessionKey === "s1" ? ["## Memory", "line"] : null;
        },
      }),
    );
    const capability = registered.capability as Record<string, unknown>;
    assert.ok(capability);
    assert.equal(typeof capability.promptBuilder, "function");
    assert.equal(typeof capability.flushPlanResolver, "function");
    assert.ok(capability.runtime);
    assert.ok(capability.publicArtifacts);
    assert.ok(registered.runtime);
    assert.ok(registered.flushPlan);

    const promptBuilder = capability.promptBuilder as (p: {
      sessionKey?: string;
    }) => string[] | null;
    assert.deepEqual(promptBuilder({ sessionKey: "s1" }), [
      "## Memory",
      "line",
    ]);
    assert.deepEqual(
      seenSessionKeys,
      ["s1"],
      "the host session key reaches the seam, which owns peek-vs-consume",
    );
    assert.equal(
      promptBuilder({}),
      null,
      "a missing session key reads the default bucket",
    );
    assert.deepEqual(seenSessionKeys, ["s1", "default"]);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("registerDelegateMemoryCapability omits promptBuilder when injection is disabled", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    let capability: Record<string, unknown> | undefined;
    registerDelegateMemoryCapability(
      {
        registerMemoryCapability: (value) => {
          capability = value as Record<string, unknown>;
        },
      },
      optionsFor(stub.port, memoryDir, workspaceDir, {
        allowPromptInjection: false,
      }),
    );
    assert.ok(capability);
    assert.equal("promptBuilder" in capability, false);
    assert.ok(capability.runtime, "the runtime is still provided");
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("registerDelegateMemoryCapability falls back to split host surfaces", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const registered: Record<string, unknown> = {};
    registerDelegateMemoryCapability(
      {
        registerMemoryRuntime: (runtime) => {
          registered.runtime = runtime;
        },
        registerMemoryFlushPlan: (resolver) => {
          registered.flushPlan = resolver;
        },
      },
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    assert.ok(registered.runtime);
    assert.ok(registered.flushPlan);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("registerDelegateMemoryCapability is a no-op on a host with no memory surface", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    assert.doesNotThrow(() =>
      registerDelegateMemoryCapability(
        {},
        optionsFor(stub.port, memoryDir, workspaceDir),
      ),
    );
    assert.equal(
      stub.calls.length,
      0,
      "nothing is probed when nothing can be registered",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate accepts a daemon serving a namespace under the corpus root", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // Health reports the namespace-RESOLVED storage dir, not the corpus root.
  const namespaceDir = path.join(memoryDir, "namespaces", "generalist");
  await mkdir(path.join(namespaceDir, "facts"), { recursive: true });
  await writeFile(path.join(namespaceDir, "facts", "alice.md"), "one\ntwo\n");
  const stub = await startDaemonStub({ health: healthyDaemon(namespaceDir) });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const page = await manager?.readFile({ relPath: "facts/alice.md" });
    assert.equal(
      page?.text.startsWith("one"),
      true,
      "a migrated default namespace is not foreign",
    );
    assert.ok((await built.listArtifacts()).length > 0);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search forwards the host's ranking override", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    search: { results: [] },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await manager?.search("q", { qmdSearchModeOverride: "vsearch" });
    await manager?.search("q", { qmdSearchModeOverride: "query" });
    await manager?.search("q");
    const searches = stub.calls
      .filter((call) => call.pathname.endsWith("/memories/search"))
      .map((call) => (call.body as { mode?: unknown }).mode);
    assert.deepEqual(
      searches,
      ["vector", "search", "search"],
      "vsearch is vector ranking; everything else is the embedded default, never omitted",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate roots reads and artifacts on the daemon's namespace directory", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const namespaceDir = path.join(memoryDir, "namespaces", "generalist");
  await mkdir(path.join(namespaceDir, "facts"), { recursive: true });
  await writeFile(
    path.join(namespaceDir, "facts", "scoped.md"),
    "namespace fact\n",
  );
  const stub = await startDaemonStub({ health: healthyDaemon(namespaceDir) });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    // The daemon's hits are relative to ITS storage dir, so the read scope must
    // be rooted there, not on the configured corpus root.
    const page = await manager?.readFile({ relPath: "facts/scoped.md" });
    assert.equal(page?.text.trim(), "namespace fact");
    const artifacts = (await built.listArtifacts()) as Array<{
      absolutePath?: string;
    }>;
    assert.ok(
      artifacts.some((entry) => entry.absolutePath?.startsWith(namespaceDir)),
      "the active namespace's artifacts are listed",
    );
    assert.equal(
      artifacts.some(
        (entry) =>
          entry.absolutePath === path.join(memoryDir, "facts", "alice.md"),
      ),
      false,
      "flat-root files outside the active namespace are not published for it",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search sends the daemon's default namespace, never an absent one", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), defaultNamespace: "generalist" },
    search: { results: [] },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir, {
        // A session bound to the default namespace is stored as "", which the
        // runtime resolver collapses to undefined.
        resolveSearchNamespace: async () => undefined,
      }),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await manager?.search("q");
    const body = stub.calls.find((call) =>
      call.pathname.endsWith("/memories/search"),
    )?.body;
    assert.deepEqual(
      body,
      { query: "q", mode: "search", namespace: "generalist" },
      "an absent namespace would be a principal-wide fan-out, not the default scope",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search returns empty for a zero result budget without calling the daemon", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    search: { results: [] },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    assert.deepEqual(await manager?.search("q", { maxResults: 0 }), []);
    assert.equal(
      stub.calls.some((call) => call.pathname.endsWith("/memories/search")),
      false,
      "the daemon schema requires maxResults >= 1, so forwarding 0 would 400 a valid request",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate reads a hit from another namespace's storage directory", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const defaultDir = path.join(memoryDir, "namespaces", "generalist");
  const otherDir = path.join(memoryDir, "namespaces", "team-a");
  await mkdir(defaultDir, { recursive: true });
  await mkdir(path.join(otherDir, "facts"), { recursive: true });
  await writeFile(path.join(otherDir, "facts", "scoped.md"), "team-a fact\n");
  // Health answers for the DEFAULT namespace, but a session bound to team-a
  // gets hits under team-a's directory; the host must be able to open them.
  const stub = await startDaemonStub({
    health: healthyDaemon(defaultDir),
    search: {
      results: [
        {
          path: path.join(otherDir, "facts", "scoped.md"),
          score: 0.9,
          snippet: "hit",
        },
      ],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir, {
        resolveSearchNamespace: async () => "team-a",
      }),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const [hit] = (await manager?.search("q")) ?? [];
    assert.ok(hit, "the daemon returned a hit");
    const page = await manager?.readFile({ relPath: hit.path });
    assert.equal(
      page?.text.trim(),
      "team-a fact",
      "the host can open its own search hit",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate refuses file-backed surfaces for a remote daemon with an identical path", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    search: {
      results: [{ path: "facts/alice.md", score: 0.5, snippet: "hit" }],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir, {
        // Canonicalizing two strings on THIS host says nothing about a remote
        // daemon that happens to use the same absolute pathname.
        target: {
          host: "10.0.0.9",
          port: stub.port,
          resolveAuthToken: () => ({ token: "t", source: "REMNIC_AUTH_TOKEN" }),
        },
      }),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () =>
        manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
      /is not local/,
    );
    assert.deepEqual(await built.listArtifacts(), []);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate readFile refuses artifact paths", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () =>
        manager?.readFile({ relPath: "artifacts/report.md" }) ??
        Promise.resolve(),
      /artifact path/,
      "search filters artifacts; the read path must not be a way around that",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search caps AFTER dropping artifacts, not before", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // Every one of the top-ranked hits is an artifact. Capping first would
  // return an empty page even though valid memories rank right behind them.
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    search: {
      query: "q",
      count: 5,
      results: [
        { path: "artifacts/a1.md", score: 0.99, snippet: "artifact" },
        { path: "artifacts/a2.md", score: 0.98, snippet: "artifact" },
        { path: "facts/one.md", score: 0.5, snippet: "one" },
        { path: "facts/two.md", score: 0.4, snippet: "two" },
        { path: "facts/three.md", score: 0.3, snippet: "three" },
      ],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const results = (await manager?.search("q", { maxResults: 2 })) ?? [];
    assert.deepEqual(
      results.map((hit) => hit.citation),
      [path.join("facts", "one.md"), path.join("facts", "two.md")],
      "a full page of real memories, and never more than the budget",
    );
    const searchCalls = stub.calls.filter((call) =>
      call.pathname.includes("/memories/search"),
    );
    assert.deepEqual(
      searchCalls.map(
        (call) => (call.body as { maxResults?: number }).maxResults,
      ),
      [2, 4],
      "asks again with a doubled limit rather than returning a thin page",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate health backs off on a 200 with a malformed body", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // A persistently malformed 200 must not turn every later refresh into an
  // immediate re-fetch; it backs off exactly like a transport failure.
  const stub = await startDaemonStub({ healthRaw: "null" });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    // Every entry point that consults health goes through the same refresh, so
    // three back-to-back handouts would mean three probes with no backoff.
    await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const healthCalls = stub.calls.filter((call) =>
      call.pathname.includes("/health"),
    );
    assert.equal(
      healthCalls.length,
      1,
      "later handouts reuse the backoff, they do not re-probe",
    );
    // And the malformed payload never becomes a corpus claim.
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () =>
        manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
      /has not been confirmed/,
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search with no budget keeps the daemon's page size on the wire", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    search: {
      query: "q",
      count: 3,
      results: [
        { path: "artifacts/a1.md", score: 0.9, snippet: "artifact" },
        { path: "facts/one.md", score: 0.5, snippet: "one" },
        { path: "facts/two.md", score: 0.4, snippet: "two" },
      ],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const results = (await manager?.search("q")) ?? [];
    const searchCalls = stub.calls.filter((call) =>
      call.pathname.includes("/memories/search"),
    );
    // First request carries no cap - the caller accepted the daemon's page.
    assert.equal(
      (searchCalls[0]?.body as { maxResults?: number }).maxResults,
      undefined,
      "no invented budget on the wire",
    );
    // The artifact thinned that page, so it tops up against what was served.
    assert.deepEqual(
      searchCalls.map(
        (call) => (call.body as { maxResults?: number }).maxResults,
      ),
      [undefined, 6],
    );
    assert.deepEqual(
      results.map((hit) => hit.citation),
      [path.join("facts", "one.md"), path.join("facts", "two.md")],
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search rejects a malformed result entry instead of inventing a memory", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // A 200 whose entries are not memories is a version-skewed or corrupt
  // daemon. Synthesizing `memory-N` would hand the host a path it can then
  // try to open (AGENTS.md #22).
  for (const bad of [
    "not-an-object",
    { score: 0.9 },
    { path: 42 },
    { path: "  " },
  ]) {
    const stub = await startDaemonStub({
      health: healthyDaemon(memoryDir),
      search: {
        results: [{ path: "facts/ok.md", score: 0.9, snippet: "ok" }, bad],
      },
    });
    try {
      const built = createDelegateMemoryCapability(
        optionsFor(stub.port, memoryDir, workspaceDir),
      );
      const { manager } = await built.runtime.getMemorySearchManager({
        cfg: {},
        agentId: "main",
      });
      await assert.rejects(
        () => manager?.search("q") ?? Promise.resolve(),
        /malformed result entry/,
        `entry ${JSON.stringify(bad)} must be a protocol failure`,
      );
    } finally {
      await stub.close();
    }
  }
  await rm(memoryDir, { recursive: true, force: true });
});

test("delegate file surfaces refuse a namespace-partitioned daemon", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // `readFile` and `listArtifacts` carry NO session, and health answers
  // without a namespace, so on a partitioned daemon there is nothing to
  // authorize the local walk against. A per-registration fallback would open
  // one namespace's disk for sessions bound to another.
  // `undefined` from the daemon now falls back to the plugin's own posture, so
  // the unreported case is paired with a partitioned config - "nobody says it
  // is flat" must still fail closed.
  for (const namespacesEnabled of [true, undefined]) {
    const stub = await startDaemonStub({
      health: {
        ...healthyDaemon(memoryDir),
        namespacesEnabled,
        defaultNamespace: "default",
      },
      search: { query: "q", count: 0, results: [] },
    });
    try {
      const built = createDelegateMemoryCapability({
        ...optionsFor(stub.port, memoryDir, workspaceDir),
        resolveSearchNamespace: async (sessionKey) =>
          sessionKey === "s2" ? "team-a" : "default",
      });
      const { manager } = await built.runtime.getMemorySearchManager({
        cfg: {},
        agentId: "main",
      });
      await assert.rejects(
        () =>
          manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
        /a local read cannot be authorized/,
        `namespacesEnabled: ${String(namespacesEnabled)} must fail closed`,
      );
      assert.deepEqual(
        await built.listArtifacts(),
        [],
        "artifacts are withheld, not cross-published",
      );
      // Search is unaffected: it carries the session and the daemon enforces.
      assert.ok(
        Array.isArray(await manager?.search("q", { sessionKey: "s2" })),
      );
    } finally {
      await stub.close();
    }
  }
  await rm(memoryDir, { recursive: true, force: true });
});

test("delegate file surfaces stay available on a single-corpus daemon", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: false },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const read = await manager?.readFile({ relPath: "facts/alice.md" });
    assert.equal(
      read?.path,
      path.join("facts", "alice.md"),
      "the read is served, not refused",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate reads do not fall back to the gateway's own workspace", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // The daemon reports only its memoryDir. A file that exists solely under the
  // gateway's <workspaceDir>/memory was never searched or authorized by it.
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: false },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () => manager?.readFile({ relPath: "notes.md" }) ?? Promise.resolve(),
      /memory read rejected/,
      "a workspace-only file is not readable through the delegate",
    );
    // The daemon's own corpus is unaffected.
    const read = await manager?.readFile({ relPath: "facts/alice.md" });
    assert.equal(read?.path, path.join("facts", "alice.md"));
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate refuses a substituted default namespace the token cannot use", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // A fresh session has no binding, so the daemon default is SUBSTITUTED. On a
  // token scoped elsewhere that would 403 on the very first search; the
  // refusal must name the fix instead.
  const stub = await startDaemonStub({
    health: {
      ...healthyDaemon(memoryDir),
      namespacesEnabled: true,
      defaultNamespace: "default",
    },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
      verifyNamespaceAuthorization: async () => false,
    });
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve(),
      /is not authorized for the delegate token/,
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate proceeds when the substituted default IS authorized, and on an older daemon", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  for (const verdict of [true, undefined]) {
    const stub = await startDaemonStub({
      health: {
        ...healthyDaemon(memoryDir),
        namespacesEnabled: true,
        defaultNamespace: "default",
      },
      search: { query: "q", count: 0, results: [] },
    });
    try {
      let probes = 0;
      const built = createDelegateMemoryCapability({
        ...optionsFor(stub.port, memoryDir, workspaceDir),
        resolveSearchNamespace: async () => undefined,
        verifyNamespaceAuthorization: async () => {
          probes += 1;
          return verdict;
        },
      });
      const { manager } = await built.runtime.getMemorySearchManager({
        cfg: {},
        agentId: "main",
      });
      assert.deepEqual(await manager?.search("q"), []);
      await manager?.search("q again");
      assert.equal(
        probes,
        1,
        "the verdict is cached, not re-probed per search",
      );
    } finally {
      await stub.close();
    }
  }
  await rm(memoryDir, { recursive: true, force: true });
});

test("delegate does not second-guess an explicit namespace", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: {
      ...healthyDaemon(memoryDir),
      namespacesEnabled: true,
      defaultNamespace: "default",
    },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    let probed = false;
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => "team-a",
      verifyNamespaceAuthorization: async () => {
        probed = true;
        return false;
      },
    });
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    assert.deepEqual(await manager?.search("q"), []);
    assert.equal(
      probed,
      false,
      "the caller's own scope is the daemon's to enforce",
    );
    const searchCall = stub.calls.find((call) =>
      call.pathname.includes("/memories/search"),
    );
    assert.equal(
      (searchCall?.body as { namespace?: string }).namespace,
      "team-a",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("swapping in an authorized token recovers unbound delegate search", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // Daemon requests resolve credentials dynamically. Caching a refusal against
  // the namespace alone would keep rejecting search locally after an operator
  // replaced an under-scoped token, while recall and observe recovered.
  const stub = await startDaemonStub({
    health: {
      ...healthyDaemon(memoryDir),
      namespacesEnabled: true,
      defaultNamespace: "default",
    },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    let token = "under-scoped";
    const base = optionsFor(stub.port, memoryDir, workspaceDir);
    const built = createDelegateMemoryCapability({
      ...base,
      target: {
        ...base.target,
        resolveAuthToken: () => ({ token, source: "REMNIC_AUTH_TOKEN" }),
      },
      resolveSearchNamespace: async () => undefined,
      verifyNamespaceAuthorization: async () => token === "authorized",
    });
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve(),
      /is not authorized for the delegate token/,
    );
    token = "authorized";
    assert.deepEqual(
      await manager?.search("q"),
      [],
      "the new token is re-probed, not refused from cache",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a failed probe leaves the posture unknown, so unbound calls fail closed", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // Nothing answers. The plugin's own config describes the PLUGIN, never the
  // daemon's partitioning, so there is no local evidence that an absent
  // namespace is safe - and an unrestricted token would otherwise fan out.
  const built = createDelegateMemoryCapability({
    ...optionsFor(1, memoryDir, workspaceDir),
    resolveSearchNamespace: async () => undefined,
  });
  try {
    await assert.rejects(
      () => built.resolveScopedNamespace(undefined),
      /default namespace is unknown/,
    );
    // An explicit scope is the caller's own and still resolves.
    assert.equal(await built.resolveScopedNamespace("team-a"), "team-a");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a daemon that ANSWERS without a posture is unknown, not flat", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // The plugin config describes the PLUGIN's deployment. A partitioned daemon
  // on a legacy build would otherwise be marked flat by a flat plugin config,
  // permitting an absent namespace and fanning search across everything the
  // token can read.
  const stub = await startDaemonStub({
    health: { ok: true, memoryDir },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
    });
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve(),
      /default namespace is unknown/,
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a partitioned plugin config still fails closed before the first probe", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: { ok: true, memoryDir },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
    });
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve(),
      /default namespace is unknown/,
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a health 200 without memoryDir leaves the corpus unconfirmed", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // An unknown memoryDir is NEVER a match. Substituting the plugin's own path
  // would compare it to itself and enable file-backed reads with no proof the
  // daemon serves that corpus at all.
  const stub = await startDaemonStub({
    health: { ok: true, namespacesEnabled: false },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () =>
        manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
      /daemon serves an unknown memoryDir/,
      "file-backed reads stay disabled until the daemon names its corpus",
    );
    // Search is unaffected - it runs through the daemon, which enforces.
    assert.ok(Array.isArray(await manager?.search("q")));
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate readFile rejects invalid offsets instead of serving another range", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: false },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    // Non-finite AND finite-but-invalid: a clamp or truncation would return a
    // different range while looking like a correct answer.
    for (const from of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -2,
      0,
      1.5,
    ]) {
      await assert.rejects(
        () =>
          manager?.readFile({ relPath: "facts/alice.md", from }) ??
          Promise.resolve(),
        /from must be a positive integer/,
        `from: ${String(from)} must be rejected`,
      );
    }
    for (const lines of [Number.NaN, -1, 0, 0.5]) {
      await assert.rejects(
        () =>
          manager?.readFile({ relPath: "facts/alice.md", lines }) ??
          Promise.resolve(),
        /lines must be a positive integer/,
        `lines: ${String(lines)} must be rejected`,
      );
    }
    // A real range still works.
    const read = await manager?.readFile({
      relPath: "facts/alice.md",
      from: 2,
      lines: 1,
    });
    assert.equal(read?.text, "two");
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search keeps hits when the corpus sits under an `artifacts` ancestor", async () => {
  // <root>/artifacts/remnic is an ordinary corpus. Judging the ABSOLUTE hit
  // path would discard every result the daemon returned.
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "remnic-cap-ancestor-")),
  );
  const memoryDir = path.join(root, "artifacts", "remnic");
  const workspaceDir = path.join(root, "workspace");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await mkdir(path.join(memoryDir, "artifacts"), { recursive: true });
  await mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: false },
    search: {
      query: "q",
      count: 2,
      results: [
        {
          path: path.join(memoryDir, "facts", "a.md"),
          score: 0.9,
          snippet: "fact",
        },
        {
          path: path.join(memoryDir, "artifacts", "report.md"),
          score: 0.8,
          snippet: "artifact",
        },
      ],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const results = (await manager?.search("q")) ?? [];
    assert.deepEqual(
      results.map((hit) => hit.citation),
      [path.join("facts", "a.md")],
      "the ordinary hit survives and the corpus's own artifact is still excluded",
    );
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delegate search rejects an out-of-range maxResults instead of coercing it", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: false },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    for (const maxResults of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => manager?.search("q", { maxResults }) ?? Promise.resolve(),
        /maxResults must be a non-negative integer/,
        `maxResults: ${String(maxResults)} must be rejected`,
      );
    }
    // The exact-zero short circuit and ordinary budgets are unchanged.
    assert.deepEqual(await manager?.search("q", { maxResults: 0 }), []);
    assert.deepEqual(await manager?.search("q", { maxResults: 3 }), []);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a spent caller budget skips the health probe instead of overrunning it", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // The lifecycle flushes share one deadline. Starting a fresh probe with its
  // own full timeout would overrun the hook and get it abandoned before the
  // buffer drains.
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: false },
  });
  try {
    // A controllable clock so the cached snapshot can be aged out without a
    // test-only hook in production code.
    let clock = 1_000;
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      now: () => clock,
    });
    // A real budget probes once and caches the daemon's flat posture.
    assert.equal(
      await built.resolveScopedNamespace(undefined, 5_000),
      undefined,
    );
    assert.equal(
      stub.calls.filter((call) => call.pathname.includes("/health")).length,
      1,
    );
    // Snapshot expired, budget spent: no request is started (it would overrun
    // the shared deadline) AND an unscoped call fails closed, because the
    // posture on hand was never confirmed by this call.
    clock += 10 * 60_000;
    await assert.rejects(
      () => built.resolveScopedNamespace(undefined, 0),
      /namespace posture could not be confirmed/,
    );
    assert.equal(
      stub.calls.filter((call) => call.pathname.includes("/health")).length,
      1,
      "no second probe once the shared deadline is gone",
    );
    // An explicit scope is the caller's own and still resolves unprobed.
    assert.equal(await built.resolveScopedNamespace("team-a", 0), "team-a");
    assert.equal(
      stub.calls.filter((call) => call.pathname.includes("/health")).length,
      1,
    );
    // With budget again, it re-probes and the unscoped call works.
    assert.equal(
      await built.resolveScopedNamespace(undefined, 5_000),
      undefined,
    );
    assert.equal(
      stub.calls.filter((call) => call.pathname.includes("/health")).length,
      2,
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a spent budget skips the authorization probe too", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // The remaining-budget argument must reach the authorization probe, not stop
  // at health: its own fixed timeout would overrun a nearly-spent flush.
  const stub = await startDaemonStub({
    health: {
      ...healthyDaemon(memoryDir),
      namespacesEnabled: true,
      defaultNamespace: "default",
    },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    const budgets: Array<number | undefined> = [];
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
      verifyNamespaceAuthorization: async (_namespace, timeoutMs) => {
        budgets.push(timeoutMs);
        return true;
      },
    });
    // Health is already cached by this first call, so the spent-budget path
    // below is exercised against the authorization probe specifically.
    assert.equal(
      await built.resolveScopedNamespace(undefined, 5_000),
      "default",
    );
    assert.equal(budgets.length, 1, "the caller's budget reaches the probe");
    const billed = budgets[0];
    assert.ok(
      typeof billed === "number" && billed > 0 && billed <= 5_000,
      `the probe got what the posture probe left, not a fresh budget: ${String(billed)}`,
    );

    const fresh = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
      verifyNamespaceAuthorization: async () => {
        throw new Error("must not probe once the deadline is spent");
      },
    });
    await fresh.resolveScopedNamespace(undefined, 5_000).catch(() => undefined);
    // A spent budget cannot revalidate, and an unscoped request will not run
    // on an unconfirmed posture - so it fails closed WITHOUT reaching the
    // authorization probe (which would throw if it were attempted).
    await assert.rejects(
      () => fresh.resolveScopedNamespace(undefined, 0),
      /namespace posture could not be confirmed/,
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a failed probe un-proves a previously flat posture", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // A flat daemon can restart PARTITIONED. Holding the old `false` through the
  // failure backoff would send an unbound search across the new corpus.
  let healthy = true;
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").includes("/health") && !healthy) {
      res.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        (req.url ?? "").includes("/health")
          ? { ...healthyDaemon(memoryDir), namespacesEnabled: false }
          : { query: "q", count: 0, results: [] },
      ),
    );
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let clock = 1_000;
  try {
    const built = createDelegateMemoryCapability({
      ...optionsFor(address.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
      now: () => clock,
    });
    // Proven flat: an absent namespace is safe.
    assert.equal(await built.resolveScopedNamespace(undefined), undefined);
    // The daemon comes back partitioned and health starts failing.
    healthy = false;
    clock += 10 * 60_000;
    await assert.rejects(
      () => built.resolveScopedNamespace(undefined),
      /default namespace is unknown/,
      "the stale flat posture must not survive a failed probe",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a probe failure un-proves the default namespace too", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // A partitioned daemon can change its default across a restart. A retained
  // stale default is NOT undefined, so it would slip past the unknown-posture
  // guard and bind a fresh session to the previous tenant.
  let healthy = true;
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").includes("/health") && !healthy) {
      res.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        (req.url ?? "").includes("/health")
          ? {
              ...healthyDaemon(memoryDir),
              namespacesEnabled: true,
              defaultNamespace: "tenant-a",
            }
          : { query: "q", count: 0, results: [] },
      ),
    );
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let clock = 1_000;
  try {
    const built = createDelegateMemoryCapability({
      ...optionsFor(address.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
      verifyNamespaceAuthorization: async () => true,
      now: () => clock,
    });
    assert.equal(await built.resolveScopedNamespace(undefined), "tenant-a");
    healthy = false;
    clock += 10 * 60_000;
    await assert.rejects(
      () => built.resolveScopedNamespace(undefined),
      /default namespace is unknown/,
      "the stale default must not bind a fresh session",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search rejects a malformed score and an invalid minScore", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: false },
    search: {
      query: "q",
      count: 1,
      results: [{ path: "facts/a.md", snippet: "no score" }],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    // A missing score is a protocol failure, not a zero ranking.
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve(),
      /malformed result entry/,
    );
    // An unusable threshold must not silently disable the filter.
    for (const minScore of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => manager?.search("q", { minScore }) ?? Promise.resolve(),
        /minScore must be a finite number/,
        `minScore: ${String(minScore)} must be rejected`,
      );
    }
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unscoped request revalidates the posture instead of trusting the cache", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // A flat posture LICENSES an unscoped request. A daemon that restarts
  // partitioned inside the TTL would otherwise keep that license with no probe
  // failure to notice it.
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: false },
  });
  try {
    let clock = 1_000;
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
      now: () => clock,
    });
    await built.resolveScopedNamespace(undefined);
    await built.resolveScopedNamespace(undefined);
    assert.equal(
      stub.calls.filter((call) => call.pathname.includes("/health")).length,
      2,
      "each unscoped resolution confirms the posture, cache or not",
    );
    // An EXPLICIT scope is the caller's own and the daemon enforces it, so it
    // rides the cache and costs no extra probe.
    const before = stub.calls.filter((call) =>
      call.pathname.includes("/health"),
    ).length;
    await built.resolveScopedNamespace("team-a");
    assert.equal(
      stub.calls.filter((call) => call.pathname.includes("/health")).length,
      before,
      "an explicit scope does not force a probe",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("the authorization probe names the operation the caller is performing", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  // A token may grant recall/observe/flush but not memory_search. Probing a
  // hard-coded operation would reject those locally before their own route
  // could authorize them.
  const stub = await startDaemonStub({
    health: {
      ...healthyDaemon(memoryDir),
      namespacesEnabled: true,
      defaultNamespace: "default",
    },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    const asked: Array<readonly string[] | undefined> = [];
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
      verifyNamespaceAuthorization: async (_ns, _timeout, operations) => {
        asked.push(operations);
        // Only memory_search is denied for this token.
        return !(operations ?? []).includes("memory_search");
      },
    });
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve(),
      /is not authorized for the delegate token/,
      "search names memory_search and is correctly refused",
    );
    // A flush-scoped resolution names its own operation and is allowed.
    assert.equal(
      await built.resolveScopedNamespace(undefined, undefined, [
        "lcm_compaction_flush",
      ]),
      "default",
    );
    assert.deepEqual(asked, [["memory_search"], ["lcm_compaction_flush"]]);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an invalid caller budget is rejected at the boundary", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: false },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 12.5]) {
      await assert.rejects(
        () => built.resolveScopedNamespace(undefined, timeoutMs),
        /timeoutMs must be a finite integer/,
        `timeoutMs: ${String(timeoutMs)} must be rejected`,
      );
    }
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a health-failure backoff is honored even by an unscoped request", async () => {
  // The posture is already unknown during the backoff, so an immediate second
  // probe cannot prove anything — it would just spend the hook budget on a
  // daemon that is down, once per recall/search/observe.
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ healthStatus: 500, health: {} });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir),
    );
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const probes = (): number =>
      stub.calls.filter((call) => call.pathname.includes("/health")).length;
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve(),
      /could not be confirmed/,
      "an unproven posture fails closed for an unscoped search",
    );
    const afterFirst = probes();
    assert.ok(afterFirst >= 1, "the first unscoped request probes");
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve(),
      /could not be confirmed/,
    );
    await assert.rejects(
      () => manager?.search("q") ?? Promise.resolve(),
      /could not be confirmed/,
    );
    assert.equal(
      probes(),
      afterFirst,
      "the failure backoff suppressed the repeat probes",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a zero-budget search is authorized before it answers empty", async () => {
  // Shrinking the requested count must not be a way to get a successful
  // answer for a namespace the session may not read.
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: {
      ...healthyDaemon(memoryDir),
      namespacesEnabled: true,
      defaultNamespace: "team",
    },
    search: { query: "q", count: 0, results: [] },
  });
  try {
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      verifyNamespaceAuthorization: async () => false,
    });
    const { manager } = await built.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    await assert.rejects(
      () => manager?.search("q", { maxResults: 0 }) ?? Promise.resolve(),
      /not authorized/,
      "a zero budget still runs the authorization gate",
    );
    assert.equal(
      stub.calls.filter((call) => call.pathname.includes("/memories/search"))
        .length,
      0,
      "and still makes no backend call",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("the posture and authorization probes share one deadline", async () => {
  // Billing each probe the full remaining budget lets namespace resolution
  // alone overrun a hook before its own request runs.
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: {
      ...healthyDaemon(memoryDir),
      namespacesEnabled: true,
      defaultNamespace: "default",
    },
    healthDelayMs: 300,
  });
  try {
    let authBudget: number | undefined;
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      resolveSearchNamespace: async () => undefined,
      verifyNamespaceAuthorization: async (_namespace, timeoutMs) => {
        authBudget = timeoutMs;
        return true;
      },
    });
    assert.equal(
      await built.resolveScopedNamespace(undefined, 1_000),
      "default",
    );
    assert.ok(
      typeof authBudget === "number" && authBudget <= 750,
      `the ~300ms posture probe came out of the shared 1000ms: ${String(authBudget)}`,
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an explicit scope needs no probe at all", async () => {
  // `requireScopedNamespace` returns an explicit scope untouched and the
  // daemon enforces it on the operation endpoint, so a cold health cache must
  // not spend the prompt deadline before the recall POST runs.
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir),
      verifyNamespaceAuthorization: async () => {
        throw new Error("an explicit scope must not be authorized client-side");
      },
    });
    assert.equal(await built.resolveScopedNamespace("team", 5_000), "team");
    assert.equal(
      stub.calls.filter((call) => call.pathname.includes("/health")).length,
      0,
      "no posture probe ran for an explicit scope",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a spent budget refuses an unverified substituted default", async () => {
  // The substituted default is an AUTHORIZATION fact. Running the hook under
  // it because the deadline ran out is fail-open: a partitioned daemon would
  // serve recall/observe/flush under a scope this token was never verified
  // for. A CACHED verdict still answers for free.
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: { ...healthyDaemon(memoryDir), namespacesEnabled: true, defaultNamespace: "default" },
  });
  try {
    let probes = 0;
    // A clock the posture probe advances past the caller's whole budget, so
    // the posture is FRESH but nothing is left for authorization — the only
    // shape that reaches this branch.
    let clock = 1_000_000;
    const built = createDelegateMemoryCapability({
      ...optionsFor(stub.port, memoryDir, workspaceDir, { now: () => clock }),
      resolveSearchNamespace: async () => undefined,
      verifyNamespaceAuthorization: async () => {
        probes += 1;
        return true;
      },
    });
    const spendBudgetDuringProbe = (): void => {
      clock += 400;
    };
    stub.onHealth = spendBudgetDuringProbe;
    await assert.rejects(
      () => built.resolveScopedNamespace(undefined, 300),
      /could not be verified within the caller's deadline/,
    );
    assert.equal(probes, 0, "and it did not send a doomed request either");

    // Once a verdict is cached, a spent budget rides it rather than refusing.
    stub.onHealth = undefined;
    assert.equal(await built.resolveScopedNamespace(undefined, 5_000), "default");
    assert.equal(probes, 1);
    stub.onHealth = spendBudgetDuringProbe;
    assert.equal(await built.resolveScopedNamespace(undefined, 300), "default");
    assert.equal(probes, 1, "the cached verdict answered without a probe");
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
