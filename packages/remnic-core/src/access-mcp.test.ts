/**
 * Regression tests for PR #396 reviewer findings on the MCP dispatcher.
 * All fixtures are synthetic — no real user data.
 *
 * Finding 2: Invalid `format` values must be rejected with a structured error,
 * not silently mapped to `undefined`.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramMcpServer } from "./access-mcp.js";
import { tokenCapabilityStore } from "./access-token-capabilities.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import { readPair, writePair } from "./contradiction/contradiction-review.js";
import type { StorageManager } from "./storage.js";

// ──────────────────────────────────────────────────────────────────────────
// Stub service — only implements the members EngramMcpServer actually touches.
// ──────────────────────────────────────────────────────────────────────────

function makeMockService(briefingFn?: () => Promise<unknown>): EngramAccessService {
  return {
    briefingEnabled: true,
    briefing: briefingFn ?? (() => Promise.resolve({ markdown: "", json: {}, sections: {}, window: {} })),
    recall: () => Promise.resolve({ context: "" }),
    recallExplain: () => Promise.resolve(null),
    store: () => Promise.resolve({ id: "synthetic-id", stored: true }),
    suggest: () => Promise.resolve({ id: "synthetic-id" }),
    memoryStore: () => Promise.resolve({
      schemaVersion: 1,
      operation: "memory_store",
      namespace: "default",
      dryRun: true,
      accepted: true,
      queued: false,
      status: "validated",
    }),
    suggestionSubmit: () => Promise.resolve({
      schemaVersion: 1,
      operation: "suggestion_submit",
      namespace: "default",
      dryRun: true,
      accepted: true,
      queued: false,
      status: "validated",
    }),
    daySum: () => Promise.resolve({ summary: "" }),
    memoryGet: () => Promise.resolve(null),
    memoryTimeline: () => Promise.resolve([]),
    entityGet: () => Promise.resolve(null),
    reviewQueueList: () => Promise.resolve({ items: [] }),
    observe: () => Promise.resolve({ ok: true }),
    lcmSearch: () => Promise.resolve({ results: [] }),
    lcmCompactionFlush: () => Promise.resolve({ enabled: true, flushed: true }),
    lcmCompactionRecord: () => Promise.resolve({ enabled: true, recorded: true }),
    memoryGovernanceRun: () => Promise.resolve({ ok: true }),
    identityAnchorGet: () => Promise.resolve(null),
    identityAnchorUpdate: () => Promise.resolve({ ok: true }),
    memoryIdentity: () => Promise.resolve(null),
    continuityAuditGenerate: () => Promise.resolve({ report: "" }),
    continuityIncidentOpen: () => Promise.resolve({ id: "synthetic-incident" }),
    continuityIncidentClose: () => Promise.resolve({ ok: true }),
    continuityIncidentList: () => Promise.resolve({ items: [] }),
    continuityLoopAddOrUpdate: () => Promise.resolve({ ok: true }),
    continuityLoopReview: () => Promise.resolve({ ok: true }),
    workTask: () => Promise.resolve({ ok: true }),
    workProject: () => Promise.resolve({ ok: true }),
    memorySummarizeHourly: () => Promise.resolve({ ok: true }),
    conversationIndexUpdate: () => Promise.resolve({ ok: true }),
    profilingReport: () => Promise.resolve({
      enabled: true,
      format: "json",
      traces: [],
      stats: {},
      bottleneck: null,
    }),
  } as unknown as EngramAccessService;
}

function makeRequest(format: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.briefing",
      arguments: { format },
    },
  };
}

function makeToolRequest(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Finding 2 (#396 new): invalid MCP briefing format values must be rejected
// ──────────────────────────────────────────────────────────────────────────

test("MCP briefing: valid format 'markdown' passes through to service", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "# Briefing\n", json: {}, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest("markdown"));
  assert.ok(called, "service.briefing should have been called for format=markdown");
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP briefing: valid format 'json' passes through to service", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "", json: { synthetic: true }, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest("json"));
  assert.ok(called, "service.briefing should have been called for format=json");
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP briefing: omitting format (undefined) passes through without error", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "# Briefing\n", json: {}, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest(undefined));
  assert.ok(called, "service.briefing should be called when format is absent");
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP briefing: invalid format 'xml' is rejected with isError=true", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "", json: {}, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest("xml"));
  assert.equal(called, false, "service.briefing must NOT be called for invalid format");
  const result = (response as Record<string, unknown> & { result?: { isError?: boolean; content?: { text: string }[] } }).result;
  assert.equal(result?.isError, true, "response must carry isError=true for format=xml");
  const text = result?.content?.[0]?.text ?? "";
  assert.match(text, /xml/i, "error message should reference the rejected value 'xml'");
});

test("MCP briefing: invalid format 'text' is rejected with isError=true", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "", json: {}, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest("text"));
  assert.equal(called, false, "service.briefing must NOT be called for invalid format");
  const result = (response as Record<string, unknown> & { result?: { isError?: boolean } }).result;
  assert.equal(result?.isError, true, "response must carry isError=true for format=text");
});

test("MCP briefing: arbitrary invalid format strings are rejected", async () => {
  const server = new EngramMcpServer(makeMockService());
  for (const bad of ["html", "plain", "csv", "XML"]) {
    const response = await server.handleRequest(makeRequest(bad));
    const result = (response as Record<string, unknown> & { result?: { isError?: boolean } }).result;
    assert.equal(result?.isError, true, `format="${bad}" should produce isError=true`);
  }
});

test("MCP maintenance: hourly summarization dispatches to the access service", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    memorySummarizeHourly: async () => {
      called = true;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(makeToolRequest("engram.memory_summarize_hourly"));

  assert.equal(called, true, "memorySummarizeHourly should be dispatched");
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP memory write tools reject malformed arguments before dispatch", async () => {
  for (const toolName of ["engram.memory_store", "engram.suggestion_submit"]) {
    for (const badArgs of [
      {
        content: "valid durable content",
        category: "fact",
        confidence: "0.9",
        dryRun: true,
      },
      {
        content: "valid durable content",
        category: "fact",
        tags: ["project", 123],
        dryRun: true,
      },
      {
        content: "valid durable content",
        category: "fact",
        dryRun: true,
        unknownField: "must be rejected",
      },
    ]) {
      let dispatched = false;
      const service = {
        ...makeMockService(),
        memoryStore: async () => {
          dispatched = true;
          return {
            schemaVersion: 1,
            operation: "memory_store",
            namespace: "default",
            dryRun: true,
            accepted: true,
            queued: false,
            status: "validated",
          };
        },
        suggestionSubmit: async () => {
          dispatched = true;
          return {
            schemaVersion: 1,
            operation: "suggestion_submit",
            namespace: "default",
            dryRun: true,
            accepted: true,
            queued: false,
            status: "validated",
          };
        },
      } as unknown as EngramAccessService;
      const server = new EngramMcpServer(service);

      const response = await server.handleRequest(makeToolRequest(toolName, badArgs));
      const result = (response as Record<string, unknown> & {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      }).result;

      assert.equal(result?.isError, true, `${toolName} should reject ${JSON.stringify(badArgs)}`);
      assert.equal(dispatched, false, `${toolName} should not dispatch malformed writes`);
    }
  }
});

test("MCP memory write tools admit project-shaped category aliases (#2780)", async () => {
  for (const toolName of ["engram.memory_store", "engram.suggestion_submit"]) {
    let received: Record<string, unknown> | undefined;
    const service = {
      ...makeMockService(),
      memoryStore: async (req: Record<string, unknown>) => {
        received = req;
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "default",
          dryRun: true,
          accepted: true,
          queued: false,
          status: "validated",
        };
      },
      suggestionSubmit: async (req: Record<string, unknown>) => {
        received = req;
        return {
          schemaVersion: 1,
          operation: "suggestion_submit",
          namespace: "default",
          dryRun: true,
          accepted: true,
          queued: false,
          status: "validated",
        };
      },
    } as unknown as EngramAccessService;
    const server = new EngramMcpServer(service);

    const response = await server.handleRequest(
      makeToolRequest(toolName, {
        content: "valid durable content",
        category: "project_state",
        dryRun: true,
      })
    );
    const result = (response as Record<string, unknown> & { result?: { isError?: boolean } }).result;

    assert.equal(result?.isError, false, `${toolName} must admit project-shaped category aliases`);
    assert.equal(
      received?.category,
      "project_state",
      `${toolName} must forward the alias; the write surface coerces it to "fact"`
    );
  }
});

test("MCP memory_store invalid category error names valid categories and the fact hint (#2780)", async () => {
  const server = new EngramMcpServer(makeMockService());

  const response = await server.handleRequest(
    makeToolRequest("engram.memory_store", {
      content: "valid durable content",
      category: "vibe",
      dryRun: true,
    })
  );
  const result = (response as Record<string, unknown> & {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  }).result;

  assert.equal(result?.isError, true, "an unrelated invalid category must still reject");
  const text = (result?.content ?? []).map((part) => part.text ?? "").join("\n");
  assert.match(text, /must be one of: /, "error must name the valid categories");
  assert.match(text, /reasoning_trace/, "the full valid list must be present");
  assert.match(text, /for project state\/facts use "fact"/, "error must carry the fact hint");
});

test("MCP write tools accept and forward client-injected cwd/projectTag (#1434)", async () => {
  for (const toolName of ["engram.memory_store", "engram.suggestion_submit"]) {
    let received: Record<string, unknown> | undefined;
    const service = {
      ...makeMockService(),
      memoryStore: async (args: Record<string, unknown>) => {
        received = args;
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "default",
          dryRun: true,
          accepted: true,
          queued: false,
          status: "validated",
        };
      },
      suggestionSubmit: async (args: Record<string, unknown>) => {
        received = args;
        return {
          schemaVersion: 1,
          operation: "suggestion_submit",
          namespace: "default",
          dryRun: true,
          accepted: true,
          queued: false,
          status: "validated",
        };
      },
    } as unknown as EngramAccessService;
    const server = new EngramMcpServer(service);

    const response = await server.handleRequest(
      makeToolRequest(toolName, {
        content: "valid durable content",
        category: "fact",
        dryRun: true,
        cwd: "/home/dev/project-x",
        projectTag: "Acme/Webshop",
      }),
    );
    const result = (response as Record<string, unknown> & {
      result?: { isError?: boolean };
    }).result;

    assert.equal(result?.isError, false, `${toolName} should accept cwd/projectTag`);
    assert.equal(received?.cwd, "/home/dev/project-x", `${toolName} must forward cwd`);
    assert.equal(received?.projectTag, "Acme/Webshop", `${toolName} must forward projectTag`);
  }
});

test("MCP write tools still reject genuinely-unknown keys after the cwd fix (#1434)", async () => {
  let dispatched = false;
  const service = {
    ...makeMockService(),
    memoryStore: async () => {
      dispatched = true;
      return {
        schemaVersion: 1,
        operation: "memory_store",
        namespace: "default",
        dryRun: true,
        accepted: true,
        queued: false,
        status: "validated",
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(
    makeToolRequest("engram.memory_store", {
      content: "valid durable content",
      category: "fact",
      dryRun: true,
      cwd: "/ok",
      bogusField: "must still be rejected",
    }),
  );
  const result = (response as Record<string, unknown> & {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  }).result;
  assert.equal(result?.isError, true, "unknown keys must still be rejected");
  assert.equal(dispatched, false, "malformed write must not dispatch");
});

test("MCP capsule tools tolerate client-injected cwd/projectTag (#1434)", async () => {
  for (const toolName of [
    "engram.capsule_list",
    "engram.capsule_export",
    "engram.capsule_import",
  ]) {
    const service = {
      ...makeMockService(),
      capsuleList: async () => ({ capsules: [] }),
      capsuleExport: async () => ({ exported: true }),
      capsuleImport: async () => ({ imported: true }),
    } as unknown as EngramAccessService;
    const server = new EngramMcpServer(service);
    const args: Record<string, unknown> = { cwd: "/x", projectTag: "t" };
    if (toolName === "engram.capsule_export") args.name = "cap-1";
    if (toolName === "engram.capsule_import") args.archivePath = "/tmp/a.capsule.json.gz";
    const response = await server.handleRequest(makeToolRequest(toolName, args));
    const result = (response as Record<string, unknown> & {
      result?: { isError?: boolean };
    }).result;
    assert.equal(result?.isError, false, `${toolName} should tolerate cwd/projectTag`);
  }
});

test("MCP capsule list tolerates client-injected sessionKey (#1513)", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    capsuleList: async (args: Record<string, unknown>) => {
      received = args;
      return { capsules: [] };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.capsule_list", {
      namespace: "team",
      sessionKey: "pi-injected-session",
      cwd: "/x",
      projectTag: "t",
    }),
  );

  assert.deepEqual(received, {
    namespace: "team",
    principal: undefined,
  });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP capsule list derives namespace principal from client-injected sessionKey (#1513)", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-mcp-capsule-list-session-principal",
      namespacesEnabled: true,
      defaultNamespace: "default",
      principalFromSessionKeyMode: "map",
      principalFromSessionKeyRules: [{ match: "pi-session", principal: "pi-agent" }],
      namespacePolicies: [
        { name: "team", readPrincipals: ["pi-agent"], writePrincipals: [] },
      ],
    }),
    capsuleList: async (args: Record<string, unknown>) => {
      received = args;
      return { capsules: [] };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.capsule_list", {
      namespace: "team",
      sessionKey: "pi-session",
    }),
  );

  assert.deepEqual(received, {
    namespace: "team",
    principal: "pi-agent",
  });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP session override is injected only into tools that accept sessionKey", async () => {
  let capsuleListArgs: Record<string, unknown> | undefined;
  let observeArgs: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-mcp-session-override-test",
      namespacesEnabled: true,
      defaultNamespace: "default",
      principalFromSessionKeyMode: "map",
      principalFromSessionKeyRules: [{ match: "adapter-session", principal: "adapter-agent" }],
    }),
    capsuleList: async (args: Record<string, unknown>) => {
      capsuleListArgs = args;
      return { capsules: [] };
    },
    observe: async (args: Record<string, unknown>) => {
      observeArgs = args;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const capsuleResponse = await server.handleRequest(
    makeToolRequest("engram.capsule_list"),
    { sessionKeyOverride: "adapter-session" },
  );
  const observeResponse = await server.handleRequest(
    makeToolRequest("engram.observe", {
      messages: [{ role: "user", content: "hello" }],
    }),
    { sessionKeyOverride: "adapter-session" },
  );

  assert.deepEqual(capsuleListArgs, {
    namespace: undefined,
    principal: "adapter-agent",
  });
  assert.equal(observeArgs?.sessionKey, "adapter-session");
  assert.equal(observeArgs?.skipExtraction, false);
  const observeMessages = observeArgs?.messages as Array<{ role: string; content: string }>;
  assert.equal(observeMessages?.length, 1);
  assert.equal(observeMessages?.[0]?.role, "user");
  assert.equal(observeMessages?.[0]?.content, "hello");
  assert.equal((capsuleResponse as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
  assert.equal((observeResponse as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP memory_get advertises sessionKey so the override reaches the resolver (#1582)", async () => {
  // The engram.memory_get inputSchema must advertise sessionKey, otherwise
  // toolAcceptsArgument skips the override injection and an MCP caller citing a
  // [m:xxxx] handle gets "cannot be resolved without a session key" (codex
  // review). With the field advertised, the transport session key flows through
  // the registry op into service.memoryGet as the 4th positional arg.
  let receivedSessionKey: string | undefined;
  const service = {
    ...makeMockService(),
    memoryGet: (_id: string, _ns?: string, _principal?: string, sessionKey?: string) => {
      receivedSessionKey = sessionKey;
      return Promise.resolve({ found: false, namespace: "default" });
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.memory_get", { memoryId: "[m:4f2a]" }),
    { sessionKeyOverride: "adapter-session" },
  );

  assert.equal(receivedSessionKey, "adapter-session");
  assert.equal(
    (response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError,
    false,
  );
});

test("MCP capsule import forwards encrypted archive passphrase", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    capsuleImport: async (args: Record<string, unknown>) => {
      received = args;
      return { imported: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.capsule_import", {
      archivePath: "~/capsules/team.capsule.json.gz.enc",
      namespace: "team",
      mode: "overwrite",
      passphrase: "correct horse battery staple",
    }),
  );

  assert.deepEqual(received, {
    archivePath: path.join(os.homedir(), "capsules/team.capsule.json.gz.enc"),
    namespace: "team",
    principal: undefined,
    mode: "overwrite",
    passphrase: "correct horse battery staple",
  });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP contradiction scan uses writable namespace resolver", async () => {
  const resolverCalls: Array<{ namespace: string | undefined; principal: string | undefined }> = [];
  const storage = {
    readAllMemories: async () => [],
  } as unknown as StorageManager;
  const service = {
    ...makeMockService(),
    storageRef: storage,
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-mcp-contradiction-scan-test",
      namespacesEnabled: true,
      defaultNamespace: "default",
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 10,
      },
    }),
    memoryDir: "/tmp/remnic-mcp-contradiction-scan-test",
    embeddingLookupFactoryRef: undefined,
    localLlmRef: null,
    fallbackLlmRef: null,
    getReadableStorageForNamespace: async () => {
      throw new Error("readable resolver must not authorize contradiction scan writes");
    },
    getWritableStorageForNamespace: async (namespace: string | undefined, principal: string | undefined) => {
      resolverCalls.push({ namespace, principal });
      return { namespace: namespace ?? "default", storage };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service, { principal: "writer" });

  const response = await server.handleRequest(
    makeToolRequest("engram.contradiction_scan_run", { namespace: "team" }),
  );

  const result = (response as Record<string, unknown> & {
    result?: { isError?: boolean; structuredContent?: { scanned?: number } };
  }).result;
  assert.equal(result?.isError, false);
  assert.equal(result?.structuredContent?.scanned, 0);
  assert.deepEqual(resolverCalls, [{ namespace: "team", principal: "writer" }]);
});

test("MCP review list uses readable namespace resolver", async () => {
  const resolverCalls: Array<{ namespace: string | undefined; principal: string | undefined }> = [];
  const storage = {
    readAllMemories: async () => [],
  } as unknown as StorageManager;
  const service = {
    ...makeMockService(),
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-mcp-review-list-test",
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryDir: "/tmp/remnic-mcp-review-list-test",
    getReadableStorageForNamespace: async (namespace: string | undefined, principal: string | undefined) => {
      resolverCalls.push({ namespace, principal });
      throw new EngramAccessInputError(`namespace is not readable: ${namespace}`);
    },
    storageRef: storage,
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service, { principal: "reader" });

  const response = await server.handleRequest(
    makeToolRequest("engram.review_list", { namespace: "team" }),
  );

  const result = (response as Record<string, unknown> & {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  }).result;
  assert.equal(result?.isError, true);
  assert.match(result?.content?.[0]?.text ?? "", /namespace is not readable: team/);
  assert.deepEqual(resolverCalls, [{ namespace: "team", principal: "reader" }]);
});

test("MCP default review list includes legacy unscoped pairs without mutating storage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mcp-review-list-default-"));
  try {
    const legacy = writePair(dir, {
      memoryIds: ["legacy-a", "legacy-b"],
      verdict: "contradicts",
      rationale: "legacy pending pair",
      confidence: 0.9,
      detectedAt: new Date().toISOString(),
    });
    const resolverCalls: Array<{ namespace: string | undefined; principal: string | undefined }> = [];
    const storage = {
      readAllMemories: async () => [],
    } as unknown as StorageManager;
    const service = {
      ...makeMockService(),
      configRef: parseConfig({
        memoryDir: dir,
        namespacesEnabled: true,
        defaultNamespace: "default",
      }),
      memoryDir: dir,
      getReadableStorageForNamespace: async (namespace: string | undefined, principal: string | undefined) => {
        resolverCalls.push({ namespace, principal });
        return { namespace: namespace ?? "default", storage };
      },
      storageRef: storage,
    } as unknown as EngramAccessService;
    const server = new EngramMcpServer(service, { principal: "reader" });

    const response = await server.handleRequest(makeToolRequest("engram.review_list"));
    const result = (response as Record<string, unknown> & {
      result?: {
        isError?: boolean;
        structuredContent?: {
          total?: number;
          pairs?: Array<{ pairId?: string; namespace?: string }>;
        };
      };
    }).result;
    assert.equal(result?.isError, false);
    assert.equal(result?.structuredContent?.total, 1);
    assert.equal(result?.structuredContent?.pairs?.[0]?.pairId, legacy.pairId);
    assert.equal(result?.structuredContent?.pairs?.[0]?.namespace, undefined);
    assert.equal(readPair(dir, legacy.pairId)?.namespace, undefined);
    assert.deepEqual(resolverCalls, [{ namespace: undefined, principal: "reader" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP maintenance: conversation index update sanitizes optional args", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    conversationIndexUpdate: async (args: Record<string, unknown>) => {
      received = args;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.conversation_index_update", {
      sessionKey: "session-1",
      hours: 12,
      embed: true,
    }),
  );

  assert.deepEqual(received, {
    sessionKey: "session-1",
    hours: 12,
    embed: true,
  });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP maintenance: conversation index update preserves omitted embed default", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    conversationIndexUpdate: async (args: Record<string, unknown>) => {
      received = args;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  await server.handleRequest(
    makeToolRequest("engram.conversation_index_update", {
      sessionKey: "session-1",
    }),
  );

  assert.deepEqual(received, {
    sessionKey: "session-1",
    hours: undefined,
    embed: undefined,
  });
});

test("MCP maintenance: conversation index update rejects non-string sessionKey", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    conversationIndexUpdate: async () => {
      called = true;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.conversation_index_update", {
      sessionKey: 123,
    }),
  );

  assert.equal(called, false);
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, true);
});

test("MCP observe rejects malformed message parts before dispatch", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    observe: async () => {
      called = true;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.observe", {
      sessionKey: "session-1",
      messages: [
        {
          role: "assistant",
          content: "Edited src/auth.ts.",
          parts: [{}],
        },
      ],
    }),
  );

  assert.equal(called, false);
  const result = (response as Record<string, unknown> & { result?: { isError?: boolean; content?: { text: string }[] } }).result;
  assert.equal(result?.isError, true);
  assert.match(result?.content?.[0]?.text ?? "", /kind/i);
});

test("MCP observe accepts nullable optional message-part fields", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    observe: async (request: Record<string, unknown>) => {
      received = request;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.observe", {
      sessionKey: "session-1",
      messages: [
        {
          role: "assistant",
          content: "Edited src/auth.ts.",
          parts: [
            {
              ordinal: null,
              kind: "file_write",
              payload: { path: "src/auth.ts" },
              toolName: null,
              filePath: "src/auth.ts",
              createdAt: null,
            },
          ],
        },
      ],
    }),
  );

  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
  const messages = received?.messages as Array<Record<string, unknown>> | undefined;
  const parts = messages?.[0]?.parts as Array<Record<string, unknown>> | undefined;
  assert.equal(parts?.[0]?.ordinal, null);
  assert.equal(parts?.[0]?.kind, "file_write");
});

test("MCP profiling report dispatches sanitized args to the access service", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    profilingReport: async (args: Record<string, unknown>) => {
      received = args;
      return { enabled: true, format: "json", traces: [], stats: {}, bottleneck: null };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("remnic.profiling_report", {
      format: "json",
      limit: 3,
    }),
  );

  assert.deepEqual(received, { format: "json", limit: 3 });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP LCM compaction flush dispatches sanitized args to the access service", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    lcmCompactionFlush: async (args: Record<string, unknown>) => {
      received = args;
      return { enabled: true, flushed: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("remnic.lcm_compaction_flush", {
      sessionKey: "pi:session",
      namespace: "work",
      cwd: "/workspace/project",
      projectTag: "Acme/Webshop",
    }),
  );

  assert.deepEqual(received, {
    sessionKey: "pi:session",
    namespace: "work",
    cwd: "/workspace/project",
    projectTag: "Acme/Webshop",
    authenticatedPrincipal: undefined,
  });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP extraction force-flush dispatches scope, deadline, and cancellation to the access service", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    extractionForceFlush: async (args: Record<string, unknown>) => {
      received = args;
      return { flushed: true, sessionKey: "pi:session", namespace: "work", effectiveNamespace: "work" };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);
  const abortController = new AbortController();

  const response = await server.handleRequest(
    makeToolRequest("remnic.extraction_force_flush", {
      sessionKey: "pi:session",
      namespace: "work",
      cwd: "/workspace/project",
      projectTag: "Acme/Webshop",
      deadlineMs: 1_900_000_000_000,
    }),
    { abortSignal: abortController.signal },
  );

  assert.deepEqual(received, {
    sessionKey: "pi:session",
    namespace: "work",
    cwd: "/workspace/project",
    projectTag: "Acme/Webshop",
    deadlineMs: 1_900_000_000_000,
    authenticatedPrincipal: undefined,
    onCommitted: undefined,
    abortSignal: abortController.signal,
  });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP tools/list exposes LCM compaction tools under remnic aliases", async () => {
  const server = new EngramMcpServer(makeMockService());

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const listed = ((response as Record<string, unknown>).result as { tools: Array<{ name: string }> }).tools.map(
    (tool) => tool.name,
  );

  assert.ok(listed.includes("remnic_lcm_compaction_flush"));
  assert.ok(listed.includes("engram.lcm_compaction_flush"));
  assert.ok(listed.includes("remnic_lcm_compaction_record"));
  assert.ok(listed.includes("engram.lcm_compaction_record"));
});

test("MCP LCM compaction record rejects invalid token counts before dispatch", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    lcmCompactionRecord: async () => {
      called = true;
      return { enabled: true, recorded: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.lcm_compaction_record", {
      sessionKey: "pi:session",
      tokensBefore: -1,
      tokensAfter: 800,
    }),
  );

  assert.equal(called, false);
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, true);
});

test("MCP profiling report rejects invalid argument types before dispatch", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    profilingReport: async () => {
      called = true;
      return { enabled: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const badFormat = await server.handleRequest(
    makeToolRequest("engram.profiling_report", {
      format: false,
    }),
  );
  const badLimit = await server.handleRequest(
    makeToolRequest("engram.profiling_report", {
      limit: "5",
    }),
  );

  assert.equal(called, false);
  assert.equal((badFormat as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, true);
  assert.equal((badLimit as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, true);
});

// ──────────────────────────────────────────────────────────────────────────
// Issue #1427: opt-out of legacy engram.* tool aliases on tools/list
// ──────────────────────────────────────────────────────────────────────────

function listToolNames(response: unknown): string[] {
  const tools = (response as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
  return tools.map((t) => t.name);
}

const TOOLS_LIST_REQUEST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

test("tools/list advertises remnic_* and engram.* by default (back-compat)", async () => {
  const server = new EngramMcpServer(makeMockService());
  const names = listToolNames(await server.handleRequest(TOOLS_LIST_REQUEST));
  assert.ok(names.includes("remnic_recall"), "canonical name present");
  assert.ok(names.includes("engram.recall"), "legacy alias present by default");
  const legacyCount = names.filter((n) => n.startsWith("engram.")).length;
  assert.ok(legacyCount > 0, "legacy aliases advertised by default");
});

test("tools/list omits engram.* aliases when emitLegacyTools is false", async () => {
  const server = new EngramMcpServer(makeMockService(), { emitLegacyTools: false });
  const names = listToolNames(await server.handleRequest(TOOLS_LIST_REQUEST));
  assert.ok(names.includes("remnic_recall"), "canonical name still present");
  assert.equal(
    names.filter((n) => n.startsWith("engram.")).length,
    0,
    "no engram.* aliases advertised when opted out",
  );
  // Every advertised tool uses the Anthropic-safe remnic_* prefix.
  assert.ok(names.every((n) => n.startsWith("remnic_")), "all advertised tools are canonical");
  assert.ok(names.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)), "Anthropic tool-name pattern");
});

test("emitLegacyTools=false still allows calling tools under BOTH names (advertising-only opt-out)", async () => {
  const server = new EngramMcpServer(makeMockService(), { emitLegacyTools: false });
  const advertised = await server.handleRequest(makeToolRequest("remnic_recall", { query: "hello" }));
  assert.notEqual(
    (advertised as { result?: { isError?: boolean } }).result?.isError,
    true,
    "advertised remnic_recall call succeeds",
  );
  const dotted = await server.handleRequest(makeToolRequest("remnic.recall", { query: "hello" }));
  assert.notEqual(
    (dotted as { result?: { isError?: boolean } }).result?.isError,
    true,
    "dotted remnic.recall call still dispatches",
  );
  const legacy = await server.handleRequest(makeToolRequest("engram.recall", { query: "hello" }));
  assert.notEqual(
    (legacy as { result?: { isError?: boolean } }).result?.isError,
    true,
    "legacy engram.recall call still works (callability preserved)",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Issue #1850 round 5 (finding 3): tools/list must reflect the token's ops scope
// ──────────────────────────────────────────────────────────────────────────

test("tools/list: deny-all (ops:[]) token sees NO tools (issue #1850 finding 3)", async () => {
  const server = new EngramMcpServer(makeMockService(), { emitLegacyTools: false });
  const names = await tokenCapabilityStore.run({ version: 1, ops: [] }, async () =>
    listToolNames(await server.handleRequest(TOOLS_LIST_REQUEST)),
  );
  assert.deepEqual(names, [], "a deny-all token must enumerate zero tools");
});

test("tools/list: ops-scoped token sees ONLY its permitted tools (issue #1850 finding 3)", async () => {
  const server = new EngramMcpServer(makeMockService(), { emitLegacyTools: false });
  const names = await tokenCapabilityStore.run({ version: 1, ops: ["recall", "memory_get"] }, async () =>
    listToolNames(await server.handleRequest(TOOLS_LIST_REQUEST)),
  );
  assert.ok(names.includes("remnic_recall"), "permitted recall tool advertised");
  assert.ok(names.includes("remnic_memory_get"), "permitted memory_get tool advertised");
  assert.ok(!names.includes("remnic_memory_store"), "non-permitted tool must NOT be advertised");
  assert.ok(!names.includes("remnic_observe"), "non-permitted tool must NOT be advertised");
  assert.equal(names.length, 2, "exactly the two permitted tools advertised");
});

test("tools/list: unrestricted token (ops axis absent) sees the FULL surface (unchanged)", async () => {
  const server = new EngramMcpServer(makeMockService(), { emitLegacyTools: false });
  // No capability context at all (stdio / direct call) ⇒ full surface.
  const noContext = listToolNames(await server.handleRequest(TOOLS_LIST_REQUEST));
  // Explicit-unrestricted record (version present, no ops axis) ⇒ same surface.
  const explicitUnrestricted = await tokenCapabilityStore.run({ version: 1 }, async () =>
    listToolNames(await server.handleRequest(TOOLS_LIST_REQUEST)),
  );
  assert.deepEqual(explicitUnrestricted, noContext, "unrestricted record sees the same surface as legacy/no-context");
  assert.ok(noContext.length > 10, "sanity: the full tool surface is non-trivial");
});

// ===========================================================================
// Issue #1850 round 9 — MCP review_resolve namespace allow-list gate.
// Mirror of the HTTP review/resolve namespace gate (access-http.test.ts).
// review_resolve selects its target BY pairId, so the pair's namespace comes
// from the record — NOT a request param the MCP-over-HTTP tools/call gate
// (toolAcceptsNamespace) already enforces, because this tool's schema carries
// no `namespace` property. A namespace-scoped bearer must NOT mutate a pair in
// a namespace outside its allow-list. Both canonical (remnic.*) and legacy
// (engram.*) tool-name aliases route through the SAME handler/gate.
// ===========================================================================

test("MCP review_resolve: namespace-scoped token cannot mutate a pair in a disallowed namespace (issue #1850 round 9)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mcp-review-resolve-scoped-"));
  const allowedPair = writePair(dir, {
    namespace: "ns_a",
    memoryIds: ["a-1", "a-2"],
    verdict: "contradicts",
    rationale: "pair in the allowed namespace",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
  });
  const deniedPair = writePair(dir, {
    namespace: "ns_b",
    memoryIds: ["b-1", "b-2"],
    verdict: "contradicts",
    rationale: "pair in a denied namespace",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
  });
  const storage = { dir } as unknown as StorageManager;
  const service = {
    ...makeMockService(),
    configRef: parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryDir: dir,
    storageRef: storage,
    getWritableStorageForNamespace: async (namespace: string | undefined) => ({
      namespace: namespace ?? "default",
      storage,
    }),
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service, { principal: "writer" });
  const readOutcome = (response: unknown): { isError: boolean; text: string } => {
    if (typeof response !== "object" || response === null || !("result" in response)) {
      return { isError: false, text: "" };
    }
    const result = response.result;
    if (typeof result !== "object" || result === null) return { isError: false, text: "" };
    const isError = "isError" in result && result.isError === true;
    let text = "";
    if ("content" in result && Array.isArray(result.content)) {
      const entry = result.content[0];
      if (entry != null && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
        text = entry.text;
      }
    }
    return { isError, text };
  };
  try {
    // ── scoped to ns_a: denied-namespace pair → isError (fail closed), NOT mutated ──
    const denied = await tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, async () =>
      readOutcome(await server.handleRequest(makeToolRequest("engram.review_resolve", { pairId: deniedPair.pairId, verb: "both-valid" }))),
    );
    assert.equal(denied.isError, true, "scoped resolve: a pair in an unlisted namespace must be denied");
    assert.match(denied.text, /ns_b/, "denial message names the forbidden namespace");
    assert.notEqual(
      readPair(dir, deniedPair.pairId)?.resolution,
      "both-valid",
      "scoped resolve: the denied pair must remain unresolved (no mutation leak)",
    );

    // ── scoped to ns_a: allowed-namespace pair → resolves, mutated ──
    const allowed = await tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, async () =>
      readOutcome(await server.handleRequest(makeToolRequest("engram.review_resolve", { pairId: allowedPair.pairId, verb: "both-valid" }))),
    );
    assert.equal(allowed.isError, false, "scoped resolve: a pair in the allowed namespace must succeed");
    assert.equal(
      readPair(dir, allowedPair.pairId)?.resolution,
      "both-valid",
      "scoped resolve: the allowed pair is marked resolved",
    );

    // ── canonical alias (remnic.review_resolve) routes through the SAME gate ──
    const deniedCanonical = writePair(dir, {
      namespace: "ns_b",
      memoryIds: ["b-3", "b-4"],
      verdict: "contradicts",
      rationale: "pair for canonical-alias denial",
      confidence: 0.9,
      detectedAt: new Date().toISOString(),
    });
    const deniedViaCanonical = await tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, async () =>
      readOutcome(await server.handleRequest(makeToolRequest("remnic.review_resolve", { pairId: deniedCanonical.pairId, verb: "both-valid" }))),
    );
    assert.equal(deniedViaCanonical.isError, true, "canonical alias remnic.review_resolve must also be gated");
    assert.match(deniedViaCanonical.text, /ns_b/, "canonical-alias denial names the forbidden namespace");
    assert.notEqual(
      readPair(dir, deniedCanonical.pairId)?.resolution,
      "both-valid",
      "canonical-alias denied pair must remain unresolved",
    );

    // ── unrestricted token (no namespaces axis): the denied-namespace pair is reachable ──
    const unrestrictedDenied = await tokenCapabilityStore.run({ version: 1 }, async () =>
      readOutcome(await server.handleRequest(makeToolRequest("engram.review_resolve", { pairId: deniedPair.pairId, verb: "both-valid" }))),
    );
    assert.equal(unrestrictedDenied.isError, false, "unrestricted token: the denied-namespace pair is reachable");
    assert.equal(
      readPair(dir, deniedPair.pairId)?.resolution,
      "both-valid",
      "unrestricted token resolves the previously-denied pair",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Issue #1850 round 10 — fleet-wide maintenance ops namespace gate.
// These ops run ACROSS ALL namespaces (or a global non-namespaced layer) and
// carry NO `namespace` arg, so the MCP tools/call effective-namespace
// chokepoint (toolAcceptsNamespace) never fires. The `fleetWide` flag on each
// op makes defineOperation's run wrapper reject a namespace-scoped token
// BEFORE the handler — no side effect on denial; unrestricted/legacy allowed.
// Both canonical (remnic.*) and legacy (engram.*) aliases route through the
// SAME gate.
// ===========================================================================

function readCallToolOutcome(response: unknown): { isError: boolean; text: string } {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return { isError: false, text: "" };
  }
  const result = response.result;
  if (typeof result !== "object" || result === null) return { isError: false, text: "" };
  const isError = "isError" in result && result.isError === true;
  let text = "";
  if ("content" in result && Array.isArray(result.content)) {
    const entry = result.content[0];
    if (entry != null && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
      text = entry.text;
    }
  }
  return { isError, text };
}

const FLEET_WIDE_MAINTENANCE_TOOLS = [
  "graph_edge_decay_run",
  "memory_summarize_hourly",
  "conversation_index_update",
  "live_connectors_run",
  "continuity_audit_generate",
  "shared_context_cross_signals_run",
  "shared_context_curate_daily",
  "compounding_weekly_synthesize",
  "compounding_promote_candidate",
  "compression_guidelines_optimize",
  "compression_guidelines_activate",
] as const;

test("MCP fleet-wide maintenance ops: namespace-scoped token denied for every op, no side effect (issue #1850 round 10)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mcp-fleetwide-scoped-"));
  let sideEffects = 0;
  // Every fleet-wide op that dispatches to a service method routes through
  // this tracker; graph_edge_decay_run short-circuits via graphEdgeDecayEnabled
  // false. Under a scoped token NONE may run — the guard throws first.
  const track = (): Promise<{ ok: true }> => { sideEffects += 1; return Promise.resolve({ ok: true }); };
  const service = {
    ...makeMockService(),
    configRef: parseConfig({ memoryDir: dir, graphEdgeDecayEnabled: false }),
    memoryDir: dir,
    memorySummarizeHourly: track,
    conversationIndexUpdate: track,
    liveConnectorsRun: track,
    continuityAuditGenerate: track,
    sharedContextCrossSignalsRun: track,
    sharedContextCurateDaily: track,
    compoundingWeeklySynthesize: track,
    compoundingPromoteCandidate: track,
    compressionGuidelinesOptimize: track,
    compressionGuidelinesActivate: track,
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service, { principal: "ops" });
  try {
    for (const tool of FLEET_WIDE_MAINTENANCE_TOOLS) {
      // Legacy alias (engra.*).
      const legacy = await tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, async () =>
        readCallToolOutcome(await server.handleRequest(makeToolRequest("engram." + tool))),
      );
      assert.equal(legacy.isError, true, `engram.${tool}: a namespace-scoped token must be denied`);
      assert.match(legacy.text, /across all namespaces/, `engram.${tool}: denial names the fleet-wide restriction`);
      // Canonical alias (remnic.*) routes through the SAME gate.
      const canonical = await tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, async () =>
        readCallToolOutcome(await server.handleRequest(makeToolRequest("remnic." + tool))),
      );
      assert.equal(canonical.isError, true, `remnic.${tool}: canonical alias must also be gated`);
    }
    assert.equal(sideEffects, 0, "no fleet-wide maintenance service method may run for a namespace-scoped token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP graph_edge_decay_run: unrestricted and legacy tokens reach the handler (issue #1850 round 10)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mcp-decay-unrestricted-"));
  try {
    const service = {
      ...makeMockService(),
      configRef: parseConfig({ memoryDir: dir, graphEdgeDecayEnabled: false }),
      memoryDir: dir,
    } as unknown as EngramAccessService;
    const server = new EngramMcpServer(service, { principal: "ops" });
    // Explicit-unrestricted record (version present, no namespaces axis).
    const unrestricted = await tokenCapabilityStore.run({ version: 1 }, async () =>
      readCallToolOutcome(await server.handleRequest(makeToolRequest("engram.graph_edge_decay_run"))),
    );
    assert.equal(unrestricted.isError, false, "unrestricted token reaches the handler");
    // Legacy / no ALS at all (cron, internal caller) — same path.
    const legacy = readCallToolOutcome(await server.handleRequest(makeToolRequest("remnic.graph_edge_decay_run")));
    assert.equal(legacy.isError, false, "legacy token (no ALS) reaches the handler");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function readMcpResult(response: unknown): Record<string, unknown> {
  assert.ok(response && typeof response === "object" && "result" in response);
  const result = response.result;
  assert.ok(result && typeof result === "object");
  return Object.fromEntries(Object.entries(result));
}

test("MCP external_wiki_search exposes aliases and dispatches the stable result", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mcp-external-wiki-"));
  await mkdir(path.join(rootDir, "wiki"), { recursive: true });
  await writeFile(
    path.join(rootDir, "INDEX.md"),
    "- [[wiki/retrieval|Retrieval Architecture]] - cited hybrid retrieval\n",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "wiki", "retrieval.md"),
    "# Retrieval Architecture\n\nHybrid retrieval keeps cited sources.\n",
    "utf8",
  );
  try {
    const service = {
      ...makeMockService(),
      configRef: {
        externalWikis: [{
          id: "reading",
          rootDir,
          enabled: true,
          pagesDir: "wiki",
          indexFile: "INDEX.md",
          indexInQmd: false,
          includeInDefaultRecall: false,
        }],
      },
    } as unknown as EngramAccessService;
    const server = new EngramMcpServer(service);

    const listed = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const listedResult = readMcpResult(listed);
    assert.ok(Array.isArray(listedResult.tools));
    const toolNames = listedResult.tools.flatMap((tool) =>
      tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string"
        ? [tool.name]
        : []
    );
    assert.ok(toolNames.includes("remnic_external_wiki_search"));
    assert.ok(toolNames.includes("engram.external_wiki_search"));

    let canonicalResult: unknown;
    for (const name of ["remnic_external_wiki_search", "engram.external_wiki_search", "remnic.external_wiki_search"]) {
      const response = await server.handleRequest(makeToolRequest(name, {
        query: "hybrid retrieval",
        limit: 3,
        wikiId: "reading",
        maxCharsPerHit: 400,
      }));
      const result = readMcpResult(response);
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent && typeof result.structuredContent === "object");
      if (canonicalResult === undefined) canonicalResult = result.structuredContent;
      else assert.deepEqual(result.structuredContent, canonicalResult);
    }
    assert.ok(canonicalResult && typeof canonicalResult === "object" && "hits" in canonicalResult);
    assert.ok(Array.isArray(canonicalResult.hits));
    assert.equal(canonicalResult.hits.length, 1);
    const firstHit = canonicalResult.hits[0];
    assert.ok(firstHit && typeof firstHit === "object" && "path" in firstHit);
    assert.equal(firstHit.path, "wiki/retrieval.md");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("MCP external_wiki_search rejects an empty query before service dispatch", async () => {
  let configRead = false;
  const service = {
    ...makeMockService(),
    get configRef() {
      configRead = true;
      return parseConfig({ memoryDir: os.tmpdir(), externalWikis: [] });
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(makeToolRequest("remnic.external_wiki_search", { query: "  " }));
  assert.equal(readMcpResult(response).isError, true);
  assert.equal(configRead, false);
});
