import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  EngramAccessHttpServer,
  type RemnicAdminControls,
  type RemnicAdminDashboardStatus,
} from "./access-http.js";
import {
  EngramAccessInputError,
  type EngramAccessRecallRequest,
  type EngramAccessService,
} from "./access-service.js";
import {
  tokenCapabilityStore,
  type TokenCapabilities,
} from "./access-token-capabilities.js";
import { parseConfig } from "./config.js";
import { readPair, writePair } from "./contradiction/contradiction-review.js";
import { createChatSession } from "./chat/chat-session.js";
import { DEFAULT_CHAT_CONFIG } from "./chat/chat-config.js";
import { projectTagProjectId } from "./coding/coding-namespace.js";
import { OFFLINE_SYNC_MAX_MTIME_MS } from "./offline-sync.js";
import type { StorageManager } from "./storage.js";
import { SupportPassportError } from "./support-passport/errors.js";

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

test("HTTP liveness is authenticated and does not run detailed health diagnostics", async () => {
  let healthCalls = 0;
  const service = {
    health: async () => {
      healthCalls += 1;
      return new Promise<never>(() => {});
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
    const denied = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/live`,
    );
    assert.equal(denied.status, 401);

    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/live`,
      {
        headers: { authorization: "Bearer test-token" },
        signal: AbortSignal.timeout(500),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ready: true });
    assert.equal(healthCalls, 0);
  } finally {
    await server.stop();
  }
});

test("HTTP detailed health route still runs service diagnostics", async () => {
  let healthCalls = 0;
  const service = {
    health: async () => {
      healthCalls += 1;
      return { ok: true, diagnostics: "complete" };
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/health`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      diagnostics: "complete",
    });
    assert.equal(healthCalls, 1);
  } finally {
    await server.stop();
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
    for (const query of [
      "limit=10abc",
      "offset=1.5",
      "limit=0",
      "sort=udpated_desc",
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${status.port}/engram/v1/memories?${query}`,
        {
          headers: { authorization: "Bearer test-token" },
        },
      );
      assert.equal(response.status, 400, `${query} should be rejected`);
    }
    assert.equal(
      calls.length,
      0,
      "invalid queries must fail before calling memoryBrowse",
    );

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

test("HTTP batch LCM flush isolates namespace failures and charges one write quota", async () => {
  const calls: Array<{
    namespace?: string;
    sessionKey: string;
    authenticatedPrincipal?: string;
  }> = [];
  const service = {
    lcmCompactionFlush: async (request: {
      namespace?: string;
      sessionKey: string;
      authenticatedPrincipal?: string;
    }) => {
      calls.push(request);
      if (request.namespace === "team-b")
        throw new Error("team-b flush failed");
      return { enabled: true, flushed: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });

  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/lcm/compaction/flush`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "batch-session",
          namespaces: ["team-a", "team-b"],
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      enabled: false,
      flushed: false,
      sessionKey: "batch-session",
      namespaces: ["team-a", "team-b"],
      results: [
        {
          status: "fulfilled",
          namespace: "team-a",
          result: { enabled: true, flushed: true },
        },
        { status: "rejected", namespace: "team-b" },
      ],
    });
    assert.deepEqual(calls, [
      {
        sessionKey: "batch-session",
        namespace: "team-a",
        authenticatedPrincipal: undefined,
      },
      {
        sessionKey: "batch-session",
        namespace: "team-b",
        authenticatedPrincipal: undefined,
      },
    ]);

    const conflicting = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/lcm/compaction/flush`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "batch-session",
          namespace: "team-a",
          namespaces: ["team-b"],
        }),
      },
    );
    assert.equal(conflicting.status, 400);
    assert.equal(
      calls.length,
      2,
      "conflicting namespace forms must fail before dispatch",
    );

    const rateLimited = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/lcm/compaction/flush`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "batch-session",
          namespaces: ["team-a"],
        }),
      },
    );
    assert.equal(rateLimited.status, 429);
    assert.equal(calls.length, 2, "a batch consumes one write quota unit");
  } finally {
    await server.stop();
  }
});

test("HTTP LCM compaction record uses the lifecycle route and write quota", async () => {
  const calls: unknown[] = [];
  const service = {
    lcmCompactionRecord: async (request: unknown) => {
      calls.push(request);
      return { enabled: true, recorded: true, sessionKey: "record-session" };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });

  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/lcm/compaction/record`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "record-session",
          namespace: "team-a",
          tokensBefore: 100,
          tokensAfter: 40,
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      enabled: true,
      recorded: true,
      sessionKey: "record-session",
    });
    assert.deepEqual(calls, [
      {
        sessionKey: "record-session",
        namespace: "team-a",
        tokensBefore: 100,
        tokensAfter: 40,
        authenticatedPrincipal: undefined,
      },
    ]);

    const rateLimited = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/lcm/compaction/record`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "record-session",
          tokensBefore: 120,
          tokensAfter: 60,
        }),
      },
    );
    assert.equal(rateLimited.status, 429);
    assert.equal(calls.length, 1);
  } finally {
    await server.stop();
  }
});

test("HTTP batch LCM flush deduplicates aliases after effective namespace resolution", async () => {
  const calls: Array<{
    namespace?: string;
    sessionKey: string;
    authenticatedPrincipal?: string;
  }> = [];
  const service = {
    configRef: parseConfig({
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    lcmCompactionFlush: async (request: {
      namespace?: string;
      sessionKey: string;
      authenticatedPrincipal?: string;
    }) => {
      calls.push(request);
      return { enabled: true, flushed: true };
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/lcm/compaction/flush`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "effective-namespace-session",
          namespaces: ["", "default"],
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      enabled: true,
      flushed: true,
      sessionKey: "effective-namespace-session",
      namespaces: ["", "default"],
      results: [
        {
          status: "fulfilled",
          namespace: "",
          result: { enabled: true, flushed: true },
        },
        {
          status: "fulfilled",
          namespace: "default",
          result: { enabled: true, flushed: true },
        },
      ],
    });
    assert.deepEqual(calls, [
      {
        sessionKey: "effective-namespace-session",
        namespace: undefined,
        authenticatedPrincipal: undefined,
      },
    ]);
  } finally {
    await server.stop();
  }
});

test("HTTP batch LCM flush isolates per-namespace authorization failures", async () => {
  const calls: string[] = [];
  const service = {
    lcmCompactionFlush: async (request: { namespace?: string }) => {
      calls.push(request.namespace ?? "");
      return { enabled: true, flushed: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "unused-token",
    authTokenEntriesGetter: () => [
      {
        token: "scoped-token",
        capabilities: {
          version: 1,
          ops: ["lcm_compaction_flush"],
          namespaces: ["team-a"],
        },
      },
    ],
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/lcm/compaction/flush`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer scoped-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "authorized-batch-session",
          namespaces: ["team-a", "team-b"],
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      enabled: false,
      flushed: false,
      sessionKey: "authorized-batch-session",
      namespaces: ["team-a", "team-b"],
      results: [
        {
          status: "fulfilled",
          namespace: "team-a",
          result: { enabled: true, flushed: true },
        },
        { status: "rejected", namespace: "team-b" },
      ],
    });
    assert.deepEqual(calls, ["team-a"]);
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
    const shellText = await shell.text();
    assert.match(shellText, /Remnic Admin Console/);
    assert.doesNotMatch(shellText, /test-token/);

    const app = await fetch(`http://127.0.0.1:${status.port}/remnic/ui/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") ?? "", /javascript/);

    const api = await fetch(`http://127.0.0.1:${status.port}/engram/v1/health`);
    const body = (await api.json()) as { code?: string };
    assert.equal(api.status, 401);
    assert.equal(body.code, "unauthorized");
    assert.equal(api.headers.get("www-authenticate"), "Bearer");
  } finally {
    await server.stop();
  }
});

test("HTTP admin console can prefill the primary bearer token when explicitly enabled", async () => {
  const service = {} as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsolePrefillToken: true,
  });

  const status = await server.start();
  try {
    const unauthenticatedShell = await fetch(
      `http://127.0.0.1:${status.port}/engram/ui/`,
    );
    assert.equal(unauthenticatedShell.status, 200);
    assert.doesNotMatch(await unauthenticatedShell.text(), /test-token/);

    const shell = await fetch(`http://127.0.0.1:${status.port}/engram/ui/`, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get("cache-control"), "private, no-store");
    assert.equal(shell.headers.get("vary"), "authorization");
    const shellText = await shell.text();
    assert.match(shellText, /Object\.defineProperty\(window,key/);
    assert.match(shellText, /window\.addEventListener\("pagehide",clear,\{once:true\}\)/);
    assert.match(shellText, /script\.textContent="";script\.remove\(\)/);
    assert.match(shellText, /\}\)\("test-token",document\.currentScript\)/);
    assert.doesNotMatch(shellText, /window\.__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__="test-token"/);

    const app = await fetch(`http://127.0.0.1:${status.port}/engram/ui/app.js`);
    assert.equal(app.status, 200);
    assert.doesNotMatch(await app.text(), /test-token/);
  } finally {
    await server.stop();
  }
});

test("HTTP admin console safely serializes a prefill token into its inline bootstrap", async () => {
  const token = 'safe</script><script>window.injected=true</script>';
  const service = {} as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: token,
    adminConsolePrefillToken: true,
  });

  const status = await server.start();
  try {
    const shell = await fetch(`http://127.0.0.1:${status.port}/engram/ui/`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(shell.status, 200);
    const shellText = await shell.text();
    assert.doesNotMatch(shellText, /<script>window\.injected=true<\/script>/);
    assert.match(shellText, /safe\\u003c\/script>\\u003cscript>window\.injected=true\\u003c\/script>/);
  } finally {
    await server.stop();
  }
});

test("HTTP admin console does not disclose the primary token to a dynamic token", async () => {
  const service = {} as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "primary-token",
    authTokenEntriesGetter: () => [
      {
        token: "scoped-token",
        capabilities: { version: 1, ops: ["support_passport_cards_list"] },
      },
    ],
    adminConsolePrefillToken: true,
  });

  const status = await server.start();
  try {
    const shell = await fetch(`http://127.0.0.1:${status.port}/engram/ui/`, {
      headers: { authorization: "Bearer scoped-token" },
    });
    assert.equal(shell.status, 200);
    const body = await shell.text();
    assert.doesNotMatch(body, /primary-token/);
    assert.doesNotMatch(body, /__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__/);
  } finally {
    await server.stop();
  }
});

test("HTTP admin dashboard endpoints require bearer authentication and apply config patches", async () => {
  const service = {} as EngramAccessService;
  const patches: unknown[] = [];
  const dashboard: RemnicAdminDashboardStatus = {
    config: {
      path: "/tmp/remnic/config.json",
      exists: true,
      writable: true,
      restartRequired: false,
      values: {
        modelSource: "plugin",
        model: "gpt-4.1-mini",
      },
    },
    harnesses: [],
    models: [],
    features: [],
  };
  const adminControls: RemnicAdminControls = {
    status: async () => dashboard,
    update: async (patch) => {
      patches.push(patch);
      return {
        ...dashboard,
        config: {
          ...dashboard.config,
          restartRequired: true,
          values: {
            ...dashboard.config.values,
            modelSource: "gateway",
            gatewayAgentId: "sage-router",
          },
        },
      };
    },
  };
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminControls,
  });

  const status = await server.start();
  try {
    const unauthorized = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/admin/dashboard`,
    );
    assert.equal(unauthorized.status, 401);

    const dashboardResponse = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/admin/dashboard`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );
    assert.equal(dashboardResponse.status, 200);
    assert.deepEqual(await dashboardResponse.json(), dashboard);

    const patchResponse = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/admin/config`,
      {
        method: "PATCH",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelSource: "gateway",
          gatewayAgentId: "sage-router",
        }),
      },
    );
    assert.equal(patchResponse.status, 200);
    const body = (await patchResponse.json()) as RemnicAdminDashboardStatus;
    assert.equal(body.config.restartRequired, true);
    assert.deepEqual(patches, [
      { modelSource: "gateway", gatewayAgentId: "sage-router" },
    ]);
  } finally {
    await server.stop();
  }
});

test("HTTP admin namespaces rejects dead kinds and accepts live kinds", async () => {
  const filters: unknown[] = [];
  const service = {
    adminListNamespaces: async (filter: unknown) => {
      filters.push(filter);
      return { enabled: true, entries: [] };
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
    const rejected = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/admin/namespaces?kind=self`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.equal(rejected.status, 400);
    const accepted = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/admin/namespaces?kind=default`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual(filters, [{ kind: "default" }]);
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/coding-context`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "s1",
          projectTag: "Acme/Webshop",
        }),
      },
    );

    const projectId = projectTagProjectId("Acme/Webshop");
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

test("HTTP briefing endpoint dispatches through the briefing operation", async () => {
  const calls: unknown[] = [];
  const service = {
    briefing: async (request: unknown) => {
      calls.push(request);
      return {
        format: "markdown",
        window: { from: "2026-08-21", to: "2026-08-22" },
        namespace: "team",
        markdown: "# Briefing",
        json: { sections: { activeThreads: [] } },
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    principal: "panel-user",
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/briefing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          since: "24h",
          namespace: "team",
          format: "markdown",
          maxFollowups: 5,
        }),
      },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.format, "markdown");
    assert.equal(body.markdown, "# Briefing");
    assert.deepEqual(body.json.sections.activeThreads, []);
    assert.deepEqual(calls, [
      {
        since: "24h",
        focus: undefined,
        namespace: "team",
        format: "markdown",
        maxFollowups: 5,
        principal: "panel-user",
      },
    ]);

    const invalid = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/briefing`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ format: "jsno" }),
      },
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "input_error");
    assert.equal(calls.length, 1);
  } finally {
    await server.stop();
  }
});

test("HTTP contradiction scan uses writable namespace resolver", async () => {
  const resolverCalls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
  }> = [];
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
      throw new Error(
        "readable resolver must not authorize contradiction scan writes",
      );
    },
    getWritableStorageForNamespace: async (
      namespace: string | undefined,
      principal: string | undefined,
    ) => {
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/contradiction-scan`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ namespace: "team" }),
      },
    );
    const body = (await response.json()) as { scanned?: number };

    assert.equal(response.status, 200);
    assert.equal(body.scanned, 0);
    assert.deepEqual(resolverCalls, [
      { namespace: "team", principal: "writer" },
    ]);
  } finally {
    await server.stop();
  }
});

