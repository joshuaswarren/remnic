import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import { readPair, writePair } from "./contradiction/contradiction-review.js";
import type { StorageManager } from "./storage.js";

test("HTTP contradiction scan uses writable namespace resolver", async () => {
  const resolverCalls: Array<{ namespace: string | undefined; principal: string | undefined }> = [];
  const storage = {
    readAllMemories: async () => [],
  } as unknown as StorageManager;
  const service = {
    storageRef: storage,
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-contradiction-scan-test",
      namespacesEnabled: true,
      defaultNamespace: "default",
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 10,
      },
    }),
    memoryDir: "/tmp/remnic-http-contradiction-scan-test",
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
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    principal: "writer",
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${status.port}/engram/v1/contradiction-scan`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ namespace: "team" }),
    });
    const body = await response.json() as { scanned?: number };

    assert.equal(response.status, 200);
    assert.equal(body.scanned, 0);
    assert.deepEqual(resolverCalls, [{ namespace: "team", principal: "writer" }]);
  } finally {
    await server.stop();
  }
});

test("HTTP review list uses readable namespace resolver", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-http-review-list-"));
  const resolverCalls: Array<{ namespace: string | undefined; principal: string | undefined }> = [];
  const service = {
    configRef: parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryDir: dir,
    getReadableStorageForNamespace: async (namespace: string | undefined, principal: string | undefined) => {
      resolverCalls.push({ namespace, principal });
      throw new EngramAccessInputError(`namespace is not readable: ${namespace}`);
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    principal: "reader",
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${status.port}/engram/v1/review/contradictions?namespace=team`, {
      headers: { authorization: "Bearer test-token" },
    });
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.match(body.error ?? "", /namespace is not readable: team/);
    assert.deepEqual(resolverCalls, [{ namespace: "team", principal: "reader" }]);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP default review list includes legacy unscoped pairs without mutating storage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-http-review-list-default-"));
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
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    principal: "reader",
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${status.port}/engram/v1/review/contradictions`, {
      headers: { authorization: "Bearer test-token" },
    });
    const body = await response.json() as {
      total?: number;
      pairs?: Array<{ pairId?: string; namespace?: string }>;
    };
    assert.equal(response.status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.pairs?.[0]?.pairId, legacy.pairId);
    assert.equal(body.pairs?.[0]?.namespace, undefined);
    assert.equal(readPair(dir, legacy.pairId)?.namespace, undefined);
    assert.deepEqual(resolverCalls, [{ namespace: undefined, principal: "reader" }]);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP review show hides namespace denial as pair_not_found", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-http-review-show-"));
  const pair = writePair(dir, {
    namespace: "team",
    memoryIds: ["team-a", "team-b"],
    verdict: "contradicts",
    rationale: "synthetic",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
  });
  const resolverCalls: Array<{ namespace: string | undefined; principal: string | undefined }> = [];
  const service = {
    configRef: parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryDir: dir,
    getReadableStorageForNamespace: async (namespace: string | undefined, principal: string | undefined) => {
      resolverCalls.push({ namespace, principal });
      throw new EngramAccessInputError(`namespace is not readable: ${namespace}`);
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    principal: "reader",
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${status.port}/engram/v1/review/contradictions/${pair.pairId}`, {
      headers: { authorization: "Bearer test-token" },
    });
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 404);
    assert.equal(body.error, "pair_not_found");
    assert.deepEqual(resolverCalls, [{ namespace: "team", principal: "reader" }]);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
