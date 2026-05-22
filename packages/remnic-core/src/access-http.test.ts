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

test("HTTP server rejects invalid constructor ports", () => {
  const service = {} as EngramAccessService;

  for (const port of [-1, 3.7, Number.NaN, Number.POSITIVE_INFINITY, 65536]) {
    assert.throws(
      () =>
        new EngramAccessHttpServer({
          service,
          port,
          authToken: "test-token",
          adminConsoleEnabled: false,
        }),
      /access HTTP port must be an integer from 0 to 65535/,
      `port ${port} should be rejected`,
    );
  }
});

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

test("HTTP offline snapshot forwards namespace and transfer options", async () => {
  const calls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
    includeTranscripts: boolean | undefined;
    includeContent: boolean | undefined;
  }> = [];
  const service = {
    offlineSyncSnapshot: async (options: {
      namespace?: string;
      principal?: string;
      includeTranscripts?: boolean;
      includeContent?: boolean;
    }) => {
      calls.push({
        namespace: options.namespace,
        principal: options.principal,
        includeTranscripts: options.includeTranscripts,
        includeContent: options.includeContent,
      });
      return {
        namespace: options.namespace ?? "default",
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date("2026-05-21T00:00:00Z").toISOString(),
        sourceId: "remote:test",
        includeTranscripts: options.includeTranscripts !== false,
        files: [],
      };
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/snapshot?namespace=team&include_transcripts=false&content=false`,
      { headers: { authorization: "Bearer test-token" } },
    );
    const body = await response.json() as { namespace?: string; includeTranscripts?: boolean; files?: unknown[] };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.includeTranscripts, false);
    assert.deepEqual(body.files, []);
    assert.deepEqual(calls, [{
      namespace: "team",
      principal: "reader",
      includeTranscripts: false,
      includeContent: false,
    }]);
  } finally {
    await server.stop();
  }
});

test("HTTP offline files forwards namespace and requested paths", async () => {
  const calls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
    includeTranscripts: boolean | undefined;
    paths: string[];
  }> = [];
  const service = {
    offlineSyncFiles: async (options: {
      namespace?: string;
      principal?: string;
      includeTranscripts?: boolean;
      paths: string[];
    }) => {
      calls.push({
        namespace: options.namespace,
        principal: options.principal,
        includeTranscripts: options.includeTranscripts,
        paths: options.paths,
      });
      return {
        namespace: options.namespace ?? "default",
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date("2026-05-21T00:00:00Z").toISOString(),
        sourceId: "remote:test",
        includeTranscripts: options.includeTranscripts !== false,
        files: [],
      };
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/files`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: "team",
          includeTranscripts: false,
          paths: ["facts/a.md"],
        }),
      },
    );
    const body = await response.json() as { namespace?: string; includeTranscripts?: boolean; files?: unknown[] };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.includeTranscripts, false);
    assert.deepEqual(body.files, []);
    assert.deepEqual(calls, [{
      namespace: "team",
      principal: "reader",
      includeTranscripts: false,
      paths: ["facts/a.md"],
    }]);
  } finally {
    await server.stop();
  }
});