test("HTTP review list uses readable namespace resolver", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-http-review-list-"));
  const resolverCalls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
  }> = [];
  const service = {
    configRef: parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryDir: dir,
    getReadableStorageForNamespace: async (
      namespace: string | undefined,
      principal: string | undefined,
    ) => {
      resolverCalls.push({ namespace, principal });
      throw new EngramAccessInputError(
        `namespace is not readable: ${namespace}`,
      );
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
      `http://127.0.0.1:${status.port}/engram/v1/review/contradictions?namespace=team`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.match(body.error ?? "", /namespace is not readable: team/);
    assert.deepEqual(resolverCalls, [
      { namespace: "team", principal: "reader" },
    ]);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP default review list includes legacy unscoped pairs without mutating storage", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-http-review-list-default-"),
  );
  const legacy = writePair(dir, {
    memoryIds: ["legacy-a", "legacy-b"],
    verdict: "contradicts",
    rationale: "legacy pending pair",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
  });
  const resolverCalls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
  }> = [];
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
    getReadableStorageForNamespace: async (
      namespace: string | undefined,
      principal: string | undefined,
    ) => {
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/review/contradictions`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );
    const body = (await response.json()) as {
      total?: number;
      pairs?: Array<{ pairId?: string; namespace?: string }>;
    };
    assert.equal(response.status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.pairs?.[0]?.pairId, legacy.pairId);
    assert.equal(body.pairs?.[0]?.namespace, undefined);
    assert.equal(readPair(dir, legacy.pairId)?.namespace, undefined);
    assert.deepEqual(resolverCalls, [
      { namespace: undefined, principal: "reader" },
    ]);
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
  const resolverCalls: Array<{
    namespace: string | undefined;
    principal: string | undefined;
  }> = [];
  const service = {
    configRef: parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryDir: dir,
    getReadableStorageForNamespace: async (
      namespace: string | undefined,
      principal: string | undefined,
    ) => {
      resolverCalls.push({ namespace, principal });
      throw new EngramAccessInputError(
        `namespace is not readable: ${namespace}`,
      );
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
      `http://127.0.0.1:${status.port}/engram/v1/review/contradictions/${pair.pairId}`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 404);
    assert.equal(body.error, "pair_not_found");
    assert.deepEqual(resolverCalls, [
      { namespace: "team", principal: "reader" },
    ]);
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
        deletions: [{ path: "facts/deleted.md", mtimeMs: 1235 }],
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
    const body = (await response.json()) as {
      namespace?: string;
      includeTranscripts?: boolean;
      files?: unknown[];
      deletions?: unknown[];
    };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.includeTranscripts, false);
    assert.deepEqual(body.files, []);
    assert.deepEqual(body.deletions, [
      { path: "facts/deleted.md", mtimeMs: 1235 },
    ]);
    assert.deepEqual(calls, [
      {
        namespace: "team",
        principal: "reader",
        includeTranscripts: false,
        includeContent: false,
      },
    ]);
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
    const body = gzipSync(
      JSON.stringify({
        namespace: "team",
        includeTranscripts: false,
        includeContent: false,
        baseCapturedAt: "2026-05-20T00:00:00.000Z",
        baseFiles: [
          {
            path: "facts/a.md",
            sha256: "a".repeat(64),
            bytes: 12,
            mtimeMs: 1234,
          },
        ],
      }),
    );
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
    const responseBody = (await response.json()) as { namespace?: string };

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
      baseFiles: [
        {
          path: "facts/a.md",
          sha256: "a".repeat(64),
          bytes: 12,
          mtimeMs: 1234,
        },
      ],
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
        deletions: [{ path: "facts/deleted.md", mtimeMs: 1235 }],
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
    assert.equal(
      response.headers.get("content-type"),
      "application/x-ndjson; charset=utf-8",
    );
    assert.equal(lines[0]?.type, "snapshot");
    assert.equal(lines[0]?.namespace, "team");
    assert.deepEqual(lines[0]?.deletions, [
      { path: "facts/deleted.md", mtimeMs: 1235 },
    ]);
    assert.equal(lines[1]?.type, "file");
    assert.deepEqual((lines[1]?.file as { path?: string }).path, "facts/a.md");
    assert.deepEqual(calls, [
      {
        namespace: "team",
        principal: "reader",
        includeTranscripts: false,
        includeContent: false,
      },
    ]);
  } finally {
    await server.stop();
  }
});
test("HTTP offline manifest stream preserves snapshot-stream auth and emits body-free rows", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    offlineSyncManifestStream: async (options: Record<string, unknown>) => {
      calls.push(options);
      return {
        namespace: options.namespace ?? "default",
        format: "remnic-reconcile-manifest",
        schemaVersion: 1,
        files: (async function* () {
          yield {
            path: "facts/a.md",
            sha256: "a".repeat(64),
            bytes: 12,
            mtimeMs: 1234,
            memory: {
              id: "fact-a",
              status: "active",
              category: "fact",
              contentHash: "b".repeat(64),
            },
          };
        })(),
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    principal: "reader",
    authTokenEntriesGetter: () => [
      {
        token: "wrong-op",
        capabilities: { version: 1, ops: ["offline_sync_snapshot"] },
      },
      {
        token: "wrong-namespace",
        capabilities: {
          version: 1,
          ops: ["offline_sync_snapshot_stream"],
          namespaces: ["other"],
        },
      },
      {
        token: "reader",
        capabilities: {
          version: 1,
          ops: ["offline_sync_snapshot_stream"],
          namespaces: ["team"],
        },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const request = (
    token: string,
    query = "namespace=team&include_transcripts=false",
  ) =>
    fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/manifest-stream?${query}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
  try {
    assert.equal((await request("wrong-op")).status, 403);
    assert.equal((await request("wrong-namespace")).status, 403);
    assert.equal(calls.length, 0);
    assert.equal(
      (await request("reader", "namespace=team&include_transcripts=invalid"))
        .status,
      400,
    );
    assert.equal(
      (await request("reader", "namespace=team&content=true")).status,
      400,
    );
    assert.equal(calls.length, 0);

    const response = await request("reader");
    const text = await response.text();
    const lines = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/x-ndjson; charset=utf-8",
    );
    assert.equal(lines[0]?.type, "manifest");
    assert.equal(lines[1]?.type, "file");
    assert.deepEqual(lines[1]?.file, {
      path: "facts/a.md",
      sha256: "a".repeat(64),
      bytes: 12,
      mtimeMs: 1234,
      memory: {
        id: "fact-a",
        status: "active",
        category: "fact",
        contentHash: "b".repeat(64),
      },
    });
    assert.doesNotMatch(text, /contentBase64|rawContent|memory body/);
    assert.deepEqual(
      {
        namespace: calls[0]?.namespace,
        principal: calls[0]?.principal,
        includeTranscripts: calls[0]?.includeTranscripts,
      },
      {
        namespace: "team",
        principal: "reader",
        includeTranscripts: false,
      },
    );
  } finally {
    await server.stop();
  }
});

test("HTTP offline sync capabilities advertise manifest streaming", async () => {
  const server = new EngramAccessHttpServer({
    service: {} as EngramAccessService,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/offline-sync/capabilities`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      version: 1,
      convergenceFinalization: true,
      manifestStream: true,
    });
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
    const body = (await response.json()) as {
      namespace?: string;
      includeTranscripts?: boolean;
      files?: unknown[];
    };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.includeTranscripts, false);
    assert.deepEqual(body.files, []);
    assert.deepEqual(calls, [
      {
        namespace: "team",
        principal: "reader",
        includeTranscripts: false,
        paths: ["facts/a.md"],
      },
    ]);
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
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.equal(response.headers.get("x-remnic-namespace"), "team");
    assert.equal(
      response.headers.get("x-remnic-file-path"),
      "artifacts%2Flarge.txt",
    );
    assert.equal(response.headers.get("x-remnic-file-sha256"), "a".repeat(64));
    assert.equal(response.headers.get("x-remnic-file-bytes"), "12");
    assert.equal(response.headers.get("x-remnic-file-mtime-ms"), "1234");
    assert.equal(response.headers.get("x-remnic-chunk-offset"), "8");
    assert.equal(response.headers.get("x-remnic-chunk-bytes"), "5");
    assert.deepEqual(calls, [
      {
        namespace: "team",
        principal: "reader",
        includeTranscripts: false,
        path: "artifacts/large.txt",
        offset: 8,
        length: 5,
      },
    ]);
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
    const body = (await response.json()) as {
      namespace?: string;
      applied?: boolean;
      chunkBytes?: number;
    };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.applied, true);
    assert.equal(body.chunkBytes, 5);
    assert.deepEqual(calls, [
      {
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
      },
    ]);
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
      baseFiles?: Array<{
        path: string;
        sha256: string;
        bytes: number;
        mtimeMs: number;
      }>;
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
          baseFiles: [
            {
              path: "facts/a.md",
              sha256: "a".repeat(64),
              bytes: 12,
              mtimeMs: 1234,
            },
          ],
        }),
      },
    );
    const body = (await response.json()) as {
      namespace?: string;
      files?: unknown[];
    };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.files?.length, 1);
    assert.deepEqual(calls, [
      {
        namespace: "team",
        principal: "reader",
        includeTranscripts: false,
        includeContent: false,
        baseCapturedAt: "2026-05-31T17:30:08.350Z",
        baseFileCount: 1,
      },
    ]);
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
          baseFiles: [
            {
              path: "../outside.md",
              sha256: "a".repeat(64),
              bytes: 12,
              mtimeMs: 1234,
            },
          ],
        }),
      },
    );
    const body = (await response.json()) as {
      code?: string;
      details?: Array<{ field?: string; message?: string }>;
    };

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
          baseFiles: [
            {
              path: "facts/a.md",
              sha256: "a".repeat(64),
              bytes: 12,
              mtimeMs: OFFLINE_SYNC_MAX_MTIME_MS + 1,
            },
          ],
        }),
      },
    );
    const body = (await response.json()) as {
      code?: string;
      details?: Array<{ field?: string; message?: string }>;
    };

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
    const body = (await response.json()) as { error?: string; code?: string };

    assert.equal(response.status, 400);
    assert.match(
      body.error ?? "",
      /include_transcripts must be one of: true, false/,
    );
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/apply`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ namespace: "team", changeset }),
      },
    );
    const body = (await response.json()) as {
      namespace?: string;
      appliedUpserts?: number;
    };

    assert.equal(response.status, 200);
    assert.equal(body.namespace, "team");
    assert.equal(body.appliedUpserts, 0);
    assert.deepEqual(calls, [
      {
        namespace: "team",
        principal: "writer",
        changeset,
      },
    ]);
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
    changes: [
      {
        type: "upsert",
        path: "facts/large.md",
        file: {
          path: "facts/large.md",
          sha256: "b".repeat(64),
          bytes: 256 * 1024,
          mtimeMs: 1,
          contentBase64: largeContent,
        },
      },
    ],
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/apply`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ namespace: "team", changeset }),
      },
    );
    const body = (await response.json()) as { appliedUpserts?: number };

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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/offline-sync/apply`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ namespace: "team" }),
      },
    );
    const body = (await response.json()) as {
      code?: string;
      details?: Array<{ field?: string; message?: string }>;
    };

    assert.equal(response.status, 400);
    assert.equal(body.code, "validation_error");
    assert.equal(body.details?.[0]?.field, "changeset");
    assert.equal(calls, 0);

    const nullResponse = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/offline-sync/apply`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ namespace: "team", changeset: null }),
      },
    );
    const nullBody = (await nullResponse.json()) as {
      code?: string;
      details?: Array<{ field?: string; message?: string }>;
    };

    assert.equal(nullResponse.status, 400);
    assert.equal(nullBody.code, "validation_error");
    assert.equal(nullBody.details?.[0]?.field, "changeset");
    assert.equal(nullBody.details?.[0]?.message, "changeset is required");
    assert.equal(calls, 0);
  } finally {
    await server.stop();
  }
});

test("HTTP server rejects invalid resourceMetadataUrl at construction", () => {
  const service = {} as EngramAccessService;
  for (const bad of [
    "not a url",
    "ftp://example.com/oauth",
    "//relative/path",
    "",
  ]) {
    assert.throws(
      () =>
        new EngramAccessHttpServer({
          service,
          port: 0,
          authToken: "test-token",
          adminConsoleEnabled: false,
          resourceMetadataUrl: bad,
        }),
      /access HTTP resourceMetadataUrl/,
      `resourceMetadataUrl=${JSON.stringify(bad)} must be rejected`,
    );
  }
  // http and https are accepted.
  for (const ok of [
    "https://example.com/.well-known/oauth-protected-resource",
    "http://127.0.0.1:8787/.well-known/oauth-protected-resource",
  ]) {
    const server = new EngramAccessHttpServer({
      service,
      port: 0,
      authToken: "test-token",
      adminConsoleEnabled: false,
      resourceMetadataUrl: ok,
    });
    assert.ok(server, `resourceMetadataUrl=${ok} should be accepted`);
  }
});

test("HTTP 401 www-authenticate carries resource_metadata exactly when configured", async () => {
  const service = {} as EngramAccessService;
  const metadataUrl =
    "https://example.test/.well-known/oauth-protected-resource";
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    resourceMetadataUrl: metadataUrl,
  });
  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/health`,
    );
    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get("www-authenticate"),
      `Bearer resource_metadata="${metadataUrl}"`,
    );
  } finally {
    await server.stop();
  }
});

test("HTTP 401 www-authenticate is the bare Bearer challenge when resourceMetadataUrl is unset", async () => {
  const service = {} as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/health`,
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  } finally {
    await server.stop();
  }
});

test("HTTP /mcp serves GET SSE, DELETE 204, and 405 without SSE Accept (issue #2718)", async () => {
  const service = {} as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    // Authorized GET with SSE Accept → 200 text/event-stream whose first
    // bytes are comment-only heartbeats (never JSON-RPC). Read one bounded
    // chunk, then cancel so the open stream cannot hang the test.
    const controller = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${status.port}/mcp`, {
      headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(sse.status, 200, "GET /mcp with SSE Accept must be 200");
    assert.match(
      sse.headers.get("content-type") ?? "",
      /^text\/event-stream/,
      "GET /mcp SSE stream must advertise text/event-stream",
    );
    const reader = sse.body!.getReader();
    const { value: firstChunk } = await reader.read();
    const firstBytes = Buffer.from(firstChunk ?? []).toString("utf8");
    assert.ok(
      !firstBytes.includes("jsonrpc"),
      `GET /mcp stream must carry no JSON-RPC payload: ${JSON.stringify(firstBytes)}`,
    );
    controller.abort();

    // Authorized GET without the SSE Accept → 405 + full method set.
    const rejected = await fetch(`http://127.0.0.1:${status.port}/mcp`, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("allow"), "GET, POST, DELETE");

    // Authorized DELETE → 204 with empty body.
    const deleted = await fetch(`http://127.0.0.1:${status.port}/mcp`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");

    // Unauthenticated GET /mcp still gets 401 first (auth gate beats method handling).
    const unauth = await fetch(`http://127.0.0.1:${status.port}/mcp`, {
      headers: { accept: "text/event-stream" },
    });
    assert.equal(unauth.status, 401);
  } finally {
    await server.stop();
  }
});

test("HTTP /mcp rejects unknown MCP-Protocol-Version header with 400 JSON-RPC error", async () => {
  const service = {} as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${status.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "mcp-protocol-version": "1999-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as {
      jsonrpc?: string;
      error?: { message?: string };
    };
    assert.equal(body.jsonrpc, "2.0");
    assert.match(body.error?.message ?? "", /unsupported MCP-Protocol-Version/);

    // A supported header is accepted (and a valid request proceeds normally).
    for (const v of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const ok = await fetch(`http://127.0.0.1:${status.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "mcp-protocol-version": v,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      assert.equal(ok.status, 200, `version ${v} should be accepted`);
    }

    // Absent header is also fine.
    const absent = await fetch(`http://127.0.0.1:${status.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(absent.status, 200);
  } finally {
    await server.stop();
  }
});

test("HTTP externalRequestHandler runs pre-auth, can end responses, and falls through on false", async () => {
  // Minimal service stub: the fall-through leg hits /engram/v1/health, which
  // calls service.health(). The stub is signature-faithful (full
  // EngramAccessHealthResponse via `satisfies`) so interface drift fails here
  // instead of passing vacuously; everything else in this test bypasses the
  // service.
  const healthStub = {
    health: async () => ({
      ok: true as const,
      memoryDir: "/tmp/remnic-test",
      namespacesEnabled: false,
      defaultNamespace: "default",
      searchBackend: "recent",
      qmdEnabled: false,
      qmd: {
        enabled: false,
        active: false,
        degraded: false,
        mode: "disabled" as const,
        collection: "",
        collectionState: "skipped" as const,
        installedVersion: null,
        supportedVersion: null,
        supported: null,
        upgradeAvailable: null,
        doctorAvailable: null,
        debugStatus: "disabled",
        pendingEmbeddings: null,
        oldestPendingAgeMs: null,
        embeddingBacklogThreshold: 1000,
      },
      nativeKnowledgeEnabled: false,
      projectionAvailable: false,
      extraction: {
        lastExtractionAt: null,
        bufferedSessionCount: 0,
        pendingTurnCount: 0,
        oldestBufferedTurnAgeMs: null,
        degraded: false,
        degradedReason: null,
        watermarkScope: "aggregate",
      },
      corpus: [],
      corpusComplete: true,
      replica: { enabled: false, pending: false, polledAt: null, peers: [] },
    }),
  } satisfies Pick<EngramAccessService, "health">;
  const service = healthStub as unknown as EngramAccessService;
  const seen: Array<{ path: string; method: string; authorized: boolean }> = [];
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    externalRequestHandler: async (_req, res, ctx) => {
      seen.push({
        path: new URL(_req.url ?? "/", "http://placeholder").pathname,
        method: _req.method ?? "",
        authorized: ctx.authorized,
      });
      if (
        new URL(_req.url ?? "/", "http://placeholder").pathname ===
        "/probe/handled"
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ handled: true, authorized: ctx.authorized }));
        return true;
      }
      return false; // fall through to the normal pipeline
    },
  });
  const status = await server.start();
  try {
    // Pre-auth, the handler sees authorized=false (no token sent).
    const handled = await fetch(
      `http://127.0.0.1:${status.port}/probe/handled`,
    );
    assert.equal(handled.status, 200);
    const handledBody = (await handled.json()) as {
      handled?: boolean;
      authorized?: boolean;
    };
    assert.equal(handledBody.handled, true);
    assert.equal(
      handledBody.authorized,
      false,
      "handler must observe authorized=false pre-token",
    );

    // Fall-through path: same handler returns false, request continues to normal
    // routing. Hit a real endpoint so we know the request reached it.
    const passthrough = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/health`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.equal(
      passthrough.status,
      200,
      "fall-through should reach the normal health route",
    );
    const passthroughBody = (await passthrough.json()) as {
      ok?: boolean;
      memoryDir?: string;
    };
    assert.equal(
      passthroughBody.ok,
      true,
      "fall-through must return the stubbed health payload",
    );
    assert.equal(passthroughBody.memoryDir, "/tmp/remnic-test");

    // Authorized request: handler sees ctx.authorized=true.
    const authed = await fetch(
      `http://127.0.0.1:${status.port}/probe/handled`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.equal(authed.status, 200);
    const authedBody = (await authed.json()) as { authorized?: boolean };
    assert.equal(
      authedBody.authorized,
      true,
      "handler must observe authorized=true with valid token",
    );

    assert.deepEqual(seen, [
      { path: "/probe/handled", method: "GET", authorized: false },
      { path: "/engram/v1/health", method: "GET", authorized: true },
      { path: "/probe/handled", method: "GET", authorized: true },
    ]);
  } finally {
    await server.stop();
  }
});

