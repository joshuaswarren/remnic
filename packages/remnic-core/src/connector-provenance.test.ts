/**
 * Phase 1 connector-provenance tests.
 *
 * Verifies that a server-resolved `sourceConnector` identity threads through
 * the memory_store and suggestion_submit write paths — from the MCP request
 * boundary, through the operation handler (where it overrides any client-
 * supplied value), down to YAML frontmatter on disk.
 *
 * All fixtures are synthetic — no real user data.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramMcpServer } from "./access-mcp.js";
import { getOperation } from "./access-boundary.js";
import { memoryStoreOperation } from "./access-operations.js";
import type {
  EngramAccessMemoryStoreRequest,
  EngramAccessRecallRequest,
  EngramAccessService,
  EngramAccessWriteResponse,
} from "./access-service.js";
import { StorageManager } from "./storage.js";

// ---------------------------------------------------------------------------
// Mock service that captures memoryStore calls
// ---------------------------------------------------------------------------

function makeCaptureService(): {
  captured: EngramAccessMemoryStoreRequest[];
  service: EngramAccessService;
} {
  const captured: EngramAccessMemoryStoreRequest[] = [];
  const service = {
    memoryStore: (
      req: EngramAccessMemoryStoreRequest,
    ): Promise<EngramAccessWriteResponse> => {
      captured.push(req);
      return Promise.resolve({
        schemaVersion: 1,
        operation: "memory_store",
        namespace: "default",
        dryRun: false,
        accepted: true,
        queued: false,
        status: "stored",
      });
    },
  } as unknown as EngramAccessService;
  return { captured, service };
}

function memoryStoreRequest(
  overrides: Record<string, unknown> = {},
): { jsonrpc: "2.0"; id: number; method: "tools/call"; params: Record<string, unknown> } {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.memory_store",
      arguments: {
        content: "The user prefers dark mode for all coding tools",
        schemaVersion: 1,
        idempotencyKey: `key-${overrides.idempotencyKey ?? Math.random().toString(36).slice(2)}`,
        ...overrides,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests 1–3: MCP layer threads sourceConnector to the service
// ---------------------------------------------------------------------------

test("memory_store via MCP with sourceConnector 'chatgpt' → service receives it", async () => {
  const { captured, service } = makeCaptureService();
  const server = new EngramMcpServer(service, { principal: "test" });

  await server.handleRequest(memoryStoreRequest(), {
    sourceConnector: "chatgpt",
  });

  assert.equal(captured.length, 1, "memoryStore should have been called once");
  assert.equal(
    captured[0]!.sourceConnector,
    "chatgpt",
    "service should receive the server-resolved sourceConnector",
  );
});

test("memory_store via MCP with sourceConnector 'codex-cli' → service receives it", async () => {
  const { captured, service } = makeCaptureService();
  const server = new EngramMcpServer(service, { principal: "test" });

  await server.handleRequest(memoryStoreRequest(), {
    sourceConnector: "codex-cli",
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.sourceConnector, "codex-cli");
});

test("memory_store via MCP with no sourceConnector (operator) → service receives undefined", async () => {
  const { captured, service } = makeCaptureService();
  const server = new EngramMcpServer(service, { principal: "test" });

  await server.handleRequest(memoryStoreRequest(), {});

  assert.equal(captured.length, 1);
  assert.equal(
    captured[0]!.sourceConnector,
    undefined,
    "operator calls should not carry a sourceConnector",
  );
});

test("recall operation forwards only the server-resolved connector", async () => {
  const captured: EngramAccessRecallRequest[] = [];
  const service = {
    recall: (request: EngramAccessRecallRequest) => {
      captured.push(request);
      return Promise.resolve({});
    },
  } as unknown as EngramAccessService;
  const recallOperation = getOperation("recall");
  assert.ok(recallOperation);

  await recallOperation.run(
    { query: "shared namespace query", sourceConnector: "spoofed-client" },
    { service, sourceConnector: "chatgpt" },
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.sourceConnector, "chatgpt");
});

// ---------------------------------------------------------------------------
// Test 4: client-supplied sourceConnector in args is IGNORED
// ---------------------------------------------------------------------------

test("client-supplied sourceConnector in args → IGNORED, server value wins", async () => {
  const captured: EngramAccessMemoryStoreRequest[] = [];
  const service = {
    memoryStore: (req: EngramAccessMemoryStoreRequest) => {
      captured.push(req);
      return Promise.resolve({
        schemaVersion: 1,
        operation: "memory_store",
        namespace: "default",
        dryRun: false,
        accepted: true,
        queued: false,
        status: "stored",
      } satisfies EngramAccessWriteResponse);
    },
  } as unknown as EngramAccessService;

  // Call the handler directly, simulating a malicious client that managed to
  // inject sourceConnector: "evil" into the parsed input. The handler must
  // override it with the server-resolved ctx.sourceConnector.
  await memoryStoreOperation.spec.handler(
    {
      content: "The user prefers vim over emacs",
      schemaVersion: 1,
      idempotencyKey: "evil-key",
      sourceConnector: "evil",
    } as unknown as Parameters<typeof memoryStoreOperation.spec.handler>[0],
    {
      service,
      sourceConnector: "chatgpt",
    },
  );

  assert.equal(captured.length, 1);
  assert.equal(
    captured[0]!.sourceConnector,
    "chatgpt",
    "server-resolved sourceConnector must override client-supplied value",
  );
});

// ---------------------------------------------------------------------------
// Tests 5–6: StorageManager.writeMemory persists sourceConnector to frontmatter
// ---------------------------------------------------------------------------

test("StorageManager.writeMemory with sourceConnector 'omp' → frontmatter contains it", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-connector-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory(
      "fact",
      "The user works from the Pacific time zone",
      { sourceConnector: "omp" },
    );

    const memory = await storage.getMemoryById(id);
    assert.ok(memory, "getMemoryById must find the just-written memory");
    assert.equal(
      memory!.frontmatter.sourceConnector,
      "omp",
      "frontmatter should contain the sourceConnector",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("StorageManager.writeMemory without sourceConnector → frontmatter omits it", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-connector-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory(
      "fact",
      "The user enjoys hiking on weekends",
      {},
    );

    const memory = await storage.getMemoryById(id);
    assert.ok(memory, "getMemoryById must find the just-written memory");
    assert.equal(
      memory!.frontmatter.sourceConnector,
      undefined,
      "frontmatter should omit sourceConnector when not provided",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("StorageManager classifies connector-attributed tool memories at write time", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-tool-scope-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory(
      "fact",
      "Use the search tool with a path argument.",
      { sourceConnector: "chatgpt" },
    );

    assert.equal((await storage.getMemoryById(id))?.frontmatter.toolScoped, true);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("StorageManager leaves unattributed tool-like memories unpartitioned", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-tool-scope-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory(
      "fact",
      "Use the search tool with a path argument.",
    );

    assert.equal((await storage.getMemoryById(id))?.frontmatter.toolScoped, undefined);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("StorageManager preserves an explicit structured tool classification", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-tool-scope-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory(
      "procedure",
      "Workflow for locating an implementation",
      { sourceConnector: "chatgpt", toolScoped: true },
    );

    assert.equal((await storage.getMemoryById(id))?.frontmatter.toolScoped, true);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});
test("StorageManager preserves connector partition metadata on artifacts", async () => {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "prov-artifact-tool-scope-"));
  try {
    const storage = new StorageManager(baseDir);
    await storage.ensureDirectories();
    const id = await storage.writeArtifact("Use the search tool with a path argument.", {
      sourceConnector: "chatgpt",
      toolScoped: true,
    });
    const artifact = (await storage.searchArtifacts("search tool", 10)).find(
      (candidate) => candidate.frontmatter.id === id,
    );
    assert.equal(artifact?.frontmatter.sourceConnector, "chatgpt");
    assert.equal(artifact?.frontmatter.toolScoped, true);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});
