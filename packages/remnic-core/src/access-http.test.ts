import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import { readPair, writePair } from "./contradiction/contradiction-review.js";
import { projectTagProjectId } from "./coding/coding-namespace.js";
import { OFFLINE_SYNC_MAX_MTIME_MS } from "./offline-sync.js";
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

test("parseConfig validates agentAccessHttp.port bounds and CLI strings", () => {
  for (const [input, expected] of [
    [0, 0],
    [4318, 4318],
    [65535, 65535],
    ["5555", 5555],
  ] as const) {
    const parsed = parseConfig({ agentAccessHttp: { port: input } });
    assert.equal(parsed.agentAccessHttp.port, expected);
  }

  for (const port of [
    -1,
    3.7,
    65536,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "not-a-port",
  ]) {
    assert.throws(
      () => parseConfig({ agentAccessHttp: { port } }),
      /agentAccessHttp\.port must be an integer from 0 to 65535/,
      `port ${String(port)} should be rejected`,
    );
  }
});

test("HTTP memory browse rejects malformed pagination and sort query values", async () => {
  const calls: unknown[] = [];
  const service = {
    memoryBrowse: async (request: unknown) => {
      calls.push(request);
      return { total: 0, memories: [] };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    for (const query of ["limit=10abc", "offset=1.5", "limit=0", "sort=udpated_desc"]) {
      const response = await fetch(`http://127.0.0.1:${status.port}/engram/v1/memories?${query}`, {
        headers: { authorization: "Bearer test-token" },
      });
      assert.equal(response.status, 400, `${query} should be rejected`);
    }
    assert.equal(calls.length, 0, "invalid queries must fail before calling memoryBrowse");

    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/memories?limit=10&offset=1&sort=updated_desc`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      {
        query: undefined,
        status: undefined,
        category: undefined,
        namespace: undefined,
        authenticatedPrincipal: undefined,
        sort: "updated_desc",
        limit: 10,
        offset: 1,
      },
    ]);
  } finally {
    await server.stop();
  }
});

test("HTTP admin console assets are public but API routes require bearer authentication", async () => {
  const service = {} as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
  });

  const status = await server.start();
  try {
    const shell = await fetch(`http://127.0.0.1:${status.port}/remnic/ui/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /Remnic Admin Console/);

    const app = await fetch(`http://127.0.0.1:${status.port}/remnic/ui/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") ?? "", /javascript/);

    const api = await fetch(`http://127.0.0.1:${status.port}/engram/v1/health`);
    const body = await api.json() as { code?: string };
    assert.equal(api.status, 401);
    assert.equal(body.code, "unauthorized");
    assert.equal(api.headers.get("www-authenticate"), "Bearer");
  } finally {
    await server.stop();
  }
});

test("HTTP coding-context endpoint accepts projectTag shorthand", async () => {
  const calls: unknown[] = [];
  const service = {
    setCodingContext: (request: unknown) => {
      calls.push(request);
    },
  } as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${status.port}/engram/v1/coding-context`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionKey: "s1",
        projectTag: "Blend/Supply",
      }),
    });

    const projectId = projectTagProjectId("Blend/Supply");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(calls, [
      {
        sessionKey: "s1",
        codingContext: {
          projectId,
          branch: null,
          rootPath: projectId,
          defaultBranch: null,
        },
      },
    ]);
  } finally {
    await server.stop();
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

test("HTTP offline snapshot accepts gzipped fast-base bodies", async () => {
  const calls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
    includeTranscripts: boolean | undefined;
    includeContent: boolean | undefined;
    baseFiles: unknown;
    baseCapturedAt: Date | undefined;
  }> = [];
  const service = {
    offlineSyncSnapshot: async (options: {
      namespace?: string;
      principal?: string;
      includeTranscripts?: boolean;
      includeContent?: boolean;
      baseFiles?: unknown;
      baseCapturedAt?: Date;
    }) => {
      calls.push({
        namespace: options.namespace,
        principal: options.principal,
        includeTranscripts: options.includeTranscripts,
        includeContent: options.includeContent,
        baseFiles: options.baseFiles,
        baseCapturedAt: options.baseCapturedAt,
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
    const body = gzipSync(JSON.stringify({
      namespace: "team",
      includeTranscripts: false,
      includeContent: false,
      baseCapturedAt: "2026-05-20T00:00:00.000Z",
      baseFiles: [{
        path: "facts/a.md",
        sha256: "a".repeat(64),
        bytes: 12,
        mtimeMs: 1234,
      }],
    }));
    const response = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/snapshot`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body,
      },
    );
    const responseBody = await response.json() as { namespace?: string };

    assert.equal(response.status, 200);
    assert.equal(responseBody.namespace, "team");
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.deepEqual(call, {
      namespace: "team",
      principal: "reader",
      includeTranscripts: false,
      includeContent: false,
      baseFiles: [{
        path: "facts/a.md",
        sha256: "a".repeat(64),
        bytes: 12,
        mtimeMs: 1234,
      }],
      baseCapturedAt: new Date("2026-05-20T00:00:00.000Z"),
    });
  } finally {
    await server.stop();
  }
});