test("HTTP offline file-content forwards range options and returns binary metadata", async () => {
  const calls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
    includeTranscripts: boolean | undefined;
    path: string;
    offset: number | undefined;
    length: number | undefined;
  }> = [];
  const service = {
    offlineSyncFileContent: async (options: {
      namespace?: string;
      principal?: string;
      includeTranscripts?: boolean;
      path: string;
      offset?: number;
      length?: number;
    }) => {
      calls.push({
        namespace: options.namespace,
        principal: options.principal,
        includeTranscripts: options.includeTranscripts,
        path: options.path,
        offset: options.offset,
        length: options.length,
      });
      return {
        namespace: options.namespace ?? "default",
        path: options.path,
        sha256: "a".repeat(64),
        bytes: 12,
        mtimeMs: 1234,
        offset: options.offset ?? 0,
        chunkBytes: 5,
        content: Buffer.from("hello"),
      };
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/file-content`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: "team",
          includeTranscripts: false,
          path: "state/memory-lifecycle-ledger.jsonl",
          offset: 8,
          length: 5,
        }),
      },
    );
    const body = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(body.toString("utf-8"), "hello");
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("x-remnic-namespace"), "team");
    assert.equal(response.headers.get("x-remnic-file-path"), "state%2Fmemory-lifecycle-ledger.jsonl");
    assert.equal(response.headers.get("x-remnic-file-sha256"), "a".repeat(64));
    assert.equal(response.headers.get("x-remnic-file-bytes"), "12");
    assert.equal(response.headers.get("x-remnic-file-mtime-ms"), "1234");
    assert.equal(response.headers.get("x-remnic-chunk-offset"), "8");
    assert.equal(response.headers.get("x-remnic-chunk-bytes"), "5");
    assert.deepEqual(calls, [{
      namespace: "team",
      principal: "reader",
      includeTranscripts: false,
      path: "state/memory-lifecycle-ledger.jsonl",
      offset: 8,
      length: 5,
    }]);
  } finally {
    await server.stop();
  }
});

test("HTTP offline snapshot rejects invalid boolean query values", async () => {
  let calls = 0;
  const service = {
    offlineSyncSnapshot: async () => {
      calls += 1;
      return {};
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/offline-sync/snapshot?include_transcripts=maybe`,
      { headers: { authorization: "Bearer test-token" } },
    );
    const body = await response.json() as { error?: string; code?: string };

    assert.equal(response.status, 400);
    assert.match(body.error ?? "", /include_transcripts must be one of: true, false/);
    assert.equal(body.code, "input_error");
    assert.equal(calls, 0);
  } finally {
    await server.stop();
  }
});

test("HTTP offline apply validates and forwards changesets", async () => {
  const calls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
    changeset: unknown;
  }> = [];
  const changeset = {
    format: "remnic.offline-sync.changeset.v1",
    schemaVersion: 1,
    createdAt: new Date("2026-05-21T00:00:00Z").toISOString(),
    sourceId: "laptop:test",
    includeTranscripts: true,
    changes: [],
  };
  const service = {
    offlineSyncApply: async (options: {
      namespace?: string;
      principal?: string;
      changeset: unknown;
    }) => {
      calls.push({
        namespace: options.namespace,
        principal: options.principal,
        changeset: options.changeset,
      });
      return {
        namespace: options.namespace ?? "default",
        appliedUpserts: 0,
        appliedDeletes: 0,
        skipped: 0,
        conflicts: [],
        currentFiles: [],
      };
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
    const response = await fetch(`http://127.0.0.1:${status.port}/remnic/v1/offline-sync/apply`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ namespace: "team", changeset }),
    });
    const body = await response.json() as { namespace?: string; appliedUpserts?: number };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.appliedUpserts, 0);
    assert.deepEqual(calls, [{
      namespace: "team",
      principal: "writer",
      changeset,
    }]);
  } finally {
    await server.stop();
  }
});

test("HTTP offline apply requires a changeset", async () => {
  let calls = 0;
  const service = {
    offlineSyncApply: async () => {
      calls += 1;
      return {};
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
    const response = await fetch(`http://127.0.0.1:${status.port}/engram/v1/offline-sync/apply`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ namespace: "team" }),
    });
    const body = await response.json() as { code?: string; details?: Array<{ field?: string; message?: string }> };

    assert.equal(response.status, 400);
    assert.equal(body.code, "validation_error");
    assert.equal(body.details?.[0]?.field, "changeset");
    assert.equal(calls, 0);

    const nullResponse = await fetch(`http://127.0.0.1:${status.port}/engram/v1/offline-sync/apply`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ namespace: "team", changeset: null }),
    });
    const nullBody = await nullResponse.json() as { code?: string; details?: Array<{ field?: string; message?: string }> };

    assert.equal(nullResponse.status, 400);
    assert.equal(nullBody.code, "validation_error");
    assert.equal(nullBody.details?.[0]?.field, "changeset");
    assert.equal(nullBody.details?.[0]?.message, "changeset is required");
    assert.equal(calls, 0);
  } finally {
    await server.stop();
  }
});
