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
      const payload = isSearch ? routes.search : routes.health;
      res.writeHead(status, { "content-type": "application/json" });
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
    memoryDir,
    workspaceDir,
    agentIds: ["generalist"],
    allowPromptInjection: true,
    peekPromptLines: () => null,
    configuredSearchBackend: "qmd",
    configuredQmdCommand: "qmd",
    searchTimeoutMs: 5_000,
    healthTimeoutMs: 5_000,
    ...overrides,
  };
}

const HEALTHY_DAEMON = {
  ok: true,
  memoryDir: "/daemon/memory",
  searchBackend: "qmd",
  qmdEnabled: true,
  qmd: { enabled: true, active: true, degraded: false, debugStatus: "cli=true" },
};

test.before(() =>
  initLogger({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, false),
);
test.after(() => resetLogger());

test("delegate search maps daemon hits into runtime results", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: HEALTHY_DAEMON,
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
    assert.deepEqual(searchCall?.body, { query: "alice", maxResults: 5 });
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search excludes artifact paths and honors minScore", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({
    health: HEALTHY_DAEMON,
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

test("delegate search forwards the configured namespace", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON, search: { results: [] } });
  try {
    const built = createDelegateMemoryCapability(
      optionsFor(stub.port, memoryDir, workspaceDir, { namespace: " team-a " }),
    );
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    await manager?.search("q");
    const searchCall = stub.calls.find((call) => call.pathname.endsWith("/memories/search"));
    assert.deepEqual(searchCall?.body, { query: "q", namespace: "team-a" });
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("delegate search surfaces a daemon failure instead of returning empty", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON, searchStatus: 503, search: {} });
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
  try {
    const built = createDelegateMemoryCapability(optionsFor(stub.port, memoryDir, workspaceDir));
    const { manager } = await built.runtime.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const status = manager?.status();
    assert.equal(status?.backend, "qmd");
    assert.equal(status?.dbPath, "/daemon/memory", "the daemon's memoryDir wins over the local one");
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
  try {
    const registered: Record<string, unknown> = {};
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
        peekPromptLines: (sessionKey) => (sessionKey === "s1" ? ["## Memory", "line"] : null),
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
      promptBuilder({ sessionKey: "s1" }),
      ["## Memory", "line"],
      "the capability builder only peeks — the section builder owns the destructive read",
    );
    assert.equal(promptBuilder({}), null);
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("registerDelegateMemoryCapability omits promptBuilder when injection is disabled", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
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
  const stub = await startDaemonStub({ health: HEALTHY_DAEMON });
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
