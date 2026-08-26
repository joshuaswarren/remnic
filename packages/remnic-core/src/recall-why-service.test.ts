/**
 * Service-binding tests for the recall-miss diagnosis (issue #3033).
 *
 * `recall-why.test.ts` covers the pure stage attribution. This file covers
 * the orchestrator binding: the namespace ACL gate, the expected-memory
 * lookup across readable namespaces, and — the reason the pipeline carries a
 * `degradationSink` at all — that a backend which fails MID-recall is
 * reported as `backend_unavailable` and never as an empty pipeline
 * (Review Prevention Checklist #22).
 *
 * All fixture data is synthetic.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import type { Orchestrator } from "./orchestrator.js";
import { runRecallWhy } from "./recall-why-service.js";
import { buildXraySnapshot, type RecallXraySnapshot } from "./recall-xray.js";
import type { SearchDegradation } from "./search/port.js";
import type { MemoryFile, PluginConfig } from "./types.js";

const QUERY = "what did we decide about the retention window?";

function memoryFile(overrides: Partial<MemoryFile["frontmatter"]> & { id: string }): MemoryFile {
  const { id, ...rest } = overrides;
  return {
    path: `facts/2026-01-02/${id}.md`,
    frontmatter: {
      id,
      category: "fact",
      created: "2026-01-02T00:00:00.000Z",
      updated: "2026-01-02T00:00:00.000Z",
      ...rest,
    },
    content: "Synthetic fixture content.",
  } as MemoryFile;
}

function emptySnapshot(query: string): RecallXraySnapshot {
  return buildXraySnapshot({
    query,
    results: [],
    headroomResults: [],
    appliedResults: [],
    appliedResultLimit: 4,
    budget: { chars: 4096, used: 0 },
    now: () => 1_700_000_000_000,
    snapshotIdGenerator: () => "00000000-0000-4000-8000-000000000000",
  });
}

interface StubOptions {
  config: PluginConfig;
  memories?: MemoryFile[];
  /** Degradations the stub pipeline pushes into the caller's sink. */
  degradations?: SearchDegradation[];
  qmdAvailable?: boolean;
  /** Thrown by the stub recall, to exercise the fault path. */
  recallError?: Error;
}

interface Stub {
  orchestrator: Orchestrator;
  /** Namespaces the expected-memory lookup actually read. */
  readNamespaces: string[];
  recallCalls: number;
  /** True when the service handed the pipeline a degradation sink. */
  sinkSupplied: boolean;
}

function makeStub(options: StubOptions): Stub {
  const stub: Stub = {
    readNamespaces: [],
    recallCalls: 0,
    sinkSupplied: false,
    orchestrator: undefined as unknown as Orchestrator,
  };
  stub.orchestrator = {
    config: options.config,
    qmd: { isAvailable: () => options.qmdAvailable ?? true },
    async recallWithXrayCapture(
      prompt: string,
      _sessionKey?: string,
      invocation?: { degradationSink?: SearchDegradation[] },
    ) {
      stub.recallCalls += 1;
      stub.sinkSupplied = Array.isArray(invocation?.degradationSink);
      // Stand in for the real pipeline: it fills the SAME array it was
      // handed, which is exactly what `options.degradationSink ?? []` in
      // recall-internal.ts makes possible.
      for (const degradation of options.degradations ?? []) {
        invocation?.degradationSink?.push(degradation);
      }
      if (options.recallError !== undefined) throw options.recallError;
      return { result: "", snapshot: emptySnapshot(prompt), recallStartedAt: 0 };
    },
    async getStorageForNamespace(namespace: string) {
      stub.readNamespaces.push(namespace);
      return { async readAllMemories() { return options.memories ?? []; } };
    },
  } as unknown as Orchestrator;
  return stub;
}

async function withConfig<T>(
  raw: Record<string, unknown>,
  run: (config: PluginConfig) => Promise<T>,
): Promise<T> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-why-svc-"));
  try {
    return await run(parseConfig({ memoryDir, ...raw }));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

const identityResolver = { resolveNamespace: (namespace?: string) => namespace ?? "default" };

// ─── backend failure is an outage, never an empty pipeline (#22) ───────────

test("a degradation raised mid-recall reports backend_unavailable, not zero candidates", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({
      config,
      // The availability probe passes; the failure happens during the recall.
      qmdAvailable: true,
      degradations: [{ backend: "qmd", code: "daemon_timeout", detail: "no response in 5000ms" }],
    });
    const response = await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY },
    );
    assert.equal(stub.sinkSupplied, true, "the service must hand the pipeline a degradation sink");
    assert.equal(response.reportFound, true);
    assert.equal(response.report?.ok, false);
    assert.equal(response.report?.failure?.reason, "backend_unavailable");
    assert.match(response.report?.failure?.detail ?? "", /qmd:daemon_timeout/);
    assert.match(response.report?.failure?.detail ?? "", /no response in 5000ms/);
    // Only the retrieval stage is reported: no downstream stage ran, so none
    // may claim it "considered 0".
    assert.deepEqual(response.report?.stages.map((s) => s.stage), ["retrieval"]);
    assert.match(response.summary ?? "", /backend_unavailable/);
  });
});