test("HTTP externalRequestHandler errors flow through the existing error handler", async () => {
  const service = {} as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    externalRequestHandler: async () => {
      throw new Error("external-handler-explosion");
    },
  });
  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/health`,
    );
    assert.equal(
      response.status,
      500,
      "thrown errors must produce a 500 via the existing error handler",
    );
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "internal_error");
  } finally {
    await server.stop();
  }
});

test("HTTP authTokenEntriesGetter is authoritative: scope policy binds connectors and never falls through", async () => {
  // Signature-faithful health stub so non-MCP authorization outcomes are
  // observable as 200-with-body (a bare `{}` service would 500 and mask
  // accidental policy application).
  const healthStub = {
    health: async () => ({
      ok: true as const,
      memoryDir: "/tmp/remnic-scope-test",
      namespacesEnabled: false,
      defaultNamespace: "default",
      searchBackend: "recent",
      qmdEnabled: false,
      qmd: {
        enabled: false,
        active: false,
        degraded: false,
        mode: "disabled" as const,
        collection: "",
        collectionState: "skipped" as const,
        installedVersion: null,
        supportedVersion: null,
        supported: null,
        upgradeAvailable: null,
        doctorAvailable: null,
        debugStatus: "disabled",
        pendingEmbeddings: null,
        oldestPendingAgeMs: null,
        embeddingBacklogThreshold: 1000,
      },
      nativeKnowledgeEnabled: false,
      projectionAvailable: false,
      extraction: {
        lastExtractionAt: null,
        bufferedSessionCount: 0,
        pendingTurnCount: 0,
        oldestBufferedTurnAgeMs: null,
        degraded: false,
        degradedReason: null,
        watermarkScope: "aggregate",
      },
      corpus: [],
      corpusComplete: true,
      replica: { enabled: false, pending: false, polledAt: null, peers: [] },
    }),
  } satisfies Pick<EngramAccessService, "health">;
  const entries = [
    { token: "remnic_cg_scoped", connector: "chatgpt" },
    { token: "remnic_cx_free", connector: "codex" },
    { token: "remnic_xx_anon" }, // no connector — must fail closed under a policy
  ];
  const server = new EngramAccessHttpServer({
    service: healthStub as unknown as EngramAccessService,
    port: 0,
    authToken: "operator-token",
    // Dangerous shape on purpose: BOTH getters configured, and the string
    // getter is a superset (extra "string_only_token"). The entries getter
    // must decide alone; nothing may leak into the string getter.
    authTokensGetter: () => [
      ...entries.map((entry) => entry.token),
      "string_only_token",
    ],
    authTokenEntriesGetter: () => entries,
    tokenPathPolicy: (connector, pathname) =>
      connector !== "chatgpt" || pathname === "/mcp",
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const request = (token: string, path: string, method = "GET") =>
    fetch(`http://127.0.0.1:${status.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(method === "POST"
        ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }
        : {}),
    });
  try {
    // Scoped chatgpt token: /mcp only; health denied.
    assert.equal(
      (await request("remnic_cg_scoped", "/mcp", "POST")).status,
      200,
    );
    assert.equal(
      (await request("remnic_cg_scoped", "/engram/v1/health")).status,
      401,
      "chatgpt token must be denied off /mcp even with a permissive string getter present",
    );
    // Other connector tokens are unrestricted by this policy: /mcp AND health.
    assert.equal((await request("remnic_cx_free", "/mcp", "POST")).status, 200);
    const codexHealth = await request("remnic_cx_free", "/engram/v1/health");
    assert.equal(codexHealth.status, 200);
    assert.equal(((await codexHealth.json()) as { ok?: boolean }).ok, true);
    // Entry without connector fails closed when a policy is configured.
    assert.equal((await request("remnic_xx_anon", "/mcp", "POST")).status, 401);
    // A token present ONLY in the string getter is NOT honored: the entries
    // getter is authoritative and there is no fall-through.
    assert.equal(
      (await request("string_only_token", "/mcp", "POST")).status,
      401,
    );
    assert.equal(
      (await request("string_only_token", "/engram/v1/health")).status,
      401,
    );
    // Unknown tokens are rejected everywhere.
    assert.equal(
      (await request("remnic_zz_unknown", "/mcp", "POST")).status,
      401,
    );
    // Static operator token bypasses the policy entirely: /mcp AND health.
    assert.equal((await request("operator-token", "/mcp", "POST")).status, 200);
    const operatorHealth = await request("operator-token", "/engram/v1/health");
    assert.equal(operatorHealth.status, 200);
    assert.equal(((await operatorHealth.json()) as { ok?: boolean }).ok, true);
  } finally {
    await server.stop();
  }
});