test("HTTP offline snapshot stream emits metadata records as NDJSON", async () => {
  const calls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
    includeTranscripts: boolean | undefined;
    includeContent: boolean | undefined;
  }> = [];
  const service = {
    offlineSyncSnapshotStream: async (options: {
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
        files: (async function* () {
          yield {
            path: "facts/a.md",
            sha256: "a".repeat(64),
            bytes: 12,
            mtimeMs: 1234,
          };
        })(),
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
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/snapshot-stream?namespace=team&include_transcripts=false&content=false`,
      { headers: { authorization: "Bearer test-token" } },
    );
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal(lines[0]?.type, "snapshot");
    assert.equal(lines[0]?.namespace, "team");
    assert.equal(lines[1]?.type, "file");
    assert.deepEqual((lines[1]?.file as { path?: string }).path, "facts/a.md");
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
          path: "artifacts/large.txt",
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
    assert.equal(response.headers.get("x-remnic-file-path"), "artifacts%2Flarge.txt");
    assert.equal(response.headers.get("x-remnic-file-sha256"), "a".repeat(64));
    assert.equal(response.headers.get("x-remnic-file-bytes"), "12");
    assert.equal(response.headers.get("x-remnic-file-mtime-ms"), "1234");
    assert.equal(response.headers.get("x-remnic-chunk-offset"), "8");
    assert.equal(response.headers.get("x-remnic-chunk-bytes"), "5");
    assert.deepEqual(calls, [{
      namespace: "team",
      principal: "reader",
      includeTranscripts: false,
      path: "artifacts/large.txt",
      offset: 8,
      length: 5,
    }]);
  } finally {
    await server.stop();
  }
});

test("HTTP offline apply-file-content forwards binary chunks and metadata", async () => {
  const calls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
    includeTranscripts: boolean | undefined;
    sourceId: string;
    path: string;
    sha256: string;
    bytes: number;
    mtimeMs: number;
    offset: number | undefined;
    baseSha256: string | undefined;
    content: string;
  }> = [];
  const service = {
    offlineSyncApplyFileContent: async (options: {
      namespace?: string;
      principal?: string;
      includeTranscripts?: boolean;
      sourceId: string;
      path: string;
      sha256: string;
      bytes: number;
      mtimeMs: number;
      offset?: number;
      baseSha256?: string;
      content: Buffer;
    }) => {
      calls.push({
        namespace: options.namespace,
        principal: options.principal,
        includeTranscripts: options.includeTranscripts,
        sourceId: options.sourceId,
        path: options.path,
        sha256: options.sha256,
        bytes: options.bytes,
        mtimeMs: options.mtimeMs,
        offset: options.offset,
        baseSha256: options.baseSha256,
        content: options.content.toString("utf-8"),
      });
      return {
        namespace: options.namespace ?? "default",
        path: options.path,
        sha256: options.sha256,
        bytes: options.bytes,
        mtimeMs: options.mtimeMs,
        offset: options.offset ?? 0,
        chunkBytes: options.content.length,
        done: true,
        applied: true,
        skipped: false,
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/apply-file-content?namespace=team`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/octet-stream",
          "x-remnic-include-transcripts": "false",
          "x-remnic-source-id": encodeURIComponent("laptop:test"),
          "x-remnic-file-path": encodeURIComponent("state/lcm.sqlite"),
          "x-remnic-file-sha256": "b".repeat(64),
          "x-remnic-file-bytes": "5",
          "x-remnic-file-mtime-ms": "1234",
          "x-remnic-chunk-offset": "8",
          "x-remnic-base-sha256": "a".repeat(64),
        },
        body: Buffer.from("hello"),
      },
    );
    const body = await response.json() as { namespace?: string; applied?: boolean; chunkBytes?: number };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.applied, true);
    assert.equal(body.chunkBytes, 5);
    assert.deepEqual(calls, [{
      namespace: "team",
      principal: "writer",
      includeTranscripts: false,
      sourceId: "laptop:test",
      path: "state/lcm.sqlite",
      sha256: "b".repeat(64),
      bytes: 5,
      mtimeMs: 1234,
      offset: 8,
      baseSha256: "a".repeat(64),
      content: "hello",
    }]);
  } finally {
    await server.stop();
  }
});

test("HTTP offline apply-file-content allows bulk sync chunks outside the generic write throttle", async () => {
  let calls = 0;
  const service = {
    offlineSyncApplyFileContent: async (options: {
      namespace?: string;
      path: string;
      sha256: string;
      bytes: number;
      mtimeMs: number;
      offset?: number;
      content: Buffer;
    }) => {
      calls += 1;
      return {
        namespace: options.namespace ?? "default",
        path: options.path,
        sha256: options.sha256,
        bytes: options.bytes,
        mtimeMs: options.mtimeMs,
        offset: options.offset ?? 0,
        chunkBytes: options.content.length,
        done: true,
        applied: true,
        skipped: false,
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
    let lastStatus = 0;
    for (let i = 0; i < 31; i += 1) {
      const response = await fetch(
        `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/apply-file-content?namespace=team`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/octet-stream",
            "x-remnic-source-id": encodeURIComponent("laptop:test"),
            "x-remnic-file-path": encodeURIComponent(`state/file-${i}.bin`),
            "x-remnic-file-sha256": "b".repeat(64),
            "x-remnic-file-bytes": "5",
            "x-remnic-file-mtime-ms": "1234",
            "x-remnic-chunk-offset": "0",
          },
          body: new Blob([new Uint8Array(Buffer.from("hello"))]),
        },
      );
      lastStatus = response.status;
      if (!response.ok) break;
      await response.arrayBuffer();
    }

    assert.equal(lastStatus, 200);
    assert.equal(calls, 31);
  } finally {
    await server.stop();
  }
});