test("a partial vector-tier degradation is not an outage — lexical still answered", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({
      config,
      degradations: [{ backend: "qmd", code: "vector_tier_unavailable" }],
    });
    const response = await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY },
    );
    assert.equal(response.report?.ok, true, "a degraded-but-real result set is not a failure");
    assert.equal(response.report?.failure, undefined);
  });
});

test("a recall that throws reports the fault as an outage, carrying what it observed", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({
      config,
      degradations: [{ backend: "qmd", code: "subprocess_error" }],
      recallError: new Error("search subprocess exited with code 1"),
    });
    const response = await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY },
    );
    assert.equal(response.report?.ok, false);
    assert.match(response.report?.failure?.detail ?? "", /qmd:subprocess_error/);
    assert.match(response.report?.failure?.detail ?? "", /subprocess exited with code 1/);
  });
});

test("an unavailable backend is refused before the recall runs", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({ config, qmdAvailable: false });
    const response = await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY },
    );
    assert.equal(response.report?.ok, false);
    assert.equal(response.report?.failure?.reason, "backend_unavailable");
    assert.equal(stub.recallCalls, 0, "no point paying for a recall against a dead backend");
  });
});

test("an honest empty recall stays ok:true", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({ config });
    const response = await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY },
    );
    assert.equal(response.report?.ok, true);
    assert.equal(response.report?.failure, undefined);
    assert.equal(stub.recallCalls, 1, "one diagnosis costs exactly one recall");
  });
});

// ─── --expect resolution against the store ────────────────────────────────

test("--expect resolves an exact id and reports the stage that dropped it", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({
      config,
      memories: [
        memoryFile({ id: "fact-kept-0001" }),
        memoryFile({ id: "fact-gone-0002", status: "superseded" }),
      ],
    });
    const response = await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY, expect: "fact-gone-0002" },
    );
    assert.equal(response.report?.expectation?.matched, true);
    assert.equal(response.report?.expectation?.memoryId, "fact-gone-0002");
    assert.equal(response.report?.expectation?.stage, "policy-filter");
    assert.equal(response.report?.expectation?.reason, "status-filter");
    assert.equal(response.report?.expectation?.detail, "status=superseded");
  });
});

test("a memory with no frontmatter status is treated as active, not status-filtered", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({ config, memories: [memoryFile({ id: "fact-untagged-0003" })] });
    const response = await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY, expect: "fact-untagged-0003" },
    );
    assert.equal(response.report?.expectation?.matched, true);
    assert.notEqual(response.report?.expectation?.reason, "status-filter");
    assert.equal(response.report?.expectation?.reason, "not-a-candidate");
  });
});

test("an unmatched --expect says nothing matched rather than naming a stage falsely", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({ config, memories: [memoryFile({ id: "fact-kept-0001" })] });
    const response = await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY, expect: "fact-absent-9999" },
    );
    assert.equal(response.report?.expectation?.matched, false);
    assert.match(response.report?.expectation?.detail ?? "", /no stored memory matches/);
  });
});

// ─── namespace scope (rule 42 / checklist #30) ─────────────────────────────

test("a namespace the principal cannot read is refused without running a recall", async () => {
  await withConfig(
    {
      namespacesEnabled: true,
      namespacePolicies: [{ name: "team-beta", readPrincipals: ["beta-only"] }],
    },
    async (config) => {
      const stub = makeStub({ config, memories: [memoryFile({ id: "fact-secret-0001" })] });
      const response = await runRecallWhy(
        { orchestrator: stub.orchestrator, ...identityResolver },
        { query: QUERY, namespace: "team-beta", authenticatedPrincipal: "someone-else" },
      );
      assert.equal(response.reportFound, false, "an unreadable namespace yields no report");
      assert.equal(response.report, undefined);
      assert.equal(stub.recallCalls, 0);
      assert.deepEqual(stub.readNamespaces, [], "and no store in it may be read");
    },
  );
});

test("with namespaces on and no identity supplied the diagnosis refuses", async () => {
  await withConfig({ namespacesEnabled: true }, async (config) => {
    const stub = makeStub({ config });
    const response = await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY },
    );
    assert.equal(response.reportFound, false);
    assert.equal(stub.recallCalls, 0);
  });
});

test("the expected-memory lookup reads only the namespaces the recall is scoped to", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({ config, memories: [memoryFile({ id: "fact-kept-0001" })] });
    await runRecallWhy(
      { orchestrator: stub.orchestrator, ...identityResolver },
      { query: QUERY, namespace: "team-alpha", expect: "fact-kept-0001" },
    );
    assert.deepEqual(
      stub.readNamespaces,
      ["team-alpha"],
      "an explicitly scoped request must not scan any other namespace",
    );
  });
});

// ─── input validation (#1 / #45) ───────────────────────────────────────────

test("an empty or whitespace-only query is rejected before namespace resolution", async () => {
  await withConfig({ qmdEnabled: true }, async (config) => {
    const stub = makeStub({ config });
    for (const bad of ["", "   ", "\t"]) {
      await assert.rejects(
        () =>
          runRecallWhy(
            { orchestrator: stub.orchestrator, ...identityResolver },
            { query: bad },
          ),
        /query is required and must be non-empty/,
        `query ${JSON.stringify(bad)} must be rejected`,
      );
    }
    assert.equal(stub.recallCalls, 0);
  });
});