test("HTTP scoped-token namespace allow-list is enforced on every namespace route (issue #1837 bypass fix)", async () => {
  // A scoped token may touch ONLY ns_a. The server default tenant is "default"
  // (≠ ns_a), so OMITTING ?namespace= must NOT silently fall through to the
  // default tenant — the EFFECTIVE namespace (explicit OR defaulted) must be a
  // member of the token's allow-list on every namespace-scoped route. Fail
  // closed everywhere; the previous behavior let a scoped bearer drop the
  // param and reach the server default tenant (memory_list / memory_get).
  const browseCalls: { namespace?: string }[] = [];
  const getCalls: { memoryId: string; namespace: string | undefined }[] = [];
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-scoped-namespace-allow-list",
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryBrowse: async (request: { namespace?: string }) => {
      browseCalls.push(request);
      return { total: 0, memories: [] };
    },
    memoryGet: async (memoryId: string, namespace: string | undefined) => {
      getCalls.push({ memoryId, namespace });
      return { found: true };
    },
    peerList: async () => ({ peers: [] }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    // Entry-based tokens with a capabilities record. The scoped token carries
    // a namespaces allow-list; the operator token is explicit-unrestricted.
    authTokenEntriesGetter: () => [
      {
        token: "scoped-ns-a",
        capabilities: { version: 1, namespaces: ["ns_a"] },
      },
      { token: "operator", capabilities: { version: 1 } },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const request = (token: string, urlPath: string) =>
    fetch(`http://127.0.0.1:${status.port}${urlPath}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  try {
    // ── memory_list: the named bypass route ──
    assert.equal(
      (await request("scoped-ns-a", "/engram/v1/memories")).status,
      403,
      "scoped: omitting namespace must be rejected — server default is not in the allow-list",
    );
    assert.equal(
      (await request("scoped-ns-a", "/engram/v1/memories?namespace=ns_b"))
        .status,
      403,
      "scoped: an unlisted namespace must be rejected",
    );
    const okList = await request(
      "scoped-ns-a",
      "/engram/v1/memories?namespace=ns_a",
    );
    assert.equal(
      okList.status,
      200,
      "scoped: an allowed namespace must succeed",
    );
    assert.equal(
      browseCalls.at(-1)?.namespace,
      "ns_a",
      "scoped: the allowed namespace is forwarded to the service",
    );

    // ── memory_get: the other named bypass route (dispatches via the op registry) ──
    assert.equal(
      (await request("scoped-ns-a", "/engram/v1/memories/m_1")).status,
      403,
      "scoped memory_get: omitting namespace must be rejected",
    );
    assert.equal(
      (await request("scoped-ns-a", "/engram/v1/memories/m_1?namespace=ns_b"))
        .status,
      403,
      "scoped memory_get: an unlisted namespace must be rejected",
    );
    const okGet = await request(
      "scoped-ns-a",
      "/engram/v1/memories/m_1?namespace=ns_a",
    );
    assert.equal(
      okGet.status,
      200,
      "scoped memory_get: an allowed namespace must succeed",
    );
    assert.deepEqual(
      getCalls.at(-1),
      { memoryId: "m_1", namespace: "ns_a" },
      "scoped memory_get: the allowed namespace reaches the service",
    );

    // ── a non-namespace-scoped route is unaffected by namespace scoping ──
    assert.equal(
      (await request("scoped-ns-a", "/engram/v1/peers")).status,
      200,
      "a non-namespace-scoped route must be unaffected",
    );

    // ── unrestricted token: omitting namespace still reaches the default tenant ──
    assert.equal(
      (await request("operator", "/engram/v1/memories")).status,
      200,
      "unrestricted: omitting namespace must still reach the default tenant",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP scoped-token namespace allow-list gates id-loaded contradiction routes (issue #1850 round 2)", async () => {
  // The contradiction detail GET and review/resolve routes load the pair BY
  // ID — its namespace comes from the record, NOT a ?namespace= query param
  // that resolveNamespace() already gates. A namespace-scoped bearer that
  // knows a pair id in a namespace outside its allow-list must NOT be able to
  // read (GET) or mutate (resolve) it. Fail closed (403) everywhere; the pair
  // in the allowed namespace is reachable.
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-http-scoped-contradiction-"),
  );
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
    configRef: parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryDir: dir,
    storageRef: storage,
    getReadableStorageForNamespace: async (namespace: string | undefined) => ({
      namespace: namespace ?? "default",
      storage,
    }),
    getWritableStorageForNamespace: async (namespace: string | undefined) => ({
      namespace: namespace ?? "default",
      storage,
    }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "scoped-ns-a",
        capabilities: { version: 1, namespaces: ["ns_a"] },
      },
      { token: "operator", capabilities: { version: 1 } },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const getDetail = (token: string, pairId: string) =>
    fetch(
      `http://127.0.0.1:${status.port}/engram/v1/review/contradictions/${pairId}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
  const resolve = (token: string, pairId: string, verb: string) =>
    fetch(`http://127.0.0.1:${status.port}/engram/v1/review/resolve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pairId, verb }),
    });
  try {
    // ── GET detail: scoped token, denied namespace → 403 (fail closed, no leak) ──
    assert.equal(
      (await getDetail("scoped-ns-a", deniedPair.pairId)).status,
      403,
      "scoped GET: a pair in an unlisted namespace must be denied (403), not leaked",
    );
    // ── GET detail: scoped token, allowed namespace → 200 ──
    assert.equal(
      (await getDetail("scoped-ns-a", allowedPair.pairId)).status,
      200,
      "scoped GET: a pair in the allowed namespace must succeed",
    );

    // ── review/resolve: scoped token, denied namespace → 403 before any mutation ──
    const deniedResolve = await resolve(
      "scoped-ns-a",
      deniedPair.pairId,
      "both-valid",
    );
    assert.equal(
      deniedResolve.status,
      403,
      "scoped resolve: a pair in an unlisted namespace must be denied (403) before any mutation",
    );
    // The denied pair must NOT have been mutated (no resolution leak).
    assert.notEqual(
      readPair(dir, deniedPair.pairId)?.resolution,
      "both-valid",
      "scoped resolve: the denied pair must remain unresolved",
    );

    // ── review/resolve: scoped token, allowed namespace → succeeds (not 403) ──
    const allowedResolve = await resolve(
      "scoped-ns-a",
      allowedPair.pairId,
      "both-valid",
    );
    assert.equal(
      allowedResolve.status,
      200,
      "scoped resolve: a pair in the allowed namespace must succeed",
    );
    assert.equal(
      readPair(dir, allowedPair.pairId)?.resolution,
      "both-valid",
      "scoped resolve: the allowed pair is marked resolved",
    );

    // ── unrestricted operator token: the denied-namespace pair is reachable ──
    assert.equal(
      (await getDetail("operator", deniedPair.pairId)).status,
      200,
      "unrestricted GET: the denied-namespace pair is reachable for an unrestricted token",
    );
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Issue #1850 round 4 — uniform effective-namespace chokepoint coverage.
// One helper (enforceNamespaceAllowList) gates every surface; these tests
// prove the gate fires on the surfaces round 3 missed: MCP tools/call, HTTP
// body-namespace (coding) routes, and the legacy undefined-namespace pair.
// ===========================================================================

test("HTTP-MCP tools/call enforces the token namespace allow-list (issue #1850 finding 1)", async () => {
  // MCP `tools/call` previously never applied the namespace allow-list, so a
  // scoped bearer could reach another tenant via tool args. capsule_list is a
  // namespace-scoped MCP tool (accepts a `namespace` argument), so the gate
  // must fire on it. The 403 is thrown BEFORE op.run, so the denied case never
  // reaches the service.
  const capsuleCalls: Array<Record<string, unknown>> = [];
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-mcp-ns",
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    capsuleList: async (args: Record<string, unknown>) => {
      capsuleCalls.push(args);
      return { capsules: [] };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "scoped-ns-a",
        capabilities: { version: 1, namespaces: ["ns_a"] },
      },
      { token: "operator", capabilities: { version: 1 } },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const mcpCall = (token: string, namespace: string) =>
    fetch(`http://127.0.0.1:${status.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "engram.capsule_list", arguments: { namespace } },
      }),
    });
  try {
    // scoped: an unlisted namespace is rejected with 403 BEFORE op.run.
    assert.equal(
      (await mcpCall("scoped-ns-a", "ns_b")).status,
      403,
      "scoped MCP: an unlisted namespace must be denied (403) before op.run",
    );
    assert.equal(
      capsuleCalls.length,
      0,
      "scoped MCP: the service must NOT be reached for a denied namespace",
    );
    // scoped: the allowed namespace proceeds past the gate (200, not 403).
    const allowed = await mcpCall("scoped-ns-a", "ns_a");
    assert.notEqual(
      allowed.status,
      403,
      "scoped MCP: the allowed namespace must proceed past the gate",
    );
    assert.equal(
      capsuleCalls.at(-1)?.namespace,
      "ns_a",
      "scoped MCP: the allowed namespace reaches the service",
    );
    // unrestricted: an unlisted namespace is a no-op (proceeds, not 403).
    const unrestricted = await mcpCall("operator", "ns_b");
    assert.notEqual(
      unrestricted.status,
      403,
      "unrestricted MCP: namespace scoping must be a no-op",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP coding POST routes gate the body namespace through the allow-list (issue #1850 finding 2)", async () => {
  // coding_decision passes `body` straight to op.run; a scoped bearer setting
  // body.namespace to another tenant must be rejected. The gate fires on the
  // body namespace field via the same resolveNamespace chokepoint as query
  // routes. 403 before op.run; the allowed namespace reaches the service.
  const decisionCalls: Array<Record<string, unknown>> = [];
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-coding-ns",
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    codingDecision: async (input: Record<string, unknown>) => {
      decisionCalls.push(input);
      return { subcommand: "list", records: [], count: 0 };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "scoped-ns-a",
        capabilities: { version: 1, namespaces: ["ns_a"] },
      },
      { token: "operator", capabilities: { version: 1 } },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const postDecision = (token: string, namespace: string | undefined) =>
    fetch(`http://127.0.0.1:${status.port}/engram/v1/coding/decisions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subcommand: "list",
        ...(namespace ? { namespace } : {}),
      }),
    });
  try {
    // scoped: body.namespace to an unlisted tenant → 403 before op.run.
    assert.equal(
      (await postDecision("scoped-ns-a", "ns_b")).status,
      403,
      "scoped coding: body.namespace to an unlisted namespace must be denied (403)",
    );
    assert.equal(
      decisionCalls.length,
      0,
      "scoped coding: the service must NOT be reached for a denied namespace",
    );
    // scoped: the allowed body.namespace reaches the service.
    const allowed = await postDecision("scoped-ns-a", "ns_a");
    assert.notEqual(
      allowed.status,
      403,
      "scoped coding: the allowed namespace must proceed past the gate",
    );
    assert.equal(
      decisionCalls.at(-1)?.namespace,
      "ns_a",
      "scoped coding: the allowed namespace reaches the service",
    );
    // unrestricted: any body.namespace is a no-op.
    assert.notEqual(
      (await postDecision("operator", "ns_b")).status,
      403,
      "unrestricted coding: namespace scoping must be a no-op",
    );
  } finally {
    await server.stop();
  }
});

test("Legacy undefined-namespace contradiction pair: default-allow-list token reads+resolves; non-default denied (issue #1850 findings 3+4)", async () => {
  // A legacy pair carries namespace:undefined, which downstream storage maps to
  // the server DEFAULT. Round 3's assertNamespaceAllowed(caps, undefined)
  // wrongly denied a scoped token whose allow-list INCLUDES the default. The
  // effective-namespace chokepoint maps undefined → default, so:
  //   - namespaces:['default'] (== server default) ⇒ ALLOWED read + resolve;
  //   - namespaces:['ns_a'] (not default) ⇒ DENIED.
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-http-scoped-legacy-pair-"),
  );
  const legacyPair = writePair(dir, {
    memoryIds: ["legacy-x", "legacy-y"],
    verdict: "contradicts",
    rationale: "legacy pair with no namespace",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
  });
  // Sanity: the fixture really is a legacy unscoped pair.
  assert.equal(readPair(dir, legacyPair.pairId)?.namespace, undefined);
  const storage = { dir } as unknown as StorageManager;
  const baseService = {
    configRef: parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryDir: dir,
    storageRef: storage,
    getReadableStorageForNamespace: async (namespace: string | undefined) => ({
      namespace: namespace ?? "default",
      storage,
    }),
    getWritableStorageForNamespace: async (namespace: string | undefined) => ({
      namespace: namespace ?? "default",
      storage,
    }),
  };
  const mkServer = (scopedToken: string, allowList: string[]) => {
    const service = { ...baseService } as unknown as EngramAccessService;
    return new EngramAccessHttpServer({
      service,
      port: 0,
      authTokenEntriesGetter: () => [
        {
          token: scopedToken,
          capabilities: { version: 1, namespaces: allowList },
        },
      ],
      adminConsoleEnabled: false,
    });
  };

  // ── default-allow-list token: legacy pair is reachable + resolvable ──
  const defaultServer = mkServer("allow-default", ["default"]);
  const defaultStatus = await defaultServer.start();
  try {
    const detail = await fetch(
      `http://127.0.0.1:${defaultStatus.port}/engram/v1/review/contradictions/${legacyPair.pairId}`,
      { headers: { authorization: "Bearer allow-default" } },
    );
    assert.equal(
      detail.status,
      200,
      "default-allow token: legacy undefined pair must be readable (undefined→default)",
    );
    const resolve = await fetch(
      `http://127.0.0.1:${defaultStatus.port}/engram/v1/review/resolve`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer allow-default",
          "content-type": "application/json",
        },
        body: JSON.stringify({ pairId: legacyPair.pairId, verb: "both-valid" }),
      },
    );
    assert.equal(
      resolve.status,
      200,
      "default-allow token: legacy undefined pair must be resolvable",
    );
    assert.equal(
      readPair(dir, legacyPair.pairId)?.resolution,
      "both-valid",
      "default-allow token: the legacy pair is marked resolved",
    );
  } finally {
    await defaultServer.stop();
  }

  // A fresh legacy pair for the deny case — independent of the pair the
  // default-allow token already resolved above, so "must remain unresolved"
  // is a clean assertion.
  const deniedLegacyPair = writePair(dir, {
    memoryIds: ["legacy-deny-x", "legacy-deny-y"],
    verdict: "contradicts",
    rationale: "legacy pair for the deny case",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
  });
  assert.equal(readPair(dir, deniedLegacyPair.pairId)?.namespace, undefined);

  // ── non-default-allow-list token: legacy pair is DENIED (undefined→default not listed) ──
  const deniedServer = mkServer("allow-ns-a", ["ns_a"]);
  const deniedStatus = await deniedServer.start();
  try {
    const detail = await fetch(
      `http://127.0.0.1:${deniedStatus.port}/engram/v1/review/contradictions/${deniedLegacyPair.pairId}`,
      { headers: { authorization: "Bearer allow-ns-a" } },
    );
    assert.equal(
      detail.status,
      403,
      "non-default token: legacy undefined pair must be denied (undefined→default not in allow-list)",
    );
    const resolve = await fetch(
      `http://127.0.0.1:${deniedStatus.port}/engram/v1/review/resolve`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer allow-ns-a",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pairId: deniedLegacyPair.pairId,
          verb: "both-valid",
        }),
      },
    );
    assert.equal(
      resolve.status,
      403,
      "non-default token: legacy undefined pair must not be resolvable",
    );
    assert.notEqual(
      readPair(dir, deniedLegacyPair.pairId)?.resolution,
      "both-valid",
      "non-default token: the legacy pair must remain unresolved",
    );
  } finally {
    await deniedServer.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Issue #1850 round 5: comprehensive access-surface coverage
// ──────────────────────────────────────────────────────────────────────────

test("HTTP adapters route is op-gated: deny-all → 403, unrestricted → 200 (issue #1850 finding 1)", async () => {
  // The adapters route serves adapter metadata after auth but previously had
  // NO enforceTokenOp, so a deny-all / narrow-ops token reached it. It now
  // dispatches through the adapters_status op; a scoped token is rejected.
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-adapters-opgate",
      defaultNamespace: "default",
    }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      { token: "denyall", capabilities: { version: 1, ops: [] } },
      { token: "narrow", capabilities: { version: 1, ops: ["memory_get"] } },
      { token: "operator", capabilities: { version: 1 } },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const request = (token: string, urlPath: string) =>
    fetch(`http://127.0.0.1:${status.port}${urlPath}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  try {
    assert.equal(
      (await request("denyall", "/engram/v1/adapters")).status,
      403,
      "deny-all token must be rejected by the op gate",
    );
    assert.equal(
      (await request("narrow", "/engram/v1/adapters")).status,
      403,
      "narrow-ops token without adapters_status must be rejected",
    );
    const ok = await request("operator", "/engram/v1/adapters");
    assert.equal(
      ok.status,
      200,
      "unrestricted token must reach adapter metadata",
    );
    const body = (await ok.json()) as { adaptersEnabled?: boolean };
    assert.equal(
      typeof body.adaptersEnabled,
      "boolean",
      "adapter metadata body shape preserved",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP chat routes gate the resumed session's STORED namespace (issue #1850 finding 2)", async () => {
  // A chat session is an id-loaded record: its namespace comes from the stored
  // session header, NOT a ?namespace= query param. A namespace-scoped bearer
  // that knows a chatSessionId must not post to / stream a session in a
  // namespace outside its allow-list. The gate runs before delegation.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-chat-ns-gate-"));
  // Session bound to ns_a (no principal ⇒ accessible to anyone per
  // sessionBelongsToPrincipal, so the namespace gate is the ONLY gate in play).
  const session = await createChatSession(dir, { namespace: "ns_a" });
  const service = {
    configRef: parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryDir: dir,
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "scoped-ns-b",
        capabilities: { version: 1, namespaces: ["ns_b"] },
      },
      {
        token: "scoped-ns-a",
        capabilities: { version: 1, namespaces: ["ns_a"] },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const authed = (token: string) => ({
    headers: { authorization: `Bearer ${token}` },
  });
  try {
    // ── POST chat/message resuming a CROSS-namespace session → 403 ──
    const cross = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/chat/message`,
      {
        method: "POST",
        ...authed("scoped-ns-b"),
        headers: {
          ...authed("scoped-ns-b").headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hi", chatSessionId: session.id }),
      },
    );
    assert.equal(
      cross.status,
      403,
      "scoped-ns-b must NOT post to a session bound to ns_a",
    );

    // ── POST chat/message resuming a SAME-namespace session → passes the gate ──
    // (Chat is unconfigured here so the handler returns chat_disabled 404; the
    //  point is it is NOT 403 — the namespace gate let it through.)
    const same = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/chat/message`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer scoped-ns-a",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hi", chatSessionId: session.id }),
      },
    );
    assert.notEqual(
      same.status,
      403,
      "scoped-ns-a must pass the namespace gate for its own session",
    );

    // ── GET chat/events for a CROSS-namespace session → 403 ──
    const crossEvents = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/chat/events/${session.id}`,
      authed("scoped-ns-b"),
    );
    assert.equal(
      crossEvents.status,
      403,
      "scoped-ns-b must NOT stream a session bound to ns_a",
    );

    // ── GET chat/events for a SAME-namespace session → passes the gate ──
    const sameEvents = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/chat/events/${session.id}`,
      authed("scoped-ns-a"),
    );
    assert.notEqual(
      sameEvents.status,
      403,
      "scoped-ns-a must pass the namespace gate for its own session",
    );
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP per-request token capabilities never bleed across concurrent async requests (issue #1850 r7 ALS run fix)", async () => {
  // The capability store must be bound via run() (NOT enterWith) so each
  // request's async scope observes its OWN resolved capabilities across every
  // await. Interleave concurrent requests with DIFFERENT scopes against an
  // op+namespace-gated route whose service read yields, then assert:
  //   (1) a deny-all op token is ALWAYS rejected — never fail-opens to 200
  //       because its caps leaked to undefined/unrestricted mid-handler;
  //   (2) the store read AFTER an async yield inside the service still carries
  //       the REQUESTING token's scope on every call — zero cross-request bleed.
  const observed: Array<TokenCapabilities | undefined> = [];
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-als-concurrency",
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryBrowse: async () => {
      // Yield so concurrent requests overlap at this await — the exact window
      // where an enterWith-based store would read another request's caps (or
      // undefined). run() keeps each request in its own scope across the yield.
      await new Promise<void>((resolve) => setTimeout(resolve, 8));
      observed.push(tokenCapabilityStore.getStore());
      return { total: 0, memories: [] };
    },
    memoryGet: async () => ({ found: true }),
    peerList: async () => ({ peers: [] }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      { token: "deny-all", capabilities: { version: 1, ops: [] } },
      {
        token: "scoped-ns-a",
        capabilities: {
          version: 1,
          ops: ["memory_list"],
          namespaces: ["ns_a"],
        },
      },
      {
        token: "scoped-ns-b",
        capabilities: {
          version: 1,
          ops: ["memory_list"],
          namespaces: ["ns_b"],
        },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const get = (token: string, namespace: string) =>
    fetch(
      `http://127.0.0.1:${status.port}/engram/v1/memories?namespace=${namespace}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
  try {
    const REPEATS = 15;
    const batch: Promise<Response>[] = [];
    for (let i = 0; i < REPEATS; i++) {
      batch.push(get("deny-all", "ns_a")); // op-gate must reject (ops: [])
      batch.push(get("scoped-ns-a", "ns_a")); // passes op + ns gate, reaches service
      batch.push(get("scoped-ns-b", "ns_b")); // passes op + ns gate, reaches service
    }
    const responses = await Promise.all(batch);

    // (1) Op-gate holds under concurrency: every deny-all request is 403, never
    //     fail-open 200 (which would mean its caps bled to unrestricted).
    const denyAllStatuses = responses
      .filter((_, i) => i % 3 === 0)
      .map((r) => r.status);
    assert.ok(
      denyAllStatuses.every((s) => s === 403),
      `deny-all token must always be 403, got: ${JSON.stringify(denyAllStatuses)}`,
    );

    // scoped tokens reach the service (200) — op + namespace gates both pass.
    const nsAStatuses = responses
      .filter((_, i) => i % 3 === 1)
      .map((r) => r.status);
    const nsBStatuses = responses
      .filter((_, i) => i % 3 === 2)
      .map((r) => r.status);
    assert.ok(
      nsAStatuses.every((s) => s === 200),
      `scoped-ns-a should all be 200: ${JSON.stringify(nsAStatuses)}`,
    );
    assert.ok(
      nsBStatuses.every((s) => s === 200),
      `scoped-ns-b should all be 200: ${JSON.stringify(nsBStatuses)}`,
    );

    // (2) No cross-request bleed: the store read AFTER the async yield carried
    //     the REQUESTING token's namespace on every service call. memoryBrowse
    //     ran once per scoped request (2 * REPEATS).
    assert.equal(
      observed.length,
      2 * REPEATS,
      "memoryBrowse called once per scoped request",
    );
    const nsAObserved = observed.filter((c) =>
      c?.namespaces?.includes("ns_a"),
    ).length;
    const nsBObserved = observed.filter((c) =>
      c?.namespaces?.includes("ns_b"),
    ).length;
    assert.equal(
      nsAObserved,
      REPEATS,
      "every ns_a request observed its own scope — no bleed",
    );
    assert.equal(
      nsBObserved,
      REPEATS,
      "every ns_b request observed its own scope — no bleed",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP allow-capability is never inherited by a concurrent deny token across the async yield (issue #1850 r8 ALS non-inheritance)", async () => {
  // The r7 run() fix guarantees each request observes its OWN caps. The sharper
  // property: a token whose caps ALLOW the op+namespace (→ 200) interleaved
  // with deny tokens (→ 403) must NEVER let a deny request inherit the allow
  // token's capabilities — i.e. in the SAME batch where allow requests returned
  // 200, NO deny request ever returned 200. Distinct (op, namespace) per token
  // so the result can only come from each request's own resolved caps.
  const observed: Array<TokenCapabilities | undefined> = [];
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-als-noninherit",
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    memoryBrowse: async () => {
      // Real wall-clock yield — the LEGITIMATE timer exception: this test
      // exercises ALS async-scope isolation across CONCURRENT requests, so the
      // await must produce a genuine overlap window where an enterWith-based
      // store would read another request's caps. Deterministic fake timers
      // cannot force that cross-request overlap (mirrors the r7 sibling test).
      await new Promise<void>((resolve) => setTimeout(resolve, 8));
      observed.push(tokenCapabilityStore.getStore());
      return { total: 0, memories: [] };
    },
    memoryGet: async () => ({ found: true }),
    peerList: async () => ({ peers: [] }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      // ALLOW: op + namespace both permitted → 200.
      {
        token: "allow",
        capabilities: {
          version: 1,
          ops: ["memory_list"],
          namespaces: ["ns_allow"],
        },
      },
      // DENY (op-level): empty ops → 403 at the op-gate.
      { token: "deny-all", capabilities: { version: 1, ops: [] } },
      // DENY (namespace-level): op permitted but scoped to a DIFFERENT
      // namespace ("ns_other") than the request ("ns_allow") → 403 at the
      // namespace-gate. The ONLY way this becomes 200 is by inheriting the
      // allow token's ns_allow cap — exactly the bleed run() prevents.
      {
        token: "deny-ns",
        capabilities: {
          version: 1,
          ops: ["memory_list"],
          namespaces: ["ns_other"],
        },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const get = (token: string, namespace: string) =>
    fetch(
      `http://127.0.0.1:${status.port}/engram/v1/memories?namespace=${namespace}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
  try {
    const REPEATS = 15;
    const batch: Promise<Response>[] = [];
    for (let i = 0; i < REPEATS; i++) {
      batch.push(get("allow", "ns_allow")); // 3i   → 200
      batch.push(get("deny-all", "ns_allow")); // 3i+1 → 403 (op-gate)
      batch.push(get("deny-ns", "ns_allow")); // 3i+2 → 403 (namespace-gate)
    }
    const responses = await Promise.all(batch);
    const allowStatuses = responses
      .filter((_, i) => i % 3 === 0)
      .map((r) => r.status);
    const denyAllStatuses = responses
      .filter((_, i) => i % 3 === 1)
      .map((r) => r.status);
    const denyNsStatuses = responses
      .filter((_, i) => i % 3 === 2)
      .map((r) => r.status);

    // ALLOW requests succeed (200) — the caps DID resolve correctly and the
    // service read happened under the allow scope.
    assert.ok(
      allowStatuses.every((s) => s === 200),
      `allow token should all be 200: ${JSON.stringify(allowStatuses)}`,
    );

    // NON-INHERITANCE: in the SAME interleaved batch where allow got 200, every
    // deny request stayed 403 — neither deny token ever inherited the allow
    // token's capabilities (which would have been 200). Covers BOTH op-level
    // and namespace-level denial.
    assert.ok(
      denyAllStatuses.every((s) => s === 403),
      `deny-all token must never be 200 (never inherits allow caps): ${JSON.stringify(denyAllStatuses)}`,
    );
    assert.ok(
      denyNsStatuses.every((s) => s === 403),
      `deny-ns token must never be 200 (never inherits allow namespace): ${JSON.stringify(denyNsStatuses)}`,
    );
    // Both deny arrays are ALL 403 ⟹ neither contains a 200: in the same
    // interleaved batch where the allow token returned 200, no deny request
    // ever inherited the allow token's capabilities.

    // Only allow requests reached the service; the store read after the async
    // yield carried the allow token's namespace every time — zero deny bleed.
    assert.equal(
      observed.length,
      REPEATS,
      "only allow requests reached the service",
    );
    assert.ok(
      observed.every((c) => c?.namespaces?.includes("ns_allow")),
      "every service read carried the allow token's namespace — no deny bleed",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP chat/message gates the NEW session's namespace — scoped token cannot start a chat in a disallowed namespace (issue #1850 r7)", async () => {
  // A NEW chat turn (no chatSessionId) previously never hit the effective-
  // namespace chokepoint, so a namespace-scoped token could start a chat in the
  // server DEFAULT namespace even when "default" was outside its allow-list.
  // The new-session path must resolve the effective namespace (the server
  // default, since the HTTP chat handler forwards no namespace) and fail closed
  // against the token allow-list — same as the resume path.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-chat-new-ns-"));
  try {
    const service = {
      configRef: parseConfig({
        memoryDir: dir,
        namespacesEnabled: true,
        defaultNamespace: "default",
        chat: { ...DEFAULT_CHAT_CONFIG, enabled: true },
      }),
      memoryDir: dir,
      fallbackLlmRef: {
        chatCompletion: async () => ({ content: "stub reply" }),
      },
      localLlmRef: null,
      memoryGet: () => Promise.resolve(null),
      memoryTimeline: () => Promise.resolve([]),
      memorySearch: () => Promise.resolve({ results: [], count: 0 }),
      recallExplain: () => Promise.resolve(null),
      entityGet: () => Promise.resolve(null),
      memoryProfile: () => Promise.resolve({}),
      memoryEntitiesList: () => Promise.resolve({ items: [] }),
      memoryQuestions: () => Promise.resolve({ items: [] }),
      reviewQueue: () => Promise.resolve({ items: [] }),
    } as unknown as EngramAccessService;
    const server = new EngramAccessHttpServer({
      service,
      port: 0,
      authTokenEntriesGetter: () => [
        // scoped to ns_a (NOT the server default) — must be denied a new chat.
        {
          token: "scoped-ns-a",
          capabilities: {
            version: 1,
            ops: ["chat_message"],
            namespaces: ["ns_a"],
          },
        },
        // scoped to the server default — may start a new chat there.
        {
          token: "scoped-default",
          capabilities: {
            version: 1,
            ops: ["chat_message"],
            namespaces: ["default"],
          },
        },
      ],
      adminConsoleEnabled: false,
    });
    const status = await server.start();
    const post = (token: string) =>
      fetch(`http://127.0.0.1:${status.port}/engram/v1/chat/message`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hi" }), // no chatSessionId → NEW session
      });
    try {
      // DISALLOWED: token scoped to ns_a; the new session would land in the
      // server default ("default"), which is not in ["ns_a"] → 403.
      const denied = await post("scoped-ns-a");
      assert.equal(
        denied.status,
        403,
        "scoped-to-ns_a must not start a new chat in the default namespace",
      );

      // ALLOWED: token scoped to the server default → gate passes → chat runs
      // and returns 200 with a reply.
      const allowed = await post("scoped-default");
      assert.equal(
        allowed.status,
        200,
        "scoped-to-default may start a new chat in the default namespace",
      );
      const allowedBody = (await allowed.json()) as { reply?: string };
      assert.ok(
        allowedBody.reply && allowedBody.reply.length > 0,
        "allowed new chat returns a reply",
      );
    } finally {
      await server.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP recall forwards the connector from the authorized token entry", async () => {
  let captured: EngramAccessRecallRequest | undefined;
  const service = {
    recall: (request: EngramAccessRecallRequest) => {
      captured = request;
      return Promise.resolve({
        context: "",
        count: 0,
        memoryIds: [],
        results: [],
      });
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      { token: "connector-token", connector: "chatgpt" },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/recall`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer connector-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "shared namespace query" }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(captured?.sourceConnector, "chatgpt");
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// PR #1852: token-rotation race — authorized entry must be reused for provenance
// ---------------------------------------------------------------------------

test("PR #1852: token rotation between authorization and write does not stamp the wrong connector", async () => {
  // Race: the dynamic-token authorization resolves an entry (connector A),
  // then the provenance resolver re-reads the token store. If the store
  // rotated between the two reads, the OLD code stamped connector B. The
  // fix caches the matched entry per-request so the provenance comes from
  // the SAME entry that authorized.
  let getterCalls = 0;
  const entriesGetter = () => {
    getterCalls++;
    // First call (authorization): token -> "chatgpt".
    // Subsequent call (provenance in the OLD code): token -> "codex-cli".
    // With the fix the getter is called only once; the second call never
    // happens and the cached "chatgpt" entry is reused.
    if (getterCalls <= 1) {
      return [{ token: "race_token", connector: "chatgpt" }];
    }
    return [{ token: "race_token", connector: "codex-cli" }];
  };

  let capturedSourceConnector: string | undefined;
  const service = {
    memoryStore: (req: { sourceConnector?: string }) => {
      capturedSourceConnector = req.sourceConnector;
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

  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: entriesGetter,
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    const res = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/memories`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer race_token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content: "race-test memory",
          schemaVersion: 1,
          idempotencyKey: "race-key-1852",
        }),
      },
    );
    assert.equal(
      res.status,
      201,
      "memory_store must succeed with a valid entry token",
    );

    // The provenance must come from the entry that AUTHORIZED the request
    // ("chatgpt"), not from the rotated store ("codex-cli").
    assert.equal(
      capturedSourceConnector,
      "chatgpt",
      "sourceConnector must be from the authorized entry, not the rotated store",
    );
    // The getter must have been called only once — the matched entry is
    // cached per-request.
    assert.equal(
      getterCalls,
      1,
      "authTokenEntriesGetter must be called once (cached per-request)",
    );
  } finally {
    await server.stop();
  }
});

test("PR #1852: static operator token has no connector provenance under rotation", async () => {
  // An operator-supplied static token must never acquire connector provenance,
  // even when an entries getter is also configured and the static token
  // appears there under a different connector. This guards the short-circuit
  // in resolveMatchedEntry: static tokens return { token } (no connector).
  let capturedSourceConnector: string | undefined;
  const service = {
    memoryStore: (req: { sourceConnector?: string }) => {
      capturedSourceConnector = req.sourceConnector;
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

  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "operator-static",
    authTokenEntriesGetter: () => [
      { token: "operator-static", connector: "chatgpt" },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    const res = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/memories`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer operator-static",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content: "operator-token memory",
          schemaVersion: 1,
          idempotencyKey: "static-key-1852",
        }),
      },
    );
    assert.equal(res.status, 201);
    assert.equal(
      capturedSourceConnector,
      undefined,
      "static operator token must carry no connector provenance",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP namespace/writable preflight returns the structured writability result", async () => {
  // Real config through the pure resolver: the default namespace is writable
  // for any principal; a foreign namespace with no policy is not. A rejection
  // is a valid 200 answer (read via `ok`), not an HTTP error.
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-preflight-test",
      defaultNamespace: "default",
    }),
    namespaceWritablePreflight: async ({
      namespace,
    }: {
      namespace?: string;
    }) =>
      namespace && namespace !== "default"
        ? { ok: false as const, reason: "not_writable" as const, namespace }
        : { ok: true as const, namespace: "default" },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const okRes = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/namespace/writable?namespace=default`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.equal(okRes.status, 200);
    assert.deepEqual(await okRes.json(), { ok: true, namespace: "default" });

    const badRes = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/namespace/writable?namespace=team-x`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.equal(badRes.status, 200);
    const badBody = (await badRes.json()) as { ok: boolean; namespace: string };
    assert.equal(badBody.ok, false);
    assert.equal(badBody.namespace, "team-x");
  } finally {
    await server.stop();
  }
});

test("HTTP namespace/writable forwards project context to the scoped write preflight", async () => {
  let received:
    | {
        namespace?: string;
        sessionKey?: string;
        projectTag?: string;
        cwd?: string;
      }
    | undefined;
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-preflight-context",
      defaultNamespace: "default",
    }),
    namespaceWritablePreflight: async (request: {
      namespace?: string;
      sessionKey?: string;
      projectTag?: string;
      cwd?: string;
    }) => {
      received = request;
      return { ok: true as const, namespace: "derived-project-namespace" };
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/namespace/writable?session=s-1&projectTag=Acme%2FWebshop&cwd=%2Ftmp%2Frepo`,
      { headers: { authorization: "Bearer test-token" } },
    );
    assert.deepEqual(await response.json(), {
      ok: true,
      namespace: "derived-project-namespace",
    });
    assert.deepEqual(received, {
      namespace: undefined,
      sessionKey: "s-1",
      authenticatedPrincipal: undefined,
      projectTag: "Acme/Webshop",
      cwd: "/tmp/repo",
    });
  } finally {
    await server.stop();
  }
});

test("HTTP namespace/writable checks token scope against the effective scoped namespace", async () => {
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-preflight-effective",
      defaultNamespace: "default",
    }),
    namespaceWritablePreflight: async () => ({
      ok: true as const,
      namespace: "principal-project-derived",
    }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "default-only",
        capabilities: { version: 1, ops: ["observe"], namespaces: ["default"] },
      },
    ],
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/namespace/writable?session=s-1&projectTag=Acme%2FWebshop`,
      { headers: { authorization: "Bearer default-only" } },
    );
    assert.deepEqual(await response.json(), {
      ok: false,
      reason: "not_writable",
      namespace: "principal-project-derived",
    });
  } finally {
    await server.stop();
  }
});

test("HTTP namespace/writable preflight admits write-scoped tokens and rejects read-only ops", async () => {
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-preflight-ops-test",
      defaultNamespace: "default",
    }),
    namespaceWritablePreflight: async () => ({
      ok: true as const,
      namespace: "default",
    }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "write-scoped",
        capabilities: { version: 1, ops: ["observe", "memory_store"] },
      },
      {
        token: "store-only",
        capabilities: { version: 1, ops: ["memory_store"] },
      },
      {
        token: "diagnostic-only",
        capabilities: { version: 1, ops: ["namespace_writable"] },
      },
      { token: "read-only", capabilities: { version: 1, ops: ["recall"] } },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const request = (token: string, op?: string) =>
    fetch(
      `http://127.0.0.1:${status.port}/engram/v1/namespace/writable?namespace=default${op ? `&op=${op}` : ""}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  const okOf = async (r: Response) => {
    const body = (await r.json()) as { ok?: unknown };
    return body.ok;
  };
  try {
    // A token scoped to write ops but NOT the namespace_writable op (e.g. minted
    // before this endpoint existed) may still run the preflight.
    const writeScoped = await request("write-scoped");
    assert.equal(writeScoped.status, 200);
    assert.equal(await okOf(writeScoped), true);
    // Config-aware write op: a memory_store-only token is writable for the
    // explicit store path (?op=memory_store) but not for the automatic observe
    // path (default), which it cannot perform.
    assert.equal(await okOf(await request("store-only", "memory_store")), true);
    assert.equal(await okOf(await request("store-only")), false);
    // A token scoped to the diagnostic op ONLY can call the endpoint but cannot
    // write, so the answer is a definitive not-writable (never a false ok:true).
    const diag = await request("diagnostic-only");
    assert.equal(diag.status, 200);
    assert.equal(await okOf(diag), false);
    // A read-only token cannot write, so it has nothing to preflight → 403.
    assert.equal((await request("read-only")).status, 403);
    const invalidOp = await request("write-scoped", "memory_stroe");
    assert.equal(invalidOp.status, 400);
    assert.match(
      JSON.stringify(await invalidOp.json()),
      /unsupported namespace preflight operation: memory_stroe/,
    );
  } finally {
    await server.stop();
  }
});