test("HTTP offline snapshot accepts baseline metadata for fast sync", async () => {
  const calls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
    includeTranscripts: boolean | undefined;
    includeContent: boolean | undefined;
    baseCapturedAt: string | undefined;
    baseFileCount: number;
  }> = [];
  const service = {
    offlineSyncSnapshot: async (options: {
      namespace?: string;
      principal?: string;
      includeTranscripts?: boolean;
      includeContent?: boolean;
      baseCapturedAt?: Date;
      baseFiles?: Array<{ path: string; sha256: string; bytes: number; mtimeMs: number }>;
    }) => {
      calls.push({
        namespace: options.namespace,
        principal: options.principal,
        includeTranscripts: options.includeTranscripts,
        includeContent: options.includeContent,
        baseCapturedAt: options.baseCapturedAt?.toISOString(),
        baseFileCount: options.baseFiles?.length ?? 0,
      });
      return {
        namespace: options.namespace ?? "default",
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date("2026-05-21T00:00:00Z").toISOString(),
        sourceId: "remote:test",
        includeTranscripts: options.includeTranscripts !== false,
        files: options.baseFiles ?? [],
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
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/snapshot`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: "team",
          includeTranscripts: false,
          includeContent: false,
          baseCapturedAt: "2026-05-31T17:30:08.350Z",
          baseFiles: [{
            path: "facts/a.md",
            sha256: "a".repeat(64),
            bytes: 12,
            mtimeMs: 1234,
          }],
        }),
      },
    );
    const body = await response.json() as { namespace?: string; files?: unknown[] };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.files?.length, 1);
    assert.deepEqual(calls, [{
      namespace: "team",
      principal: "reader",
      includeTranscripts: false,
      includeContent: false,
      baseCapturedAt: "2026-05-31T17:30:08.350Z",
      baseFileCount: 1,
    }]);
  } finally {
    await server.stop();
  }
});

test("HTTP offline snapshot rejects unsafe baseline paths as validation errors", async () => {
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
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/snapshot`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          baseFiles: [{
            path: "../outside.md",
            sha256: "a".repeat(64),
            bytes: 12,
            mtimeMs: 1234,
          }],
        }),
      },
    );
    const body = await response.json() as { code?: string; details?: Array<{ field?: string; message?: string }> };

    assert.equal(response.status, 400);
    assert.equal(body.code, "validation_error");
    assert.equal(body.details?.[0]?.field, "baseFiles.0.path");
    assert.match(body.details?.[0]?.message ?? "", /POSIX relative path/);
    assert.equal(calls, 0);
  } finally {
    await server.stop();
  }
});

test("HTTP offline snapshot rejects out-of-range baseline mtimes as validation errors", async () => {
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
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/snapshot`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          baseFiles: [{
            path: "facts/a.md",
            sha256: "a".repeat(64),
            bytes: 12,
            mtimeMs: OFFLINE_SYNC_MAX_MTIME_MS + 1,
          }],
        }),
      },
    );
    const body = await response.json() as { code?: string; details?: Array<{ field?: string; message?: string }> };

    assert.equal(response.status, 400);
    assert.equal(body.code, "validation_error");
    assert.equal(body.details?.[0]?.field, "baseFiles.0.mtimeMs");
    assert.match(body.details?.[0]?.message ?? "", /less than or equal/);
    assert.equal(calls, 0);
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

test("HTTP offline apply accepts bulk changesets above the generic JSON body limit", async () => {
  let calls = 0;
  const largeContent = Buffer.alloc(256 * 1024, 7).toString("base64");
  const changeset = {
    format: "remnic.offline-sync.changeset.v1",
    schemaVersion: 1,
    createdAt: new Date("2026-05-21T00:00:00Z").toISOString(),
    sourceId: "laptop:test",
    includeTranscripts: true,
    changes: [{
      type: "upsert",
      path: "facts/large.md",
      file: {
        path: "facts/large.md",
        sha256: "b".repeat(64),
        bytes: 256 * 1024,
        mtimeMs: 1,
        contentBase64: largeContent,
      },
    }],
  };
  const service = {
    offlineSyncApply: async () => {
      calls += 1;
      return {
        namespace: "team",
        appliedUpserts: 1,
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
    maxBodyBytes: 1024,
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
    const body = await response.json() as { appliedUpserts?: number };

    assert.equal(response.status, 200);
    assert.equal(body.appliedUpserts, 1);
    assert.equal(calls, 1);
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
