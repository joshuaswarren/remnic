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
  close: () => Promise<void>;
};

type StubRoutes = {
  health?: unknown;
  /** A literal response body, for shapes `JSON.stringify` would normalize. */
  healthRaw?: string;
  healthStatus?: number;
  search?: unknown;
  searchStatus?: number;
};

async function startDaemonStub(routes: StubRoutes): Promise<DaemonStub> {
  const calls: RecordedCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const pathname = (req.url ?? "").split("?")[0] ?? "";
      calls.push({ pathname, body: raw ? JSON.parse(raw) : undefined });
      const isSearch = pathname.endsWith("/memories/search");
      const status = isSearch ? (routes.searchStatus ?? 200) : (routes.healthStatus ?? 200);
      res.writeHead(status, { "content-type": "application/json" });
      if (!isSearch && routes.healthRaw !== undefined) {
        // A literal body, so a test can send a 200 that is valid JSON but not
        // a record — the shape `?? {}` would otherwise paper over.
        res.end(routes.healthRaw);
        return;
      }
      const payload = isSearch ? routes.search : routes.health;
      res.end(JSON.stringify(payload ?? {}));
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
  return {
    port: address.port,
    calls,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

async function makeCorpus(): Promise<{ memoryDir: string; workspaceDir: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-delegate-cap-")));
  const memoryDir = path.join(root, "memory");
  const workspaceDir = path.join(root, "workspace");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await mkdir(path.join(memoryDir, "artifacts"), { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(memoryDir, "facts", "alice.md"), "one\ntwo\nthree\nfour\n");
  await writeFile(path.join(memoryDir, "artifacts", "report.md"), "secret artifact\n");
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
      resolveAuthToken: () => ({ token: "test-token", source: "REMNIC_AUTH_TOKEN" }),
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
    qmd: { enabled: true, active: true, degraded: false, debugStatus: "cli=true" },
  };
}

test.before(() =>
  initLogger({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, false),
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
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
    const searchCall = stub.calls.find((call) => call.pathname.endsWith("/memories/search"));
    // Headroom: artifacts and sub-minScore hits are dropped on this side, so
    // the daemon is asked for more than the caller's budget and the cap lands
    // on the FILTERED list.
    assert.deepEqual(searchCall?.body, { query: "alice", maxResults: 15, mode: "search" });
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
        "not-an-object",
      ],
    },
  });
  try {
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const results = await manager?.search("q", { minScore: 0.5 });
    assert.deepEqual(
      results?.map((result) => result.citation),
      [path.join("facts", "bob.md")],
      "artifacts are isolated, sub-threshold hits are dropped, non-objects are skipped",
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search scopes the namespace through the session resolver", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir), search: { results: [] } });
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
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await manager?.search("q", { sessionKey: "s1" });
    await manager?.search("q");
    const searches = stub.calls.filter((call) => call.pathname.endsWith("/memories/search"));
    assert.deepEqual(searches[0]?.body, { query: "q", mode: "search", namespace: "team-a" });
    assert.deepEqual(
      searches[1]?.body,
      { query: "q", mode: "search", namespace: "fallback-ns" },
      "a search with no session key falls back to the registration-wide namespace",
    );
    assert.deepEqual(seen, ["s1", undefined], "the host session key reaches the resolver");
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate refuses file-backed surfaces when the daemon serves another corpus", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(path.join(memoryDir, "..", "someone-elses-corpus")),
    search: { results: [{ path: "facts/alice.md", score: 0.5, snippet: "hit" }] },
  });
  try {
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await assert.rejects(
      () => manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
      /delegate readFile unavailable/,
      "reading a same-named local file would serve the wrong corpus",
    );
    assert.deepEqual(await built.listArtifacts(), [], "artifact listing is disabled too");
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await assert.rejects(
      () => manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
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
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir), searchStatus: 503, search: {} });
  try {
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const page = await manager?.readFile({ relPath: "facts/alice.md", from: 2, lines: 2 });
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const status = manager?.status();
    assert.equal(status?.backend, "qmd");
    assert.equal(status?.dbPath, memoryDir);
    assert.deepEqual(status?.vector, { enabled: true, available: true });
    assert.equal(await manager?.probeVectorAvailability(), true);
    assert.deepEqual(await manager?.probeEmbeddingAvailability(), { ok: true });
    assert.deepEqual(built.runtime.resolveMemoryBackendConfig({ cfg: {}, agentId: "main" }), {
      backend: "qmd",
      qmd: { command: "qmd" },
    });
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
      qmd: { enabled: true, active: true, degraded: true, debugStatus: "collection missing" },
    },
  });
  try {
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
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
    const healthCalls = () => stub.calls.filter((call) => call.pathname.endsWith("/health")).length;
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
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
    assert.equal(plan.relativePath, "state/plugins/openclaw-remnic/flush-plan.md");
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate publicArtifacts lists the corpus and degrades to empty on failure", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir) });
  try {
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const artifacts = await built.listArtifacts();
    assert.ok(artifacts.length > 0, "the shared corpus yields public artifacts");

    const missing = createDelegateMemoryCapability(
      optionsFor(stub.port, path.join(memoryDir, "does-not-exist"), workspaceDir),
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

    const promptBuilder = capability.promptBuilder as (p: { sessionKey?: string }) => string[] | null;
    assert.deepEqual(promptBuilder({ sessionKey: "s1" }), ["## Memory", "line"]);
    assert.deepEqual(
      seenSessionKeys,
      ["s1"],
      "the host session key reaches the seam, which owns peek-vs-consume",
    );
    assert.equal(promptBuilder({}), null, "a missing session key reads the default bucket");
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
      optionsFor(stub.port, memoryDir, workspaceDir, { allowPromptInjection: false }),
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
      registerDelegateMemoryCapability({}, optionsFor(stub.port, memoryDir, workspaceDir)),
    );
    assert.equal(stub.calls.length, 0, "nothing is probed when nothing can be registered");
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const page = await manager?.readFile({ relPath: "facts/alice.md" });
    assert.equal(page?.text.startsWith("one"), true, "a migrated default namespace is not foreign");
    assert.ok((await built.listArtifacts()).length > 0);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search forwards the host's ranking override", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir), search: { results: [] } });
  try {
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
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
  await writeFile(path.join(namespaceDir, "facts", "scoped.md"), "namespace fact\n");
  const stub = await startDaemonStub({ health: healthyDaemon(namespaceDir) });
  try {
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    // The daemon's hits are relative to ITS storage dir, so the read scope must
    // be rooted there, not on the configured corpus root.
    const page = await manager?.readFile({ relPath: "facts/scoped.md" });
    assert.equal(page?.text.trim(), "namespace fact");
    const artifacts = (await built.listArtifacts()) as Array<{ absolutePath?: string }>;
    assert.ok(
      artifacts.some((entry) => entry.absolutePath?.startsWith(namespaceDir)),
      "the active namespace's artifacts are listed",
    );
    assert.equal(
      artifacts.some((entry) => entry.absolutePath === path.join(memoryDir, "facts", "alice.md")),
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
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await manager?.search("q");
    const body = stub.calls.find((call) => call.pathname.endsWith("/memories/search"))?.body;
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
  const stub = await startDaemonStub({ health: healthyDaemon(memoryDir), search: { results: [] } });
  try {
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
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
      results: [{ path: path.join(otherDir, "facts", "scoped.md"), score: 0.9, snippet: "hit" }],
    },
  });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir, {
        resolveSearchNamespace: async () => "team-a",
      }),
    );
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const [hit] = (await manager?.search("q")) ?? [];
    assert.ok(hit, "the daemon returned a hit");
    const page = await manager?.readFile({ relPath: hit.path });
    assert.equal(page?.text.trim(), "team-a fact", "the host can open its own search hit");
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate refuses file-backed surfaces for a remote daemon with an identical path", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: healthyDaemon(memoryDir),
    search: { results: [{ path: "facts/alice.md", score: 0.5, snippet: "hit" }] },
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
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await assert.rejects(
      () => manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await assert.rejects(
      () => manager?.readFile({ relPath: "artifacts/report.md" }) ?? Promise.resolve(),
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const results = (await manager?.search("q", { maxResults: 2 })) ?? [];
    assert.deepEqual(
      results.map((hit) => hit.citation),
      [path.join("facts", "one.md"), path.join("facts", "two.md")],
      "a full page of real memories, and never more than the budget",
    );
    const searchCall = stub.calls.find((call) => call.pathname.includes("/memories/search"));
    assert.equal(
      (searchCall?.body as { maxResults?: number } | undefined)?.maxResults,
      6,
      "asks the daemon for headroom",
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
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    // Every entry point that consults health goes through the same refresh, so
    // three back-to-back handouts would mean three probes with no backoff.
    await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const healthCalls = stub.calls.filter((call) => call.pathname.includes("/health"));
    assert.equal(healthCalls.length, 1, "later handouts reuse the backoff, they do not re-probe");
    // And the malformed payload never becomes a corpus claim.
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await assert.rejects(
      () => manager?.readFile({ relPath: "facts/alice.md" }) ?? Promise.resolve(),
      /has not been confirmed/,
    );
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