test("HTTP meetings build enforces the per-principal write rate limit (issue #1937)", async () => {
  let builds = 0;
  const service = {
    meetingsBuild: async (date: string) => {
      builds += 1;
      return { enabled: true, date, meetings: [] };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });
  const status = await server.start();
  try {
    const build = () =>
      fetch(`http://127.0.0.1:${status.port}/engram/v1/meetings/build`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ date: "2026-03-10" }),
      });
    const first = await build();
    assert.equal(
      first.status,
      200,
      "the first build is within the write quota",
    );
    const second = await build();
    assert.equal(
      second.status,
      429,
      "the second build exceeds the per-principal write quota",
    );
    const rateLimited = (await second.json()) as { code?: string };
    assert.equal(rateLimited.code, "write_rate_limited");
    assert.equal(
      builds,
      1,
      "the rate-limited build never reached the service (no persist/reindex)",
    );
  } finally {
    await server.stop();
  }
});
test("HTTP-MCP extraction force-flush aliases consume the write quota", async () => {
  let flushes = 0;
  const service = {
    extractionForceFlush: async () => {
      flushes += 1;
      return {
        flushed: true,
        sessionKey: "session-1",
        namespace: "default",
        effectiveNamespace: "default",
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });
  const status = await server.start();
  try {
    const responses: Response[] = [];
    for (const name of [
      "remnic.extraction_force_flush",
      "engram.extraction_force_flush",
    ]) {
      responses.push(
        await fetch(`http://127.0.0.1:${status.port}/mcp`, {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: name,
            method: "tools/call",
            params: {
              name,
              arguments: {
                sessionKey: "session-1",
                namespace: "default",
                cwd: "/workspace/project",
                projectTag: "Acme/Webshop",
                deadlineMs: Date.now() + 60_000,
              },
            },
          }),
        }),
      );
    }
    const [first, second] = responses;
    assert.equal(first.status, 200);
    await first.text();
    assert.equal(second.status, 429);
    const rateLimited = (await second.json()) as { code?: string };
    assert.equal(rateLimited.code, "write_rate_limited");
    assert.equal(
      flushes,
      1,
      "the rate-limited alias must not reach the service",
    );
  } finally {
    await server.stop();
  }
});

