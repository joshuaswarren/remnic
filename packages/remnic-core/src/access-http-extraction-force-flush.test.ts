import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import type {
  EngramAccessExtractionForceFlushRequest,
  EngramAccessLcmCompactionFlushRequest,
  EngramAccessService,
} from "./access-service.js";

test("HTTP extraction force-flush forwards validated scope and deadline to the access service", async () => {
  const requests: EngramAccessExtractionForceFlushRequest[] = [];
  const service = {
    extractionForceFlush: async (request: EngramAccessExtractionForceFlushRequest) => {
      requests.push(request);
      return {
        flushed: true,
        sessionKey: request.sessionKey,
        namespace: request.namespace ?? "default",
        effectiveNamespace: request.namespace ?? "default",
      };
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
    const response = await fetch(`http://127.0.0.1:${status.port}/engram/v1/extraction/flush`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionKey: "pi:session-1",
        namespace: "team-project",
        cwd: "/workspace/project",
        projectTag: "Acme/Webshop",
        deadlineMs: 1_900_000_000_000,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      flushed: true,
      sessionKey: "pi:session-1",
      namespace: "team-project",
      effectiveNamespace: "team-project",
    });
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.sessionKey, "pi:session-1");
    assert.equal(request.namespace, "team-project");
    assert.equal(request.cwd, "/workspace/project");
    assert.equal(request.projectTag, "Acme/Webshop");
    assert.equal(request.deadlineMs, 1_900_000_000_000);
    assert.ok(request.abortSignal instanceof AbortSignal);

    const invalid = await fetch(`http://127.0.0.1:${status.port}/engram/v1/extraction/flush`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionKey: "pi:session-1", deadlineMs: -1 }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(requests.length, 1, "invalid requests must not reach the access service");
  } finally {
    await server.stop();
  }
});

test("HTTP lifecycle flush preserves the scoped LCM compaction route", async () => {
  const requests: EngramAccessLcmCompactionFlushRequest[] = [];
  const service = {
    lcmCompactionFlush: async (request: EngramAccessLcmCompactionFlushRequest) => {
      requests.push(request);
      return {
        enabled: true,
        flushed: true,
        sessionKey: request.sessionKey,
        namespace: request.namespace ?? "default",
      };
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
    const response = await fetch(`http://127.0.0.1:${status.port}/remnic/v1/lcm/compaction/flush`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionKey: "pi:session-1",
        namespace: "team-project",
        cwd: "/workspace/project",
        projectTag: "Acme/Webshop",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      enabled: true,
      flushed: true,
      sessionKey: "pi:session-1",
      namespace: "team-project",
    });
    assert.deepEqual(requests, [{
      sessionKey: "pi:session-1",
      namespace: "team-project",
      cwd: "/workspace/project",
      projectTag: "Acme/Webshop",
      authenticatedPrincipal: undefined,
    }]);
  } finally {
    await server.stop();
  }
});