test("concurrent support-passport MCP writes reserve quota before dispatch", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const releaseWrites = Promise.withResolvers<void>();
  let writes = 0;
  let requestId = 0;
  const service = {
    supportPassportGenerateDrafts: async () => {
      writes += 1;
      if (writes === 1) firstStarted.resolve();
      if (writes === 2) secondStarted.resolve();
      await releaseWrites.promise;
      return [];
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });
  const status = await server.start();
  const generate = () =>
    fetch(`http://127.0.0.1:${status.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: {
          name: "remnic.support_passport_drafts_generate",
          arguments: {
            sourceMemoryIds: ["memory-1"],
            sourceMemoryRevisions: [
              { memoryId: "memory-1", revision: "a".repeat(64) },
            ],
            consent: true,
          },
        },
      }),
    });
  try {
    const firstRequest = generate();
    await firstStarted.promise;
    const secondRequest = generate();
    const secondOutcome = await Promise.race([
      secondRequest.then(() => "rate-limited" as const),
      secondStarted.promise.then(() => "dispatched" as const),
    ]);
    assert.equal(secondOutcome, "rate-limited");
    releaseWrites.resolve();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(writes, 1);
  } finally {
    releaseWrites.resolve();
    await server.stop();
  }
});

test("support-passport MCP keeps reserved quota when generated drafts commit before failure", async () => {
  let writes = 0;
  let requestId = 0;
  const service = {
    supportPassportGenerateDrafts: async (
      _principal: string,
      input: { onCommitted?: () => void },
    ) => {
      writes += 1;
      input.onCommitted?.();
      throw new SupportPassportError(
        "state_conflict",
        "Draft cleanup failed.",
        409,
      );
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });
  const status = await server.start();
  const generate = () =>
    fetch(`http://127.0.0.1:${status.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: {
          name: "remnic.support_passport_drafts_generate",
          arguments: {
            sourceMemoryIds: ["memory-1"],
            sourceMemoryRevisions: [
              { memoryId: "memory-1", revision: "a".repeat(64) },
            ],
            consent: true,
          },
        },
      }),
    });
  try {
    const first = await generate();
    assert.equal(first.status, 200);
    assert.equal(
      ((await first.json()) as { result?: { isError?: boolean } }).result
        ?.isError,
      true,
    );
    assert.equal(
      (await generate()).status,
      429,
      "the committed draft keeps its reserved MCP quota slot",
    );
    assert.equal(writes, 1);
  } finally {
    await server.stop();
  }
});

test("support-passport MCP applies the write quota to share-link revocation", async () => {
  let drafts = 0;
  let revocations = 0;
  const service = {
    supportPassportEnabled: true,
    supportPassportCreateManualDraft: async () => {
      drafts += 1;
      return { cardId: "card-one" };
    },
    supportPassportRevokeGrant: async () => {
      revocations += 1;
      return {
        grantId: "grant-one",
        revokedAt: "2026-08-11T12:05:00.000Z",
        version: 2,
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });
  const status = await server.start();
  const call = (name: string, args: Record<string, unknown>, id: number) =>
    fetch(`http://127.0.0.1:${status.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
  try {
    const draft = await call(
      "remnic.support_passport_draft_create",
      {
        title: "Plan changes",
        statement: "Tell me before plans change.",
        category: "transitions",
        reviewBy: "2027-02-07T12:00:00.000Z",
      },
      1,
    );
    assert.equal(draft.status, 200);
    const revoked = await call(
      "remnic.support_passport_grant_revoke",
      {
        grantId: "grant-one",
        expectedVersion: 1,
      },
      2,
    );
    assert.equal(revoked.status, 429);
    assert.equal(drafts, 1);
    assert.equal(revocations, 0);
  } finally {
    await server.stop();
  }
});

test("HTTP extraction force-flush records quota after commit when cleanup fails", async () => {
  let flushes = 0;
  let committed = 0;
  const service = {
    extractionForceFlush: async (request: { onCommitted?: () => void }) => {
      flushes += 1;
      request.onCommitted?.();
      committed += 1;
      throw new Error("retained cleanup deadline");
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });
  const status = await server.start();
  const flush = () =>
    fetch(`http://127.0.0.1:${status.port}/engram/v1/extraction/flush`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionKey: "session-1" }),
    });
  try {
    const first = await flush();
    assert.equal(first.status, 500);
    await first.text();
    const second = await flush();
    assert.equal(second.status, 429);
    const rateLimited = (await second.json()) as { code?: string };
    assert.equal(rateLimited.code, "write_rate_limited");
    assert.equal(flushes, 1);
    assert.equal(committed, 1);
  } finally {
    await server.stop();
  }
});

test("HTTP-MCP extraction force-flush records quota at the commit boundary", async () => {
  let flushes = 0;
  let committed = 0;
  const service = {
    extractionForceFlush: async (request: { onCommitted?: () => void }) => {
      flushes += 1;
      if (request.onCommitted) {
        committed += 1;
        request.onCommitted();
      }
      throw new Error("retained cleanup deadline");
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });
  const status = await server.start();
  const flush = () =>
    fetch(`http://127.0.0.1:${status.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "extraction-force-flush",
        method: "tools/call",
        params: {
          name: "remnic.extraction_force_flush",
          arguments: { sessionKey: "session-1" },
        },
      }),
    });
  try {
    const first = await flush();
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    assert.equal(firstBody.result?.isError, true);
    const second = await flush();
    assert.equal(second.status, 429);
    const rateLimited = (await second.json()) as { code?: string };
    assert.equal(rateLimited.code, "write_rate_limited");
    assert.equal(
      flushes,
      1,
      "the rate-limited MCP flush must not reach the service",
    );
    assert.equal(committed, 1);
  } finally {
    await server.stop();
  }
});

test("HTTP meetings get returns 400 (not 500) for a malformed percent-encoded id (issue #1900)", async () => {
  let called = 0;
  const service = {
    meetingsGet: async () => {
      called += 1;
      return { enabled: true, found: false, id: "x", record: null };
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
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/meetings/%E0%A4%A`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );
    assert.equal(
      response.status,
      400,
      "a malformed id is a client error, not an internal 500",
    );
    const errorBody = (await response.json()) as { code?: string };
    assert.equal(errorBody.code, "invalid_request");
    assert.equal(called, 0, "the malformed id never reached the service");
  } finally {
    await server.stop();
  }
});

test("HTTP authorization probe verifies requested operation grants without invoking operations (issue #2129)", async () => {
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-authorization-probe",
      defaultNamespace: "default",
    }),
  } as unknown as EngramAccessService;
  const implicitNamespaceOperations = [
    "offline_sync_snapshot",
    "offline_sync_snapshot_stream",
    "memory_list",
    "entity_list",
    "maintenance_status",
    "quality_status",
    "trust_zones_status",
    "graph_events",
    "citations_observed",
  ];
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "delegate-token",
        capabilities: {
          version: 1,
          ops: ["recall", "observe", "lcm_compaction_flush"],
        },
      },
      {
        token: "recall-only-token",
        capabilities: { version: 1, ops: ["recall"] },
      },
      {
        token: "observe-only-token",
        capabilities: { version: 1, ops: ["observe"] },
      },
      {
        token: "namespace-scoped-delegate-token",
        capabilities: {
          version: 1,
          ops: ["recall", "observe", "lcm_compaction_flush"],
          namespaces: ["other"],
        },
      },
      {
        token: "resource-scoped-chat-token",
        capabilities: {
          version: 1,
          ops: ["chat_message", "contradiction_detail"],
          namespaces: ["other"],
        },
      },
      {
        token: "namespace-scoped-adapters-token",
        capabilities: {
          version: 1,
          ops: ["adapters_status"],
          namespaces: ["other"],
        },
      },
      {
        token: "implicit-namespace-token",
        capabilities: {
          version: 1,
          ops: implicitNamespaceOperations,
          namespaces: ["other"],
        },
      },
      {
        token: "fleet-scoped-token",
        capabilities: {
          version: 1,
          ops: ["continuity_audit_generate"],
          namespaces: ["default"],
        },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const probe = (token: string, operations: string[], namespace?: string) => {
    const query = new URLSearchParams();
    for (const operation of operations) query.append("op", operation);
    if (namespace !== undefined) query.set("namespace", namespace);
    return fetch(
      `http://127.0.0.1:${status.port}/engram/v1/authorization?${query}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
  };
  const delegateOperations = ["recall", "observe", "lcm_compaction_flush"];
  try {
    const authorized = await probe("delegate-token", [
      ...delegateOperations,
      "recall",
    ]);
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("cache-control"), "no-store");
    assert.deepEqual(await authorized.json(), {
      authorized: true,
      operations: delegateOperations,
    });

    const alternateGrant = await probe("observe-only-token", [
      "namespace_writable",
    ]);
    assert.equal(alternateGrant.status, 200);
    await alternateGrant.text();

    const namespaceDiagnostic = await probe("namespace-scoped-delegate-token", [
      "namespace_writable",
    ]);
    assert.equal(
      namespaceDiagnostic.status,
      200,
      "writability diagnostics report scope in their response",
    );
    await namespaceDiagnostic.text();

    const namespaceAgnostic = await probe("namespace-scoped-adapters-token", [
      "adapters_status",
    ]);
    assert.equal(
      namespaceAgnostic.status,
      200,
      "namespace-free operations must not use the daemon default",
    );
    await namespaceAgnostic.text();

    const namespaceDenied = await probe(
      "namespace-scoped-delegate-token",
      delegateOperations,
    );
    assert.equal(
      namespaceDenied.status,
      403,
      "a scoped token must cover the daemon default namespace",
    );

    for (const operation of implicitNamespaceOperations) {
      const implicitNamespace = await probe("implicit-namespace-token", [
        operation,
      ]);
      assert.equal(
        implicitNamespace.status,
        403,
        `${operation} must authorize the effective namespace`,
      );
      await implicitNamespace.text();
    }
    await namespaceDenied.text();

    const namespaceAllowed = await probe(
      "namespace-scoped-delegate-token",
      delegateOperations,
      "other",
    );
    assert.equal(namespaceAllowed.status, 200);
    await namespaceAllowed.text();

    const resourceNamespaceProbe = await probe(
      "resource-scoped-chat-token",
      ["chat_message", "contradiction_detail"],
      "other",
    );
    assert.equal(
      resourceNamespaceProbe.status,
      200,
      "resource-scoped probes must not claim a namespace they cannot resolve without a resource id",
    );
    await resourceNamespaceProbe.text();

    const fleetWide = await probe("fleet-scoped-token", [
      "continuity_audit_generate",
    ]);
    assert.equal(fleetWide.status, 403);
    assert.equal(fleetWide.headers.get("cache-control"), "no-store");
    await fleetWide.text();

    const denied = await probe("recall-only-token", delegateOperations);
    assert.equal(
      denied.status,
      403,
      "a token missing any requested operation is rejected without running it",
    );
    assert.equal(denied.headers.get("cache-control"), "no-store");
    await denied.text();

    const wrongToken = await probe("wrong-token", delegateOperations);
    assert.equal(wrongToken.status, 401);
    await wrongToken.text();

    const empty = await probe("delegate-token", []);
    assert.equal(empty.status, 400);
    assert.equal(empty.headers.get("cache-control"), "no-store");
    await empty.text();

    const unknown = await probe("delegate-token", ["not_an_operation"]);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.headers.get("cache-control"), "no-store");
    await unknown.text();

    for (const helperOperation of [
      "support_passport_grant_read",
      "support_passport_grant_ask",
    ]) {
      const helperOnly = await probe("delegate-token", [helperOperation]);
      assert.equal(
        helperOnly.status,
        400,
        `${helperOperation} cannot use bearer authorization probes`,
      );
      assert.equal(helperOnly.headers.get("cache-control"), "no-store");
      await helperOnly.text();
    }
  } finally {
    await server.stop();
  }
});

test("HTTP authorization probe checks the principal-derived support passport namespace", async () => {
  let namespaceResolutions = 0;
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-passport-authorization-probe",
      defaultNamespace: "default",
      namespacesEnabled: true,
      namespacePolicies: [
        {
          name: "owner:alice",
          readPrincipals: ["owner:alice"],
          writePrincipals: ["owner:alice"],
        },
      ],
    }),
    getWritableStorageForNamespace: async (
      namespace: string | undefined,
      principal: string | undefined,
    ) => {
      namespaceResolutions += 1;
      assert.equal(namespace, undefined);
      assert.equal(principal, "owner:alice");
      return { namespace: "owner:alice", storage: {} as StorageManager };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    principal: "owner:alice",
    authTokenEntriesGetter: () => [
      {
        token: "passport-token",
        capabilities: {
          version: 1,
          ops: ["support_passport_cards_list"],
          namespaces: ["other"],
        },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/authorization?op=support_passport_cards_list&namespace=other`,
      { headers: { authorization: "Bearer passport-token" } },
    );

    assert.equal(response.status, 403);
    assert.equal(namespaceResolutions, 1);
  } finally {
    await server.stop();
  }
});

test("HTTP authorization probe rejects support passport access without a trusted principal", async () => {
  let namespaceResolutions = 0;
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-passport-principal-probe",
      defaultNamespace: "default",
    }),
    getWritableStorageForNamespace: async () => {
      namespaceResolutions += 1;
      return { namespace: "default", storage: {} as StorageManager };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "passport-token",
        capabilities: { version: 1, ops: ["support_passport_cards_list"] },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/engram/v1/authorization?op=support_passport_cards_list`,
      { headers: { authorization: "Bearer passport-token" } },
    );

    assert.equal(response.status, 403);
    assert.equal(namespaceResolutions, 0);
  } finally {
    await server.stop();
  }
});

test("HTTP capabilities explicitly advertise receiver convergence finalization", async () => {
  const service = {} as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });

  const status = await server.start();
  try {
    const route = `http://127.0.0.1:${status.port}/engram/v1/capabilities`;
    const denied = await fetch(route);
    assert.equal(denied.status, 401);

    const response = await fetch(route, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      lcmCompactionFlushBatch: true,
      offlineSyncConvergenceComplete: true,
      memoriesSearch: true,
    });
  } finally {
    await server.stop();
  }
});

test("HTTP convergence completion forwards one authenticated namespace batch refresh", async () => {
  const calls: Array<{
    namespaces: string[];
    principal?: string;
    sourceId: string;
  }> = [];
  const service = {
    offlineSyncFinalizeConvergence: async (options: {
      namespaces: string[];
      principal?: string;
      sourceId: string;
    }) => {
      calls.push(options);
      return { namespaces: options.namespaces, refreshed: true as const };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    principal: "writer",
    adminConsoleEnabled: false,
  });
  const route =
    "/remnic/v1/offline-sync/convergence-complete?namespace=team&namespace=shared";

  const status = await server.start();
  try {
    const denied = await fetch(`http://127.0.0.1:${status.port}${route}`, {
      method: "POST",
      headers: { "x-remnic-source-id": encodeURIComponent("remnic-converge") },
    });
    assert.equal(denied.status, 401);

    const response = await fetch(`http://127.0.0.1:${status.port}${route}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "x-remnic-source-id": encodeURIComponent("remnic-converge"),
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      namespaces: ["team", "shared"],
      refreshed: true,
    });
    assert.deepEqual(calls, [
      {
        namespaces: ["team", "shared"],
        principal: "writer",
        sourceId: "remnic-converge",
      },
    ]);
  } finally {
    await server.stop();
  }
});

test("HTTP convergence completion accepts either receiver mutation grant", async () => {
  let completions = 0;
  const service = {
    offlineSyncFinalizeConvergence: async () => {
      completions += 1;
      return { namespaces: ["team"], refreshed: true as const };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "file-token",
        capabilities: { version: 1, ops: ["offline_sync_apply_file_content"] },
      },
      {
        token: "delete-token",
        capabilities: { version: 1, ops: ["offline_sync_apply"] },
      },
      {
        token: "read-token",
        capabilities: { version: 1, ops: ["offline_sync_snapshot"] },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const route = `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/convergence-complete?namespace=team`;
  const complete = (token: string) =>
    fetch(route, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-remnic-source-id": encodeURIComponent("remnic-converge"),
      },
    });

  try {
    const fileResponse = await complete("file-token");
    assert.equal(fileResponse.status, 200);
    await fileResponse.text();
    const deleteResponse = await complete("delete-token");
    assert.equal(deleteResponse.status, 200);
    await deleteResponse.text();
    const deniedResponse = await complete("read-token");
    assert.equal(deniedResponse.status, 403);
    await deniedResponse.text();
    assert.equal(completions, 2);
  } finally {
    await server.stop();
  }
});

test("HTTP convergence completion enforces the per-principal write rate limit", async () => {
  let completions = 0;
  const service = {
    offlineSyncFinalizeConvergence: async () => {
      completions += 1;
      return { namespaces: ["team"], refreshed: true as const };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
    writeRateLimitMaxRequests: 1,
  });
  const status = await server.start();
  const route = `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/convergence-complete?namespace=team`;
  const requestOptions: RequestInit = {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "x-remnic-source-id": encodeURIComponent("remnic-converge"),
    },
  };

  try {
    const first = await fetch(route, requestOptions);
    assert.equal(first.status, 200);
    await first.text();

    const second = await fetch(route, requestOptions);
    assert.equal(second.status, 429);
    const rateLimited: unknown = await second.json();
    assert.ok(
      rateLimited && typeof rateLimited === "object" && "code" in rateLimited,
    );
    assert.equal(rateLimited.code, "write_rate_limited");
    assert.equal(
      completions,
      1,
      "the rate-limited completion must not reach the service",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP convergence completion denies scoped tokens that omit the namespace", async () => {
  let completions = 0;
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-convergence-completion-namespace",
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    offlineSyncFinalizeConvergence: async () => {
      completions += 1;
      return { namespaces: ["default"], refreshed: true as const };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      {
        token: "scoped-token",
        capabilities: { version: 1, namespaces: ["team"] },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();

  try {
    const response = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/offline-sync/convergence-complete`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer scoped-token",
          "x-remnic-source-id": encodeURIComponent("remnic-converge"),
        },
      },
    );

    assert.equal(response.status, 403);
    await response.text();
    assert.equal(
      completions,
      0,
      "the denied completion must not reach the service",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP external wiki search aliases return the same cited result", async () => {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-http-external-wiki-"),
  );
  await mkdir(path.join(rootDir, "wiki"), { recursive: true });
  await writeFile(
    path.join(rootDir, "INDEX.md"),
    "- [[wiki/planning|Planning Systems]] - deterministic planner fan-out\n",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "wiki", "planning.md"),
    "# Planning Systems\n\nDeterministic planner fan-out keeps cited evidence.\n",
    "utf8",
  );
  const service = {
    configRef: {
      externalWikis: [
        {
          id: "planning",
          rootDir,
          enabled: true,
          pagesDir: "wiki",
          indexFile: "INDEX.md",
          indexInQmd: false,
          includeInDefaultRecall: false,
        },
      ],
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
    let canonicalBody: unknown;
    for (const prefix of ["remnic", "engram"]) {
      const response = await fetch(
        `http://127.0.0.1:${status.port}/${prefix}/v1/external-wikis/search`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: "deterministic planner",
            wikiId: "planning",
            limit: 2,
            maxCharsPerHit: 200,
          }),
        },
      );
      assert.equal(response.status, 200);
      const body: unknown = await response.json();
      if (canonicalBody === undefined) canonicalBody = body;
      else assert.deepEqual(body, canonicalBody);
    }
    assert.ok(
      canonicalBody &&
        typeof canonicalBody === "object" &&
        "hits" in canonicalBody,
    );
    assert.ok(Array.isArray(canonicalBody.hits));
    const firstHit = canonicalBody.hits[0];
    assert.ok(firstHit && typeof firstHit === "object" && "path" in firstHit);
    assert.equal(firstHit.path, "wiki/planning.md");

    const invalid = await fetch(
      `http://127.0.0.1:${status.port}/remnic/v1/external-wikis/search`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "  " }),
      },
    );
    assert.equal(invalid.status, 400);
  } finally {
    await server.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("HTTP memory search aliases dispatch the boundary operation identically", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    memorySearch: async (request: Record<string, unknown>) => {
      calls.push(request);
      return {
        query: request.query,
        results: [
          {
            path: "facts/alice.md",
            score: 0.71,
            snippet: "alice prefers dark mode",
          },
        ],
        count: 1,
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    principal: "operator",
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  try {
    let canonicalBody: unknown;
    for (const prefix of ["engram", "remnic"]) {
      const response = await fetch(
        `http://127.0.0.1:${status.port}/${prefix}/v1/memories/search`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: "dark mode", maxResults: 3 }),
        },
      );
      assert.equal(response.status, 200);
      const body: unknown = await response.json();
      if (canonicalBody === undefined) canonicalBody = body;
      else
        assert.deepEqual(
          body,
          canonicalBody,
          "both prefixes must return one shape",
        );
    }
    assert.deepEqual(canonicalBody, {
      query: "dark mode",
      results: [
        {
          path: "facts/alice.md",
          score: 0.71,
          snippet: "alice prefers dark mode",
        },
      ],
      count: 1,
    });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.query, "dark mode");
      assert.equal(call.maxResults, 3);
      assert.equal(
        call.principal,
        "operator",
        "the authenticated principal — not a client field — scopes the search",
      );
    }
  } finally {
    await server.stop();
  }
});

test("HTTP memory search rejects an invalid body before service dispatch", async () => {
  const calls: unknown[] = [];
  const service = {
    memorySearch: async (request: unknown) => {
      calls.push(request);
      return { query: "", results: [], count: 0 };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "test-token",
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${status.port}/engram/v1/memories/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await post({ query: "   " })).status,
      400,
      "blank query is rejected",
    );
    assert.equal((await post({})).status, 400, "a missing query is rejected");
    assert.equal(
      (await post({ query: "ok", maxResults: 0 })).status,
      400,
      "maxResults must be >= 1",
    );
    assert.equal(
      (await post({ query: "ok", namespace: 123 })).status,
      400,
      "a non-string namespace is rejected, not silently defaulted to the principal's scope",
    );
    assert.equal((await post({ query: "ok", namespace: ["a"] })).status, 400);
    assert.equal((await post({ query: "ok", namespace: {} })).status, 400);
    assert.equal(calls.length, 0, "no invalid request may reach the service");
    assert.equal(
      (await post({ query: "ok", namespace: null })).status,
      200,
      "an explicit null keeps its documented no-namespace meaning",
    );
    assert.equal(calls.length, 1);
  } finally {
    await server.stop();
  }
});

test("HTTP memory search enforces token op and namespace allow-lists", async () => {
  const calls: unknown[] = [];
  const service = {
    memorySearch: async (request: unknown) => {
      calls.push(request);
      return { query: "q", results: [], count: 0 };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    principal: "reader",
    authTokenEntriesGetter: () => [
      { token: "wrong-op", capabilities: { version: 1, ops: ["recall"] } },
      {
        token: "wrong-namespace",
        capabilities: {
          version: 1,
          ops: ["memory_search"],
          namespaces: ["other"],
        },
      },
      {
        token: "reader",
        capabilities: {
          version: 1,
          ops: ["memory_search"],
          namespaces: ["team"],
        },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const post = (token: string, body: unknown) =>
    fetch(`http://127.0.0.1:${status.port}/engram/v1/memories/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await post("wrong-op", { query: "q", namespace: "team" })).status,
      403,
    );
    assert.equal(
      (await post("wrong-namespace", { query: "q", namespace: "team" })).status,
      403,
      "a body namespace outside the token allow-list must fail closed",
    );
    assert.equal(calls.length, 0, "no denied request may reach the service");
    assert.equal(
      (await post("reader", { query: "q", namespace: "team" })).status,
      200,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      (calls[0] as { namespace?: unknown }).namespace,
      "team",
      "the gated namespace reaches the service",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP memory search binds a scoped token to one namespace instead of fanning out", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    configRef: { defaultNamespace: "generalist" },
    memorySearch: async (request: Record<string, unknown>) => {
      calls.push(request);
      return { query: "q", results: [], count: 0 };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    principal: "reader",
    authTokenEntriesGetter: () => [
      {
        token: "scoped",
        capabilities: {
          version: 1,
          ops: ["memory_search"],
          namespaces: ["generalist"],
        },
      },
      {
        token: "unrestricted",
        capabilities: { version: 1, ops: ["memory_search"] },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const post = (token: string) =>
    fetch(`http://127.0.0.1:${status.port}/engram/v1/memories/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "q" }),
    });
  try {
    assert.equal((await post("scoped")).status, 200);
    assert.equal(
      calls[0]?.namespace,
      "generalist",
      "an omitted namespace on a scoped token binds to the allowed effective namespace",
    );
    assert.equal((await post("unrestricted")).status, 200);
    assert.equal(
      calls[1]?.namespace,
      undefined,
      "an unrestricted token keeps the principal-wide fan-out",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP memory search forwards a validated ranking mode and trims the namespace", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    configRef: { defaultNamespace: "generalist" },
    memorySearch: async (request: Record<string, unknown>) => {
      calls.push(request);
      return { query: "q", results: [], count: 0 };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    principal: "reader",
    authTokenEntriesGetter: () => [
      {
        token: "scoped",
        capabilities: {
          version: 1,
          ops: ["memory_search"],
          namespaces: ["team"],
        },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${status.port}/engram/v1/memories/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer scoped",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await post({ query: "q", namespace: "  team  ", mode: "vector" }))
        .status,
      200,
      "surrounding whitespace must not 403 a namespace the token allows",
    );
    assert.equal(calls[0]?.namespace, "team");
    assert.equal(
      calls[0]?.mode,
      "vector",
      "the ranking mode reaches the service",
    );
    assert.equal(
      (await post({ query: "q", namespace: "team", mode: "vsearch" })).status,
      400,
      "an unknown ranking mode is rejected, not silently ignored",
    );
    assert.equal(calls.length, 1);
  } finally {
    await server.stop();
  }
});

test("HTTP memory search excludes artifacts and tops up to a full page", async () => {
  // Artifacts rank above real memories. Filtering after the cap would return a
  // thin page; the search must keep asking until the budget is met.
  const seen: number[] = [];
  const corpus = [
    { path: "artifacts/a1.md", score: 0.99, snippet: "artifact" },
    { path: "artifacts/a2.md", score: 0.98, snippet: "artifact" },
    { path: "artifacts/a3.md", score: 0.97, snippet: "artifact" },
    { path: "facts/one.md", score: 0.5, snippet: "one" },
    { path: "facts/two.md", score: 0.4, snippet: "two" },
  ];
  const { runScopedMemorySearch } =
    await import("./access-memory-search-fanout.js");
  const results = await runScopedMemorySearch({
    query: "q",
    budget: 2,
    sendInitialLimit: true,
    authorizeScope: () => {},
    namespacesEnabled: false,
    isExcluded: (memoryPath) => memoryPath.startsWith("artifacts/"),
    filterPrivate: async (hits) => hits,
    flatCorpus: async (limit) => {
      seen.push(limit ?? -1);
      return corpus.slice(0, limit);
    },
    namespaced: async () => [],
  });
  assert.deepEqual(
    results.map((hit) => hit.path),
    ["facts/one.md", "facts/two.md"],
    "a full page of real memories",
  );
  assert.deepEqual(
    seen,
    [2, 4, 8],
    "doubles the candidate request until the budget is met",
  );
});

test("HTTP memory search stops topping up when the corpus is exhausted", async () => {
  const seen: number[] = [];
  const { runScopedMemorySearch } =
    await import("./access-memory-search-fanout.js");
  const results = await runScopedMemorySearch({
    query: "q",
    budget: 5,
    sendInitialLimit: true,
    authorizeScope: () => {},
    namespacesEnabled: false,
    isExcluded: (memoryPath) => memoryPath.startsWith("artifacts/"),
    filterPrivate: async (hits) => hits,
    flatCorpus: async (limit) => {
      seen.push(limit ?? -1);
      return [{ path: "facts/only.md", score: 0.5, snippet: "only" }];
    },
    namespaced: async () => [],
  });
  assert.equal(results.length, 1);
  assert.deepEqual(
    seen,
    [5],
    "a short page means there is nothing left to fetch",
  );
});

test("HTTP memory search omits maxResults when the caller named no budget", async () => {
  // The wire stays exactly as it was for the default request: the backend's
  // own page size, not a resolved number. Top-up rounds are explicit.
  const seen: Array<number | undefined> = [];
  const { runScopedMemorySearch } =
    await import("./access-memory-search-fanout.js");
  const results = await runScopedMemorySearch({
    query: "q",
    budget: 3,
    sendInitialLimit: false,
    authorizeScope: () => {},
    namespacesEnabled: false,
    isExcluded: (memoryPath) => memoryPath.startsWith("artifacts/"),
    filterPrivate: async (hits) => hits,
    flatCorpus: async (limit) => {
      seen.push(limit);
      const corpus = [
        { path: "artifacts/a1.md", score: 0.9, snippet: "artifact" },
        { path: "facts/one.md", score: 0.5, snippet: "one" },
        { path: "facts/two.md", score: 0.4, snippet: "two" },
        { path: "facts/three.md", score: 0.3, snippet: "three" },
      ];
      return limit === undefined ? corpus.slice(0, 3) : corpus.slice(0, limit);
    },
    namespaced: async () => [],
  });
  assert.deepEqual(
    seen,
    [undefined, 6],
    "first request carries no cap, the top-up does",
  );
  assert.deepEqual(
    results.map((hit) => hit.path),
    ["facts/one.md", "facts/two.md", "facts/three.md"],
  );
});

test("HTTP memory search keeps topping up past four excluded pages", async () => {
  // Eight pages of artifacts ahead of the real memories: a fixed round count
  // would give up and report a thin page while valid hits sit right behind.
  const corpus = [
    ...Array.from({ length: 40 }, (_, index) => ({
      path: `artifacts/a${index}.md`,
      score: 1 - index / 100,
      snippet: "artifact",
    })),
    { path: "facts/one.md", score: 0.1, snippet: "one" },
    { path: "facts/two.md", score: 0.09, snippet: "two" },
  ];
  const seen: Array<number | undefined> = [];
  const { runScopedMemorySearch } =
    await import("./access-memory-search-fanout.js");
  const results = await runScopedMemorySearch({
    query: "q",
    budget: 2,
    sendInitialLimit: true,
    authorizeScope: () => {},
    namespacesEnabled: false,
    isExcluded: (memoryPath) => memoryPath.startsWith("artifacts/"),
    filterPrivate: async (hits) => hits,
    flatCorpus: async (limit) => {
      seen.push(limit);
      return corpus.slice(0, limit);
    },
    namespaced: async () => [],
  });
  assert.deepEqual(
    seen,
    [2, 4, 8, 16, 32, 64],
    "doubles past four rounds until the budget is met",
  );
  assert.deepEqual(
    results.map((hit) => hit.path),
    ["facts/one.md", "facts/two.md"],
  );
});

test("HTTP memory search stops at the candidate ceiling", async () => {
  // A backend that always returns a full page of excluded hits must not be
  // asked for an unbounded number of candidates.
  const seen: Array<number | undefined> = [];
  const { runScopedMemorySearch } =
    await import("./access-memory-search-fanout.js");
  const results = await runScopedMemorySearch({
    query: "q",
    budget: 1,
    sendInitialLimit: true,
    authorizeScope: () => {},
    namespacesEnabled: false,
    isExcluded: () => true,
    filterPrivate: async (hits) => hits,
    flatCorpus: async (limit) => {
      seen.push(limit);
      return Array.from({ length: limit ?? 0 }, (_, index) => ({
        path: `artifacts/a${index}.md`,
        score: 0.5,
        snippet: "artifact",
      }));
    },
    namespaced: async () => [],
  });
  assert.deepEqual(results, []);
  // The cap is ABSOLUTE, not a multiple of the budget: a small request whose
  // hits are all excluded still walks far enough to prove the corpus holds
  // nothing for it, then stops on the backend-safety bound.
  assert.equal(
    seen.at(-1),
    25_000,
    "the last request lands exactly on the cap",
  );
  assert.ok(seen.length < 20, "and the loop terminates");
});

test("HTTP memory search scales its ceiling above a large requested budget", async () => {
  // A fixed 1000 ceiling would stop at or below a 2000-result request, so one
  // excluded hit in the first page could never be replaced.
  const seen: Array<number | undefined> = [];
  const { runScopedMemorySearch } =
    await import("./access-memory-search-fanout.js");
  const results = await runScopedMemorySearch({
    query: "q",
    budget: 2_000,
    sendInitialLimit: true,
    authorizeScope: () => {},
    namespacesEnabled: false,
    isExcluded: (memoryPath) => memoryPath === "artifacts/a.md",
    filterPrivate: async (hits) => hits,
    flatCorpus: async (limit) => {
      seen.push(limit);
      const size = limit ?? 0;
      return [
        { path: "artifacts/a.md", score: 1, snippet: "artifact" },
        ...Array.from({ length: size - 1 }, (_, index) => ({
          path: `facts/f${index}.md`,
          score: 0.5,
          snippet: "fact",
        })),
      ];
    },
    namespaced: async () => [],
  });
  assert.deepEqual(seen, [2_000, 4_000], "tops up past the requested budget");
  assert.equal(
    results.length,
    2_000,
    "the requested page is delivered in full",
  );
});

test("HTTP memory search keeps the backend page size when no limit is named", async () => {
  // The backend's default page (6) is smaller than the configured cap (8).
  // Treating the cap as the target made a FULL page look short and reissued
  // the query, returning 8 where the same request used to return 6.
  const seen: Array<number | undefined> = [];
  const { runScopedMemorySearch } =
    await import("./access-memory-search-fanout.js");
  const results = await runScopedMemorySearch({
    query: "q",
    budget: 8,
    sendInitialLimit: false,
    authorizeScope: () => {},
    namespacesEnabled: false,
    isExcluded: () => false,
    filterPrivate: async (hits) => hits,
    flatCorpus: async (limit) => {
      seen.push(limit);
      const size = limit ?? 6;
      return Array.from({ length: size }, (_, index) => ({
        path: `facts/f${index}.md`,
        score: 0.5,
        snippet: "fact",
      }));
    },
    namespaced: async () => [],
  });
  assert.deepEqual(seen, [undefined], "one request, no spurious top-up");
  assert.equal(results.length, 6, "the backend's own page is returned intact");
});

test("HTTP memory search still tops up a thinned default page", async () => {
  // Same shape, but an excluded hit really does shorten the page: the target
  // is the backend page size, so it tops up to restore it.
  const seen: Array<number | undefined> = [];
  const { runScopedMemorySearch } =
    await import("./access-memory-search-fanout.js");
  const results = await runScopedMemorySearch({
    query: "q",
    budget: 8,
    sendInitialLimit: false,
    authorizeScope: () => {},
    namespacesEnabled: false,
    isExcluded: (memoryPath) => memoryPath.startsWith("artifacts/"),
    filterPrivate: async (hits) => hits,
    flatCorpus: async (limit) => {
      seen.push(limit);
      const size = limit ?? 6;
      return [
        { path: "artifacts/a.md", score: 1, snippet: "artifact" },
        ...Array.from({ length: size - 1 }, (_, index) => ({
          path: `facts/f${index}.md`,
          score: 0.5,
          snippet: "fact",
        })),
      ];
    },
    namespaced: async () => [],
  });
  assert.deepEqual(
    seen,
    [undefined, 12],
    "tops up against the backend page size",
  );
  assert.equal(results.length, 6);
});

test("search keeps archived memories but still excludes the dedicated surfaces", async () => {
  // The lifecycle reserves archived memories for explicit read/search
  // surfaces, so a ranked search must return them - while artifacts, activity
  // digests, and meeting records stay on their own paths.
  const { isSearchExcludedPath, isGenericRecallExcludedPath } =
    await import("./orchestration/generic-recall-paths.js");
  assert.equal(
    isSearchExcludedPath("archive/2026-01/fact-1.md"),
    false,
    "archived memories remain findable through search",
  );
  assert.equal(
    isGenericRecallExcludedPath("archive/2026-01/fact-1.md"),
    true,
    "but recall injection still skips them",
  );
  // Artifacts flow only through the dedicated verbatim path, in BOTH modes.
  assert.equal(isSearchExcludedPath("artifacts/report.md"), true);
  assert.equal(isGenericRecallExcludedPath("artifacts/report.md"), true);
  // And the wiring uses the search predicate, so an archived hit survives.
  const { runScopedMemorySearch } =
    await import("./access-memory-search-fanout.js");
  const results = await runScopedMemorySearch({
    query: "q",
    budget: 5,
    sendInitialLimit: true,
    authorizeScope: () => {},
    namespacesEnabled: false,
    isExcluded: (memoryPath) => isSearchExcludedPath(memoryPath),
    filterPrivate: async (hits) => hits,
    flatCorpus: async () => [
      { path: "archive/2026-01/fact-1.md", score: 0.9, snippet: "archived" },
      { path: "artifacts/report.md", score: 0.8, snippet: "artifact" },
    ],
    namespaced: async () => [],
  });
  assert.deepEqual(
    results.map((hit) => hit.path),
    ["archive/2026-01/fact-1.md"],
  );
});

test("a collection-qualified QMD path still hits the dedicated-surface exclusions", async () => {
  const { isSearchExcludedPath } =
    await import("./orchestration/generic-recall-paths.js");
  // A flat-corpus QMD transport returns `qmd://<collection>/<path>` or
  // `<collection>/<path>`. The activity predicate is root-aware, so an
  // un-stripped prefix reads as a NESTED path and the digest leaks into
  // ranked search.
  const policy = { memoryDir: "/memory", qmdCollection: "memories" };

  for (const excluded of [
    "qmd://memories/activity/2026-08-02.md",
    "memories/activity/2026-08-02.md",
    "qmd://memories/artifacts/report.md",
    "memories/meetings/2026-01-01/mtg-2026-01-01-abcdef12.md",
  ]) {
    assert.equal(isSearchExcludedPath(excluded, policy, "qmd"), true, excluded);
  }
  // A namespaced search rewrites hits to absolute paths beneath the
  // namespace's own storage root; the digest there must be excluded too.
  assert.equal(
    isSearchExcludedPath(
      "/memory/namespaces/team/activity/2026-08-02.md",
      policy,
      "qmd",
    ),
    true,
    "a digest under a namespace root is still a digest",
  );
  assert.equal(
    isSearchExcludedPath(
      "/memory/namespaces/team/facts/proj/activity/2026-08-02.md",
      policy,
      "qmd",
    ),
    false,
    "and an ordinary nested memory under that root stays searchable",
  );
  // A collection whose NAME is also a memory category is disambiguated two
  // ways: a `qmd://` URI states it in the authority, and a bare path is
  // resolved against the collection the caller actually requested.
  assert.equal(
    isSearchExcludedPath("qmd://facts/activity/2026-08-02.md", policy, "qmd"),
    true,
    "the URI authority is unambiguously the collection",
  );
  assert.equal(
    isSearchExcludedPath(
      "facts/activity/2026-08-02.md",
      { ...policy, requestedCollection: "facts" },
      "qmd",
    ),
    true,
    "the caller named `facts` as its collection",
  );
  assert.equal(
    isSearchExcludedPath("facts/activity/2026-08-02.md", policy, "qmd"),
    false,
    "without that, `facts` stays a memory category and the memory is searchable",
  );
  // A collection this policy does NOT know — a caller-named custom one, or
  // any collection global search spans — is covered too.
  for (const excluded of [
    "custom/activity/2026-08-02.md",
    "qmd://custom/activity/2026-08-02.md",
    "custom/artifacts/report.md",
  ]) {
    assert.equal(isSearchExcludedPath(excluded, policy, "qmd"), true, excluded);
  }
  // A nested ordinary memory that merely looks like a digest stays searchable,
  // including under a custom collection, and so does an archived one. A
  // leading segment naming a memory CATEGORY is never read as a collection.
  for (const kept of [
    "qmd://memories/facts/proj/activity/2026-08-02.md",
    "custom/facts/proj/activity/2026-08-02.md",
    // The configured collection is stripped ONCE. Removing `projects` too
    // would leave `activity/<date>.md` and hide an ordinary nested memory
    // from search and recall alike.
    "memories/projects/activity/2026-08-02.md",
    "qmd://memories/projects/activity/2026-08-02.md",
    "facts/activity/2026-08-02.md",
    "memories/archive/2026-01/fact-1.md",
  ]) {
    assert.equal(isSearchExcludedPath(kept, policy, "qmd"), false, kept);
  }
});

test("search keeps paging while the backend page is full of excluded hits", async () => {
  // A budget-proportional ceiling made "the excluded paths rank first"
  // indistinguishable from "there is nothing else": a 1,000-row request whose
  // first 4,000 hits are artifacts stopped at 4,000 and answered empty while
  // valid memories sat at rank 4,001.
  const { searchWithGenericExclusion } =
    await import("./access-memory-search-fanout.js");
  const corpus = [
    ...Array.from({ length: 4_000 }, (_, index) => ({
      path: `artifacts/a-${index}.md`,
    })),
    ...Array.from({ length: 50 }, (_, index) => ({
      path: `facts/f-${index}.md`,
    })),
  ];
  const limits: Array<number | undefined> = [];
  const results = await searchWithGenericExclusion({
    budget: 1_000,
    sendInitialLimit: true,
    search: async (limit) => {
      limits.push(limit);
      return corpus.slice(0, limit ?? corpus.length);
    },
    filterPrivate: async (hits) => hits,
    isExcluded: (memoryPath) => memoryPath.startsWith("artifacts/"),
  });
  assert.equal(
    results.length,
    50,
    "the memories behind the excluded block are returned",
  );
  assert.ok(
    limits.length > 1,
    "and it took more than the first page to reach them",
  );
  assert.ok(
    limits.every((limit) => (limit ?? 0) <= 25_000),
    "while still respecting the absolute backend cap",
  );
});

test("search removes excluded paths before private-memory resolution", async () => {
  const { searchWithGenericExclusion } = await import("./access-memory-search-fanout.js");
  const resolved: string[] = [];
  const results = await searchWithGenericExclusion({
    budget: 1,
    sendInitialLimit: true,
    search: async () => [
      { path: "artifacts/private.md" },
      { path: "facts/visible.md" },
    ],
    filterPrivate: async (hits) => {
      resolved.push(...hits.map((hit) => hit.path));
      return hits;
    },
    isExcluded: (memoryPath) => memoryPath.startsWith("artifacts/"),
  });
  assert.deepEqual(resolved, ["facts/visible.md"]);
  assert.deepEqual(results, [{ path: "facts/visible.md" }]);
});

test("a budget above the backend cap still gets the rows it asked for", async () => {
  // The cap protects the backend from an unbounded walk; it must never sit
  // BELOW an explicit request, or a large search returns a short page for a
  // count the operation deliberately supports.
  const { searchWithGenericExclusion } =
    await import("./access-memory-search-fanout.js");
  const corpus = [
    { path: "artifacts/excluded.md" },
    ...Array.from({ length: 30_000 }, (_, index) => ({
      path: `facts/f-${index}.md`,
    })),
  ];
  const results = await searchWithGenericExclusion({
    budget: 30_000,
    sendInitialLimit: true,
    search: async (limit) => corpus.slice(0, limit ?? corpus.length),
    filterPrivate: async (hits) => hits,
    isExcluded: (memoryPath) => memoryPath.startsWith("artifacts/"),
  });
  assert.equal(
    results.length,
    30_000,
    "the excluded hit was replaced, not subtracted",
  );
});
